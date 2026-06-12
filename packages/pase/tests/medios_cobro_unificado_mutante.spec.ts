import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: catálogo único de medios de cobro (Tier 1 #3).
// Migraciones 202606122000 (schema+backfill+merge+RLS+view legacy) y
// 202606122010 (fn_proyectar_venta_pos v2 con traducción slug→nombre):
//
//   1. AISLAMIENTO + VIEW: el dueño (tenant Neko) lee `medios_cobro` SIN
//      filtro de tenant → la RLS tenant-scoped devuelve solo filas de su
//      tenant, todas con deleted_at NULL. La view de compatibilidad
//      `metodos_cobro` (security_invoker) devuelve el MISMO count.
//      Se resuelve la fila slug='efectivo' (scope global o Local Prueba 2,
//      misma precedencia que la función: local_id NULLS LAST) y se guarda
//      su NOMBRE real — no se asume 'EFECTIVO' hardcodeado.
//
//   2. TRADUCCIÓN SLUG→NOMBRE EN EL PUENTE: venta_pos cobrada con UN pago
//      metodo='efectivo' (el SLUG que guarda el POS) → la fila proyectada
//      en `ventas` (origen='comanda') lleva medio = NOMBRE del catálogo
//      (no el slug crudo), y el detalle de ventas_pos_proyecciones también
//      guarda el nombre YA traducido. Anular (fn_anular_venta_comanda con
//      manager) → el reverso descuenta contra el nombre traducido y la
//      fila del día queda limpia (si apuntara al slug, quedaría huérfana).
//
//   3. FALLBACK METODO DESCONOCIDO: venta cobrada con un metodo que no
//      existe en el catálogo → proyecta con el texto crudo (no rompe).
//      Anular → limpia igual.
//
// DB-only contra prod (Local Prueba 2), misma mecánica que
// puente_ventas_comanda_mutante.spec.ts. Cleanup en afterEach, cada paso
// en su propio try/catch. NO toca el catálogo medios_cobro.
// ─────────────────────────────────────────────────────────────────────────

const LOCAL = "Local Prueba 2";

// Sentinels (montos raros para que un leftover sea trivial de detectar a ojo)
const PAGO_SLUG_EFECTIVO = 3333.33;
const PAGO_DESCONOCIDO = 444.44;

const SLUG_EFECTIVO = "efectivo";
const METODO_DESCONOCIDO = "metodo_inexistente_xyz";

// Sufijo único por corrida para idempotency keys
const RUN = `medios-unif-${Date.now()}`;
function idem(label: string): string {
  return `${RUN}-${label}`;
}

// Misma regla que fn_proyectar_venta_pos: día calendario y turno en hora
// Argentina (UTC-3 fijo). <17:00 = Mediodía, si no Noche.
function fechaTurnoAR(cobradaAtIso: string): { fecha: string; turno: string } {
  const utc = new Date(cobradaAtIso);
  const ar = new Date(utc.getTime() - 3 * 3600 * 1000);
  const fecha = ar.toISOString().slice(0, 10);
  const turno = ar.getUTCHours() < 17 ? "Mediodía" : "Noche";
  return { fecha, turno };
}

function fix2(x: unknown): string {
  return Number(x).toFixed(2);
}

test.describe("Catálogo único medios_cobro + traducción slug→nombre — mutante", () => {
  // Llamadas de red contra prod superan el timeout default de 30s.
  test.setTimeout(120_000);

  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;
  let cajeroId: string;
  let managerId: string | null = null;
  let turnoAbiertoPorTest = false;
  let turnoId: number | null = null;

  // ventas_pos creadas por este test, para cleanup
  let createdVentaIds: number[] = [];

  // Resuelve la fila slug='efectivo' del catálogo con la MISMA precedencia
  // que fn_proyectar_venta_pos (override por local gana, si no la global).
  async function resolverNombreEfectivo(): Promise<string> {
    const { data, error } = await db
      .from("medios_cobro")
      .select("nombre, local_id, slug")
      .eq("slug", SLUG_EFECTIVO)
      .or(`local_id.is.null,local_id.eq.${localId}`)
      .is("deleted_at", null);
    if (error) throw new Error(`Query medios_cobro slug=efectivo: ${error.message}`);
    if (!data || data.length === 0) {
      throw new Error(
        `No existe fila slug='efectivo' en medios_cobro (scope global o local ${localId}) — ¿corrió la migración 202606122000?`,
      );
    }
    // ORDER BY local_id NULLS LAST → el override del local pisa al global.
    const sorted = [...data].sort((a, b) => {
      if (a.local_id === null && b.local_id !== null) return 1;
      if (a.local_id !== null && b.local_id === null) return -1;
      return 0;
    });
    return sorted[0]!.nombre as string;
  }

  // Anula una venta por el camino real del repo (fn_anular_venta_comanda con
  // manager TOTP-rol). Si el local no tiene manager POS, fallback documentado:
  // UPDATE directo estado='anulada' — el trigger es AFTER UPDATE OF estado y
  // dispara igual.
  async function anularVenta(ventaId: number, label: string): Promise<void> {
    if (managerId) {
      const { error } = await db.rpc("fn_anular_venta_comanda", {
        p_venta_id: ventaId,
        p_manager_id: managerId,
        p_motivo: `mutante medios unificado: ${label}`,
        p_idempotency_key: idem(`anular-${label}`),
      });
      if (error) throw new Error(`fn_anular_venta_comanda(${ventaId}): ${error.message}`);
    } else {
      const { error } = await db
        .from("ventas_pos")
        .update({ estado: "anulada", anulada_at: new Date().toISOString() })
        .eq("id", ventaId);
      if (error) throw new Error(`UPDATE estado=anulada (${ventaId}): ${error.message}`);
    }
  }

  // Crea una venta_pos con un item al precio exacto y la cobra con UN pago
  // del metodo indicado. Devuelve el id y el día/turno AR del cobro.
  async function crearYCobrarVenta(
    metodo: string,
    monto: number,
    label: string,
  ): Promise<{ ventaId: number; fecha: string; turno: string }> {
    const { data: vRaw, error: eAbrir } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: crypto.randomUUID(),
    });
    if (eAbrir) throw new Error(`fn_abrir_venta_comanda_offline ${label}: ${eAbrir.message}`);
    const ventaId = Number(vRaw);
    expect(ventaId).toBeGreaterThan(0);
    createdVentaIds.push(ventaId);

    const { error: eItem } = await db.rpc("fn_agregar_item_comanda_offline", {
      p_venta_id: ventaId,
      p_venta_idempotency_uuid: null,
      p_item_id: itemId,
      p_cantidad: 1,
      p_precio_unitario: monto,
      p_idempotency_uuid: crypto.randomUUID(),
    });
    if (eItem) throw new Error(`fn_agregar_item_comanda_offline ${label}: ${eItem.message}`);

    const { error: eCobro } = await db.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [
        {
          metodo,
          monto,
          idempotency_key: idem(`${label}-pago`),
        },
      ],
      p_propina: 0,
      p_cobrado_por: cajeroId,
      p_idempotency_key: idem(`${label}-cobro`),
    });
    if (eCobro) throw new Error(`fn_cobrar_venta_comanda ${label}: ${eCobro.message}`);

    const { data: vRow } = await db
      .from("ventas_pos")
      .select("estado, cobrada_at")
      .eq("id", ventaId)
      .single();
    expect(vRow?.estado).toBe("cobrada");
    expect(vRow?.cobrada_at).not.toBeNull();
    const { fecha, turno } = fechaTurnoAR(vRow!.cobrada_at as string);
    return { ventaId, fecha, turno };
  }

  // Filas de `ventas` proyectadas del día/turno para el local de prueba.
  async function ventasComandaDelDia(fecha: string, turno: string) {
    const { data, error } = await db
      .from("ventas")
      .select("id, medio, monto, turno, fecha")
      .eq("local_id", localId)
      .eq("origen", "comanda")
      .eq("fecha", fecha)
      .eq("turno", turno);
    if (error) throw new Error(`Query ventas origen=comanda: ${error.message}`);
    return data ?? [];
  }

  test.beforeEach(async () => {
    db = await createDuenoClient();
    createdVentaIds = [];
    managerId = null;
    turnoAbiertoPorTest = false;
    turnoId = null;

    // ── Local Prueba 2 (falla ruidosamente si no existe o hay duplicados) ──
    const { data: locales, error: locErr } = await db
      .from("locales")
      .select("id, tenant_id")
      .eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales "${LOCAL}" — desambiguar`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    // ── Canal mostrador (seed estándar del tenant) ──
    const { data: canales } = await db
      .from("canales")
      .select("id")
      .eq("slug", "mostrador")
      .eq("tenant_id", tenantId)
      .limit(1);
    if (!canales || canales.length === 0) {
      throw new Error(
        `Falta canal slug='mostrador' para tenant ${tenantId}. Crear con:\n` +
          `INSERT INTO canales (tenant_id, slug, nombre) VALUES ('${tenantId}', 'mostrador', 'Mostrador');`,
      );
    }
    canalId = canales[0]!.id as number;

    // ── Un item cualquiera del tenant (el precio lo fija el test vía RPC offline) ──
    const { data: items } = await db
      .from("items")
      .select("id")
      .eq("tenant_id", tenantId)
      .limit(1);
    if (!items || items.length === 0) {
      throw new Error(`Falta al menos un item para tenant ${tenantId} (crear desde Catálogo).`);
    }
    itemId = items[0]!.id as number;

    // ── Cajero POS activo (lo exige abrir turno) ──
    const { data: cajeros } = await db
      .from("rrhh_empleados")
      .select("id")
      .eq("local_id", localId)
      .eq("pos_activo", true)
      .limit(1);
    if (!cajeros || cajeros.length === 0) {
      throw new Error(`Sin empleado POS activo (pos_activo=true) en "${LOCAL}" — asignar PIN POS desde RRHH.`);
    }
    cajeroId = cajeros[0]!.id as string;

    // ── Manager POS para fn_anular_venta_comanda (si no hay, fallback UPDATE) ──
    const { data: mgrs } = await db
      .from("rrhh_empleados")
      .select("id")
      .eq("local_id", localId)
      .in("rol_pos", ["manager", "dueno"])
      .eq("pos_activo", true)
      .limit(1);
    managerId = mgrs && mgrs.length > 0 ? (mgrs[0]!.id as string) : null;

    // ── Turno de caja: reusar el abierto si hay; si no, abrir uno ──
    const { data: turnoExist } = await db
      .from("turnos_caja")
      .select("id")
      .eq("local_id", localId)
      .eq("estado", "abierto")
      .order("id", { ascending: false })
      .limit(1);
    if (turnoExist && turnoExist.length > 0) {
      turnoId = turnoExist[0]!.id as number;
    } else {
      const { data: t, error: te } = await db.rpc("fn_abrir_turno_caja_comanda", {
        p_local_id: localId,
        p_cajero_id: cajeroId,
        p_monto_inicial: 0,
        p_notas: "mutante medios unificado",
        p_idempotency_key: idem("turno"),
      });
      if (te) throw new Error(`fn_abrir_turno_caja_comanda: ${te.message}`);
      turnoId = Number(t);
      turnoAbiertoPorTest = true;
    }

    // ── Pre-clean: Local Prueba 2 es de prueba — arrancar sin residuo de
    //    proyecciones previas (otra corrida interrumpida dejaría filas
    //    origen='comanda' que romperían los asserts de montos exactos). ──
    const { data: preProy } = await db
      .from("ventas_pos_proyecciones")
      .select("venta_id")
      .eq("local_id", localId);
    if (preProy && preProy.length > 0) {
      console.warn(`[pre-clean] ${preProy.length} proyecciones residuales en local ${localId} — borrando`);
      await db.from("ventas_pos_proyecciones").delete().eq("local_id", localId);
    }
    const { data: preVentas } = await db
      .from("ventas")
      .select("id")
      .eq("local_id", localId)
      .eq("origen", "comanda");
    if (preVentas && preVentas.length > 0) {
      console.warn(`[pre-clean] ${preVentas.length} filas ventas origen=comanda residuales en local ${localId} — borrando`);
      await db.from("ventas").delete().eq("local_id", localId).eq("origen", "comanda");
    }
  });

  test.afterEach(async () => {
    // Cada paso en su propio try/catch — un fallo no aborta el resto.
    // NO se toca el catálogo medios_cobro (el test solo lo lee).
    for (const vid of createdVentaIds) {
      // 1) Si quedó cobrada, anularla primero → el trigger revierte la
      //    proyección en `ventas` antes de tocar nada más.
      try {
        const { data: vRow } = await db
          .from("ventas_pos")
          .select("estado, deleted_at")
          .eq("id", vid)
          .maybeSingle();
        if (vRow && !vRow.deleted_at && vRow.estado === "cobrada") {
          await anularVenta(vid, `cleanup-${vid}`);
        }
      } catch (e) {
        console.error(`[cleanup] anular venta ${vid}:`, e);
      }
      // 2) Soft-delete de items/pagos + borrar movimientos_caja del turno.
      const now = new Date().toISOString();
      try {
        await db.from("ventas_pos_items").update({ deleted_at: now }).eq("venta_id", vid);
      } catch (e) {
        console.error(`[cleanup] items venta ${vid}:`, e);
      }
      try {
        await db.from("ventas_pos_pagos").update({ deleted_at: now }).eq("venta_id", vid);
      } catch (e) {
        console.error(`[cleanup] pagos venta ${vid}:`, e);
      }
      try {
        await db.from("movimientos_caja").delete().eq("venta_id", vid);
      } catch (e) {
        console.error(`[cleanup] movimientos_caja venta ${vid}:`, e);
      }
      try {
        await db
          .from("ventas_pos")
          .update({ deleted_at: now, estado: "anulada" })
          .eq("id", vid);
      } catch (e) {
        console.error(`[cleanup] soft-delete venta ${vid}:`, e);
      }
      // 3) Proyección remanente de esta venta (defensivo).
      try {
        await db.from("ventas_pos_proyecciones").delete().eq("venta_id", vid);
      } catch (e) {
        console.error(`[cleanup] proyeccion venta ${vid}:`, e);
      }
    }

    // 4) Filas `ventas` origen='comanda' remanentes del local de prueba.
    try {
      const { data: rem } = await db
        .from("ventas")
        .select("id")
        .eq("local_id", localId)
        .eq("origen", "comanda");
      if (rem && rem.length > 0) {
        console.warn(`[cleanup] ${rem.length} filas ventas origen=comanda remanentes — borrando`);
        await db.from("ventas").delete().eq("local_id", localId).eq("origen", "comanda");
      }
    } catch (e) {
      console.error("[cleanup] ventas remanentes:", e);
    }

    // 5) Overrides de auditoría creados por las anulaciones de este run.
    try {
      await db.from("ventas_pos_overrides").delete().like("idempotency_key", `${RUN}%`);
    } catch (e) {
      console.error("[cleanup] overrides:", e);
    }

    // 6) Cerrar el turno SOLO si lo abrió este test (con la RPC real — la
    //    RLS de turnos_caja_history bloquea UPDATE directo).
    if (turnoAbiertoPorTest && turnoId) {
      try {
        const { error } = await db.rpc("fn_cerrar_turno_caja_comanda", {
          p_turno_id: turnoId,
          p_cerrado_por: cajeroId,
          p_monto_final_declarado: 0,
          p_notas: "cierre mutante medios unificado",
          p_idempotency_key: idem("cierre-turno"),
        });
        if (error) console.error(`[cleanup] cerrar turno ${turnoId}: ${error.message}`);
      } catch (e) {
        console.error(`[cleanup] cerrar turno ${turnoId}:`, e);
      }
    }

    try {
      await db.auth.signOut();
    } catch {
      /* idempotente */
    }
  });

  test("MUTANTE: medios_cobro aislado por tenant y view metodos_cobro devuelve lo mismo", async () => {
    // ── Tabla base SIN filtro de tenant: la RLS hace el scope sola ──
    const { data: filas, error } = await db
      .from("medios_cobro")
      .select("id, tenant_id, deleted_at, nombre, slug, local_id");
    expect(error).toBeNull();
    expect(filas, "El catálogo medios_cobro del tenant no puede estar vacío").not.toBeNull();
    expect(filas!.length).toBeGreaterThan(0);
    for (const f of filas!) {
      expect(
        f.tenant_id,
        `Fila ${f.id} (${f.nombre}) con tenant ajeno ${f.tenant_id} — leak multi-tenant`,
      ).toBe(tenantId);
      expect(f.deleted_at, `Fila ${f.id} (${f.nombre}) borrada visible vía RLS`).toBeNull();
    }

    // ── View de compatibilidad: MISMO count que la tabla base ──
    const { count: countView, error: eView } = await db
      .from("metodos_cobro")
      .select("id", { count: "exact", head: true });
    expect(eView).toBeNull();
    expect(
      countView,
      `view metodos_cobro devolvió ${countView} filas vs ${filas!.length} de medios_cobro`,
    ).toBe(filas!.length);

    // ── Fila slug='efectivo' existe y tiene nombre resoluble ──
    const nombreEfectivo = await resolverNombreEfectivo();
    console.log(`[mutante] slug='efectivo' → nombre del catálogo: "${nombreEfectivo}"`);
    expect(nombreEfectivo.length).toBeGreaterThan(0);
  });

  test("MUTANTE: el puente traduce slug→nombre al proyectar y el fallback no rompe", async () => {
    const nombreEfectivo = await resolverNombreEfectivo();
    console.log(`[mutante] slug='efectivo' → nombre del catálogo: "${nombreEfectivo}"`);

    // ════ 1. VENTA cobrada con metodo = SLUG 'efectivo' ════
    const v1 = await crearYCobrarVenta(SLUG_EFECTIVO, PAGO_SLUG_EFECTIVO, "v-slug");

    // ── (a) fila `ventas` con el NOMBRE del catálogo, no el slug crudo ──
    const filas1 = await ventasComandaDelDia(v1.fecha, v1.turno);
    expect(filas1, `Esperaba 1 fila ventas origen=comanda, hay: ${JSON.stringify(filas1)}`).toHaveLength(1);
    expect(
      filas1[0]!.medio,
      `El puente debía traducir slug '${SLUG_EFECTIVO}' → nombre '${nombreEfectivo}'`,
    ).toBe(nombreEfectivo);
    if (nombreEfectivo !== SLUG_EFECTIVO) {
      // Guard explícito: NO quedó una fila con el slug crudo.
      expect(filas1.find((f) => f.medio === SLUG_EFECTIVO)).toBeUndefined();
    }
    expect(fix2(filas1[0]!.monto)).toBe(fix2(PAGO_SLUG_EFECTIVO));

    // ── (b) el detalle de la proyección guarda el nombre YA traducido ──
    const { data: proy1 } = await db
      .from("ventas_pos_proyecciones")
      .select("detalle")
      .eq("venta_id", v1.ventaId)
      .maybeSingle();
    expect(proy1, `No hay fila en ventas_pos_proyecciones para venta ${v1.ventaId}`).not.toBeNull();
    const detalle1 = proy1!.detalle as { medio: string; monto: number }[];
    expect(detalle1).toHaveLength(1);
    expect(
      detalle1[0]!.medio,
      `El detalle debía guardar el nombre traducido (reverso depende de esto): ${JSON.stringify(detalle1)}`,
    ).toBe(nombreEfectivo);
    expect(fix2(detalle1[0]!.monto)).toBe(fix2(PAGO_SLUG_EFECTIVO));

    // ── (c) anular → el reverso descuenta contra el nombre traducido y limpia ──
    await anularVenta(v1.ventaId, "v-slug");
    const filas1Post = await ventasComandaDelDia(v1.fecha, v1.turno);
    expect(
      filas1Post,
      `El reverso debía limpiar la fila del día (apunta al nombre traducido), quedó: ${JSON.stringify(filas1Post)}`,
    ).toHaveLength(0);
    const { data: proy1Post } = await db
      .from("ventas_pos_proyecciones")
      .select("venta_id")
      .eq("venta_id", v1.ventaId)
      .maybeSingle();
    expect(proy1Post, "La proyección de la venta anulada debía borrarse").toBeNull();

    // ════ 2. VENTA cobrada con metodo DESCONOCIDO → fallback texto crudo ════
    const v2 = await crearYCobrarVenta(METODO_DESCONOCIDO, PAGO_DESCONOCIDO, "v-fallback");

    const filas2 = await ventasComandaDelDia(v2.fecha, v2.turno);
    expect(filas2, `Esperaba 1 fila ventas origen=comanda, hay: ${JSON.stringify(filas2)}`).toHaveLength(1);
    expect(
      filas2[0]!.medio,
      "Metodo fuera del catálogo debía proyectar con el texto crudo (fallback)",
    ).toBe(METODO_DESCONOCIDO);
    expect(fix2(filas2[0]!.monto)).toBe(fix2(PAGO_DESCONOCIDO));

    const { data: proy2 } = await db
      .from("ventas_pos_proyecciones")
      .select("detalle")
      .eq("venta_id", v2.ventaId)
      .maybeSingle();
    expect(proy2).not.toBeNull();
    const detalle2 = proy2!.detalle as { medio: string; monto: number }[];
    expect(detalle2).toHaveLength(1);
    expect(detalle2[0]!.medio).toBe(METODO_DESCONOCIDO);
    expect(fix2(detalle2[0]!.monto)).toBe(fix2(PAGO_DESCONOCIDO));

    // ── anular → limpia igual ──
    await anularVenta(v2.ventaId, "v-fallback");
    const filas2Post = await ventasComandaDelDia(v2.fecha, v2.turno);
    expect(
      filas2Post,
      `El reverso del fallback debía limpiar la fila, quedó: ${JSON.stringify(filas2Post)}`,
    ).toHaveLength(0);
    const { data: proy2Post } = await db
      .from("ventas_pos_proyecciones")
      .select("venta_id")
      .eq("venta_id", v2.ventaId)
      .maybeSingle();
    expect(proy2Post).toBeNull();
  });
});
