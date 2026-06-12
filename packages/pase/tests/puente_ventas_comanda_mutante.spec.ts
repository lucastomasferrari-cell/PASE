import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: puente ventas_pos (COMANDA) → ventas (PASE).
// Migración 202606121200_puente_ventas_comanda.sql:
//   - trigger trg_venta_pos_proyectar (AFTER UPDATE OF estado en ventas_pos)
//   - al pasar a 'cobrada' → fn_proyectar_venta_pos: upsertea filas diarias
//     en `ventas` (clave tenant+local+fecha AR+turno+medio, origen='comanda',
//     monto = pagos confirmados NETO de propina_incluida) y registra el
//     detalle exacto en ventas_pos_proyecciones.
//   - al salir de 'cobrada' (anulada/reabierta) → fn_revertir_proyeccion_
//     venta_pos: descuenta lo exacto, borra filas |monto|<0.005 y el registro.
//   - NO crea movimientos en `movimientos` de PASE (el efectivo del POS vive
//     en turnos_caja de COMANDA y sube a PASE con el retiro físico).
//
// Flujo (DB-only, RPCs reales contra Local Prueba 2, mismo patrón que
// offline_first_mutante + servicio_completo_e2e de COMANDA):
//   1. Venta 1 cobrada con 2 pagos: EFECTIVO 4321.17 (propina_incluida 200)
//      + TARJETA 1111.11 → proyección con detalle de 2 medios, fila ventas
//      EFECTIVO=4121.17 y TARJETA=1111.11, CERO movimientos PASE nuevos.
//   2. Venta 2 mismo día EFECTIVO 1000 → fila EFECTIVO=5121.17 y sigue
//      siendo UNA sola fila (upsert agregó, no duplicó).
//   3. Anular venta 2 (fn_anular_venta_comanda con manager) → EFECTIVO
//      vuelve a 4121.17, proyección de venta 2 borrada.
//   4. Anular venta 1 → filas del día eliminadas (quedaron en 0) y sin
//      proyecciones.
//
// El día/turno esperado NO se hardcodea: se calcula desde cobrada_at con la
// misma regla que la función (hora AR <17:00 = 'Mediodía', si no 'Noche';
// AR es UTC-3 fijo, sin DST).
//
// Cleanup en afterEach, cada paso en su propio try/catch.
// ─────────────────────────────────────────────────────────────────────────

const LOCAL = "Local Prueba 2";

// Sentinels (montos raros para que un leftover sea trivial de detectar a ojo)
const PAGO_EFECTIVO = 4321.17;
const PROPINA = 200.0;
const PAGO_TARJETA = 1111.11;
const NETO_EFECTIVO = 4121.17; // PAGO_EFECTIVO - PROPINA
const PRECIO_V1 = 5232.28; // subtotal venta 1: pagos (5432.28) = subtotal + p_propina (200)
const PRECIO_V2 = 1000.0; // venta 2: EFECTIVO 1000 sin propina
const EFECTIVO_ACUMULADO = 5121.17; // 4121.17 + 1000

const MEDIO_EFECTIVO = "EFECTIVO";
const MEDIO_TARJETA = "TARJETA";

// Sufijo único por corrida para idempotency keys
const RUN = `puente-${Date.now()}`;
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

test.describe("Puente ventas_pos → ventas (proyección comanda) — mutante", () => {
  // Las ~30 llamadas de red contra prod superan el timeout default de 30s.
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

  // Anula una venta por el camino real del repo (fn_anular_venta_comanda con
  // manager TOTP-rol). Si el local no tiene manager POS, fallback documentado:
  // UPDATE directo estado='anulada' — el trigger es AFTER UPDATE OF estado y
  // dispara igual.
  async function anularVenta(ventaId: number, label: string): Promise<void> {
    if (managerId) {
      const { error } = await db.rpc("fn_anular_venta_comanda", {
        p_venta_id: ventaId,
        p_manager_id: managerId,
        p_motivo: `mutante puente: ${label}`,
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

  async function contarMovimientosPase(): Promise<number> {
    const { count, error } = await db
      .from("movimientos")
      .select("id", { count: "exact", head: true })
      .eq("local_id", localId);
    if (error) throw new Error(`Count movimientos: ${error.message}`);
    return count ?? 0;
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

    // ── Un item cualquiera del tenant (el precio lo fija el test vía RPC
    //    offline; items.activo ya no existe post-refactor catálogo 07-jun) ──
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
        p_notas: "mutante puente ventas comanda",
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
      // 2) Soft-delete de items/pagos + borrar movimientos_caja del turno
      //    (mismo patrón que servicio_completo_e2e de COMANDA).
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
      // 3) Proyección remanente de esta venta (no debería quedar — el reverso
      //    la borra; defensivo por si el test murió a mitad).
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
          p_notas: "cierre mutante puente",
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

  test("MUTANTE: cobrar proyecta neto por medio, upsertea el día y el reverso limpia exacto", async () => {
    // ════ 1. VENTA 1 — cobrada con 2 pagos (EFECTIVO c/propina + TARJETA) ════
    const uuid1 = crypto.randomUUID();
    const { data: v1Raw, error: e1 } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: uuid1,
    });
    if (e1) throw new Error(`fn_abrir_venta_comanda_offline v1: ${e1.message}`);
    const venta1 = Number(v1Raw);
    expect(venta1).toBeGreaterThan(0);
    createdVentaIds.push(venta1);

    // Item con precio exacto (la RPC offline acepta p_precio_unitario —
    // la online lo toma de items.precio_madre y no serviría para sentinels).
    const { error: eItem1 } = await db.rpc("fn_agregar_item_comanda_offline", {
      p_venta_id: venta1,
      p_venta_idempotency_uuid: null,
      p_item_id: itemId,
      p_cantidad: 1,
      p_precio_unitario: PRECIO_V1,
      p_idempotency_uuid: crypto.randomUUID(),
    });
    if (eItem1) throw new Error(`fn_agregar_item_comanda_offline v1: ${eItem1.message}`);

    // Snapshot de movimientos PASE ANTES del cobro — el puente NO toca caja.
    const movsAntes = await contarMovimientosPase();

    // Cobro: total = subtotal (5232.28) + p_propina (200) = 5432.28
    //       = EFECTIVO 4321.17 (propina_incluida 200) + TARJETA 1111.11
    const { error: eCobro1 } = await db.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: venta1,
      p_pagos: [
        {
          metodo: MEDIO_EFECTIVO,
          monto: PAGO_EFECTIVO,
          propina_incluida: PROPINA,
          idempotency_key: idem("v1-pago-efectivo"),
        },
        {
          metodo: MEDIO_TARJETA,
          monto: PAGO_TARJETA,
          idempotency_key: idem("v1-pago-tarjeta"),
        },
      ],
      p_propina: PROPINA,
      p_cobrado_por: cajeroId,
      p_idempotency_key: idem("v1-cobro"),
    });
    if (eCobro1) throw new Error(`fn_cobrar_venta_comanda v1: ${eCobro1.message}`);

    const { data: v1Row } = await db
      .from("ventas_pos")
      .select("estado, cobrada_at")
      .eq("id", venta1)
      .single();
    expect(v1Row?.estado).toBe("cobrada");
    expect(v1Row?.cobrada_at).not.toBeNull();
    const { fecha, turno } = fechaTurnoAR(v1Row!.cobrada_at as string);

    // ── (a) proyección registrada con detalle de los 2 medios ──
    const { data: proy1, error: eProy1 } = await db
      .from("ventas_pos_proyecciones")
      .select("venta_id, tenant_id, local_id, fecha, turno, detalle")
      .eq("venta_id", venta1)
      .maybeSingle();
    expect(eProy1).toBeNull();
    expect(proy1, `No hay fila en ventas_pos_proyecciones para venta ${venta1}`).not.toBeNull();
    expect(proy1!.local_id).toBe(localId);
    expect(proy1!.tenant_id).toBe(tenantId);
    expect(proy1!.fecha).toBe(fecha);
    expect(proy1!.turno).toBe(turno);
    const detalle1 = proy1!.detalle as { medio: string; monto: number }[];
    expect(detalle1).toHaveLength(2);
    const detEf = detalle1.find((d) => d.medio === MEDIO_EFECTIVO);
    const detTj = detalle1.find((d) => d.medio === MEDIO_TARJETA);
    expect(detEf, `detalle sin medio ${MEDIO_EFECTIVO}: ${JSON.stringify(detalle1)}`).toBeDefined();
    expect(detTj, `detalle sin medio ${MEDIO_TARJETA}: ${JSON.stringify(detalle1)}`).toBeDefined();
    expect(fix2(detEf!.monto)).toBe(fix2(NETO_EFECTIVO)); // neto de propina
    expect(fix2(detTj!.monto)).toBe(fix2(PAGO_TARJETA));

    // ── (b) filas diarias en `ventas` con montos netos exactos ──
    const filas1 = await ventasComandaDelDia(fecha, turno);
    expect(filas1, `Esperaba 2 filas ventas origen=comanda, hay: ${JSON.stringify(filas1)}`).toHaveLength(2);
    const filaEf1 = filas1.find((f) => f.medio === MEDIO_EFECTIVO);
    const filaTj1 = filas1.find((f) => f.medio === MEDIO_TARJETA);
    expect(filaEf1).toBeDefined();
    expect(filaTj1).toBeDefined();
    expect(fix2(filaEf1!.monto)).toBe(fix2(NETO_EFECTIVO));
    expect(fix2(filaTj1!.monto)).toBe(fix2(PAGO_TARJETA));

    // ── (c) el puente NO creó movimientos de caja PASE ──
    const movsDespues = await contarMovimientosPase();
    expect(movsDespues).toBe(movsAntes);

    // ════ 2. VENTA 2 — mismo día, EFECTIVO 1000 → upsert acumula ════
    const uuid2 = crypto.randomUUID();
    const { data: v2Raw, error: e2 } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: uuid2,
    });
    if (e2) throw new Error(`fn_abrir_venta_comanda_offline v2: ${e2.message}`);
    const venta2 = Number(v2Raw);
    createdVentaIds.push(venta2);

    const { error: eItem2 } = await db.rpc("fn_agregar_item_comanda_offline", {
      p_venta_id: venta2,
      p_venta_idempotency_uuid: null,
      p_item_id: itemId,
      p_cantidad: 1,
      p_precio_unitario: PRECIO_V2,
      p_idempotency_uuid: crypto.randomUUID(),
    });
    if (eItem2) throw new Error(`fn_agregar_item_comanda_offline v2: ${eItem2.message}`);

    const { error: eCobro2 } = await db.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: venta2,
      p_pagos: [
        {
          metodo: MEDIO_EFECTIVO,
          monto: PRECIO_V2,
          idempotency_key: idem("v2-pago-efectivo"),
        },
      ],
      p_propina: 0,
      p_cobrado_por: cajeroId,
      p_idempotency_key: idem("v2-cobro"),
    });
    if (eCobro2) throw new Error(`fn_cobrar_venta_comanda v2: ${eCobro2.message}`);

    // Guard anti-flake: si el run cruzó justo el límite de día/turno AR
    // (17:00 o medianoche) entre los dos cobros, los asserts de acumulación
    // no aplican — abortar con mensaje claro en vez de fallar confuso.
    const { data: v2Row } = await db
      .from("ventas_pos")
      .select("cobrada_at")
      .eq("id", venta2)
      .single();
    const ft2 = fechaTurnoAR(v2Row!.cobrada_at as string);
    if (ft2.fecha !== fecha || ft2.turno !== turno) {
      throw new Error(
        `El run cruzó el límite de día/turno AR entre cobros (v1=${fecha}/${turno}, v2=${ft2.fecha}/${ft2.turno}). Re-correr el test.`,
      );
    }

    // ── upsert: UNA sola fila EFECTIVO con el acumulado ──
    const filas2 = await ventasComandaDelDia(fecha, turno);
    const filasEf2 = filas2.filter((f) => f.medio === MEDIO_EFECTIVO);
    expect(
      filasEf2,
      `Esperaba UNA fila EFECTIVO (upsert), hay ${filasEf2.length}: ${JSON.stringify(filasEf2)}`,
    ).toHaveLength(1);
    expect(fix2(filasEf2[0]!.monto)).toBe(fix2(EFECTIVO_ACUMULADO)); // 4121.17 + 1000
    // TARJETA intacta
    const filasTj2 = filas2.filter((f) => f.medio === MEDIO_TARJETA);
    expect(filasTj2).toHaveLength(1);
    expect(fix2(filasTj2[0]!.monto)).toBe(fix2(PAGO_TARJETA));

    // Proyección de venta 2 registrada con su propio aporte (1000, no el acumulado)
    const { data: proy2 } = await db
      .from("ventas_pos_proyecciones")
      .select("detalle")
      .eq("venta_id", venta2)
      .maybeSingle();
    expect(proy2).not.toBeNull();
    const detalle2 = proy2!.detalle as { medio: string; monto: number }[];
    expect(detalle2).toHaveLength(1);
    expect(detalle2[0]!.medio).toBe(MEDIO_EFECTIVO);
    expect(fix2(detalle2[0]!.monto)).toBe(fix2(PRECIO_V2));

    // ════ 3. ANULAR VENTA 2 — reverso exacto del aporte ════
    await anularVenta(venta2, "v2");

    const { data: v2Post } = await db.from("ventas_pos").select("estado").eq("id", venta2).single();
    expect(v2Post?.estado).toBe("anulada");

    const filas3 = await ventasComandaDelDia(fecha, turno);
    const filasEf3 = filas3.filter((f) => f.medio === MEDIO_EFECTIVO);
    expect(filasEf3).toHaveLength(1);
    expect(fix2(filasEf3[0]!.monto)).toBe(fix2(NETO_EFECTIVO)); // volvió a 4121.17

    const { data: proy2Post } = await db
      .from("ventas_pos_proyecciones")
      .select("venta_id")
      .eq("venta_id", venta2)
      .maybeSingle();
    expect(proy2Post, "La proyección de venta 2 debía borrarse con el reverso").toBeNull();

    // ════ 4. ANULAR VENTA 1 — el día queda limpio (filas en 0 se borran) ════
    await anularVenta(venta1, "v1");

    const filas4 = await ventasComandaDelDia(fecha, turno);
    expect(
      filas4,
      `Las filas del día debían eliminarse (monto 0 → delete), quedaron: ${JSON.stringify(filas4)}`,
    ).toHaveLength(0);

    const { data: proysFinal } = await db
      .from("ventas_pos_proyecciones")
      .select("venta_id")
      .in("venta_id", [venta1, venta2]);
    expect(proysFinal ?? []).toHaveLength(0);

    // Y seguimos sin movimientos PASE nuevos (ni el cobro ni el reverso tocan caja).
    const movsFinal = await contarMovimientosPase();
    expect(movsFinal).toBe(movsAntes);
  });
});
