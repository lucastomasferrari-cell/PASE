import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// TEST DE CARACTERIZACIÓN ("golden master") — divergencias online vs offline
// de los 3 wrappers Tipo 1 de COMANDA. Documentado en
//   docs/analisis-logica-2026-06/07-divergencias-wrappers-offline.md
//
// ⚠️ ESTO NO ES UN TEST DE PARIDAD ("deben ser iguales"). Por diseño actual
// NO lo son. Es un test de CARACTERIZACIÓN: asserta las divergencias
// CONOCIDAS de HOY. Si una divergencia cambia (se arregla una, aparece una
// nueva, o el código deriva en cualquier dirección), el assert falla y
// OBLIGA a actualizar el doc 07 conscientemente. Caza el drift en ambos
// sentidos: online→offline y offline→online.
//
// Si al correr esto descubrís que una divergencia documentada NO se reproduce
// (ej. la venta offline SÍ engancha el turno), NO fuerces el assert: es un
// hallazgo — el doc está desactualizado o el código cambió.
//
// Escenarios (cada uno crea su propia venta de test y limpia en afterEach):
//   D1 — turno de caja:   online engancha turno_caja_id; offline lo deja NULL.
//   D2 — precio:          online calcula server-side desde catálogo; offline
//                         confía en el p_precio_unitario del cliente.
//   D4 — ocupar mesa:     online hace mesas.estado='ocupada'; offline no toca.
//
// Setup: Local Prueba 2 + canal slug 'mostrador' + un item disponible.
// items.estado='disponible' = activo (la columna `activo` NO existe en el
// catálogo COMANDA → usar `estado` + deleted_at IS NULL).
//
// D1 — cómo resuelvo el turno: la online `fn_abrir_venta_comanda` RAISE
// 'NO_HAY_TURNO_ABIERTO' si es POS (p_origen='pos') y p_modo != 'pedidos' y
// no hay turno abierto en el local. Para que la online ENGANCHE un turno
// (que es la divergencia que queremos demostrar) hace falta que exista uno.
// Sigo el mismo patrón que comanda/tests/servicio_completo_e2e.spec.ts:
// en beforeEach reuso el turno abierto si ya hay uno; si no, abro uno con
// `fn_abrir_turno_caja_comanda` y lo cierro en afterEach SOLO si lo abrí yo
// (dejo el estado del local como estaba).
// ─────────────────────────────────────────────────────────────────────────

const LOCAL = "Local Prueba 2";
// Precio sentinel raro y único para D2: garantiza que NO coincida con ningún
// precio real de catálogo, así la divergencia (offline usa este número, online
// usa el del catálogo) es inequívoca.
const SENTINEL_PRECIO_OFFLINE = 765_432.11;

test.describe("Wrappers Tipo 1 — caracterización divergencias online/offline (doc 07)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;

  // Precio que el server (online) calcularía para itemId en este canal:
  // item_precios_canal.precio (fallback precio_madre). Resuelto en runtime
  // para que el assert D2 no dependa de un número hardcodeado del catálogo.
  let precioCatalogo: number;

  let createdVentaIds: number[] = [];
  // Mesa de test dedicada para D4 (se crea/borra dentro del propio test).
  let turnoAbiertoPorTest = false;
  let turnoId: number | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    createdVentaIds = [];
    turnoAbiertoPorTest = false;
    turnoId = null;

    const { data: locales, error: errL } = await db.from("locales")
      .select("id, tenant_id").eq("nombre", LOCAL);
    if (errL) throw new Error(`Consulta local falló: ${errL.message}`);
    if (!locales || locales.length === 0) throw new Error(`Falta local "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: canales } = await db.from("canales")
      .select("id").eq("slug", "mostrador").eq("tenant_id", tenantId).limit(1);
    if (!canales || canales.length === 0) {
      throw new Error(
        `Falta canal slug='mostrador' para tenant ${tenantId}. Crear con:\n` +
        `INSERT INTO canales (tenant_id, slug, nombre) VALUES ('${tenantId}', 'mostrador', 'Mostrador');`
      );
    }
    canalId = canales[0].id as number;

    const { data: items } = await db.from("items")
      .select("id").eq("tenant_id", tenantId).eq("estado", "disponible")
      .is("deleted_at", null).limit(1);
    if (!items || items.length === 0) {
      throw new Error(
        `Falta al menos un item disponible para tenant ${tenantId}. ` +
        `Crear uno desde la UI Catálogo o INSERT directo.`
      );
    }
    itemId = items[0].id as number;

    // Resolver el precio que la online aplicaría a itemId en este canal,
    // replicando la lógica de fn_agregar_item_comanda: precio del canal, con
    // fallback a precio_madre. (Sin modificadores → sin extras.)
    const { data: precioCanal } = await db.from("item_precios_canal")
      .select("precio").eq("item_id", itemId).eq("canal_id", canalId)
      .is("deleted_at", null).limit(1);
    if (precioCanal && precioCanal.length > 0 && precioCanal[0].precio != null) {
      precioCatalogo = Number(precioCanal[0].precio);
    } else {
      const { data: itemRow } = await db.from("items")
        .select("precio_madre").eq("id", itemId).single();
      precioCatalogo = Number(itemRow!.precio_madre);
    }
    if (!Number.isFinite(precioCatalogo)) {
      throw new Error(`No pude resolver precio de catálogo para item ${itemId}`);
    }
  });

  test.afterEach(async () => {
    // Cleanup de ventas creadas (por id, para no tocar otras ventas del local).
    for (const vid of createdVentaIds) {
      try {
        const { data: vRow } = await db.from("ventas_pos")
          .select("estado, deleted_at").eq("id", vid).maybeSingle();
        if (!vRow || vRow.deleted_at) continue;
        await db.from("ventas_pos_pagos").delete().eq("venta_id", vid);
        await db.from("ventas_pos_items").delete().eq("venta_id", vid);
        await db.from("ventas_pos").delete().eq("id", vid);
      } catch (e) {
        console.error(`[cleanup] venta ${vid}:`, e);
      }
    }
    // Cerrar el turno SOLO si lo abrí yo (dejar el local como estaba).
    if (turnoAbiertoPorTest && turnoId != null) {
      try {
        // Necesito un cajero para cerrar; reuso el primer POS activo del local.
        const { data: cajeros } = await db.from("rrhh_empleados")
          .select("id").eq("local_id", localId).eq("pos_activo", true).limit(1);
        const cajeroId = cajeros?.[0]?.id as string | undefined;
        await db.rpc("fn_cerrar_turno_caja_comanda", {
          p_turno_id: turnoId,
          p_cerrado_por: cajeroId ?? null,
          p_monto_final_declarado: 0,
          p_notas: "cierre caracterizacion divergencias",
          p_idempotency_key: `divergencias-cierre-${turnoId}`,
        });
      } catch (e) {
        console.error(`[cleanup] turno ${turnoId}:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  // Garantiza que haya un turno abierto en el local; devuelve true si lo abrió
  // este test (para cerrarlo en cleanup). Si ya había uno, lo reusa.
  async function asegurarTurnoAbierto(): Promise<void> {
    const { data: turnoExist } = await db.from("turnos_caja")
      .select("id").eq("local_id", localId).eq("estado", "abierto")
      .order("id", { ascending: false }).limit(1);
    if (turnoExist && turnoExist.length > 0) {
      turnoId = turnoExist[0].id as number;
      turnoAbiertoPorTest = false;
      return;
    }
    const { data: cajeros } = await db.from("rrhh_empleados")
      .select("id").eq("local_id", localId).eq("pos_activo", true).limit(1);
    if (!cajeros || cajeros.length === 0) {
      throw new Error(`Sin empleado POS activo en ${LOCAL} — necesario para abrir turno (D1)`);
    }
    const cajeroId = cajeros[0].id as string;
    const { data: t, error: te } = await db.rpc("fn_abrir_turno_caja_comanda", {
      p_local_id: localId,
      p_cajero_id: cajeroId,
      p_monto_inicial: 0,
      p_notas: "caracterizacion divergencias D1",
      p_idempotency_key: `divergencias-turno-${Date.now()}`,
    });
    if (te) throw new Error(`abrir turno: ${te.message}`);
    turnoId = Number(t);
    turnoAbiertoPorTest = true;
  }

  test("D1 — turno de caja: online engancha turno_caja_id, offline lo deja NULL", async () => {
    // DIVERGENCIA CONOCIDA D1 (doc 07): la venta offline NO engancha el turno
    // de caja (turno_caja_id queda NULL), mientras la online sí lo setea cuando
    // hay un turno abierto. Si esto cambia, fue intencional → actualizá doc 07
    // y este assert.

    // Aseguramos un turno abierto para que la ONLINE tenga qué enganchar.
    await asegurarTurnoAbierto();
    expect(turnoId, "debería haber un turno abierto para D1").not.toBeNull();

    // ── ONLINE ──
    const { data: ventaOnline, error: errOn } = await db.rpc("fn_abrir_venta_comanda", {
      p_local_id: localId,
      p_modo: "mostrador",
      p_canal_id: canalId,
      p_mesa_id: null,
      p_mozo_id: null,
      p_cajero_id: null,
      p_origen: "pos",
      p_estado: "abierta",
    });
    expect(errOn, `abrir online: ${errOn?.code} / ${errOn?.message}`).toBeNull();
    expect(ventaOnline).toBeGreaterThan(0);
    createdVentaIds.push(ventaOnline as number);

    // ── OFFLINE ── (mismos inputs equivalentes)
    const uuidOff = crypto.randomUUID();
    const { data: ventaOffline, error: errOff } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: uuidOff,
    });
    expect(errOff, `abrir offline: ${errOff?.code} / ${errOff?.message}`).toBeNull();
    expect(ventaOffline).toBeGreaterThan(0);
    createdVentaIds.push(ventaOffline as number);

    const { data: rowOnline } = await db.from("ventas_pos")
      .select("turno_caja_id").eq("id", ventaOnline).single();
    const { data: rowOffline } = await db.from("ventas_pos")
      .select("turno_caja_id").eq("id", ventaOffline).single();

    // ONLINE: enganchó el turno abierto del local.
    expect(rowOnline!.turno_caja_id, "online debe enganchar el turno").not.toBeNull();
    expect(rowOnline!.turno_caja_id).toBe(turnoId);

    // OFFLINE: NO enganchó turno → NULL (divergencia D1).
    expect(rowOffline!.turno_caja_id, "DIVERGENCIA D1: offline NO engancha turno (doc 07)").toBeNull();
  });

  test("D2 — precio: online usa el del catálogo, offline confía en el del cliente", async () => {
    // DIVERGENCIA CONOCIDA D2 (doc 07): fn_agregar_item_comanda calcula el
    // precio server-side desde item_precios_canal (fallback precio_madre);
    // fn_agregar_item_comanda_offline usa el p_precio_unitario que manda el
    // cliente (catálogo cacheado, manipulable). Es inherente al offline. Si
    // el offline empezara a recalcular server-side, actualizá doc 07.
    //
    // El sentinel offline es un número raro que NO debe coincidir con ningún
    // precio real de catálogo → la divergencia queda inequívoca.
    expect(
      Number(precioCatalogo).toFixed(2),
      "precondición D2: el sentinel offline NO debe coincidir con el precio de catálogo (elegí otro sentinel)"
    ).not.toBe(SENTINEL_PRECIO_OFFLINE.toFixed(2));

    // ── ONLINE: abrir venta (necesita turno) + agregar item server-side ──
    await asegurarTurnoAbierto();
    const { data: ventaOnline, error: eOn } = await db.rpc("fn_abrir_venta_comanda", {
      p_local_id: localId,
      p_modo: "mostrador",
      p_canal_id: canalId,
      p_origen: "pos",
      p_estado: "abierta",
    });
    expect(eOn, `abrir online: ${eOn?.message}`).toBeNull();
    createdVentaIds.push(ventaOnline as number);

    const { data: itemOnline, error: eItemOn } = await db.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaOnline,
      p_item_id: itemId,
      p_cantidad: 1,
      p_curso: 1,
      p_modificadores: [],
      p_notas: null,
    });
    expect(eItemOn, `item online: ${eItemOn?.message}`).toBeNull();

    // ── OFFLINE: abrir venta + agregar item con precio sentinel distinto ──
    const uuidVenta = crypto.randomUUID();
    const { data: ventaOffline } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: uuidVenta,
    });
    createdVentaIds.push(ventaOffline as number);

    const { data: itemOffline, error: eItemOff } = await db.rpc("fn_agregar_item_comanda_offline", {
      p_venta_id: ventaOffline,
      p_venta_idempotency_uuid: null,
      p_item_id: itemId,
      p_cantidad: 1,
      p_precio_unitario: SENTINEL_PRECIO_OFFLINE,  // ← precio del cliente, distinto al catálogo
      p_curso: 1,
      p_idempotency_uuid: crypto.randomUUID(),
    });
    expect(eItemOff, `item offline: ${eItemOff?.message}`).toBeNull();

    const { data: rowOnline } = await db.from("ventas_pos_items")
      .select("precio_unitario").eq("id", itemOnline).single();
    const { data: rowOffline } = await db.from("ventas_pos_items")
      .select("precio_unitario").eq("id", itemOffline).single();

    // ONLINE: precio = el del catálogo (server-side), ignora cualquier input.
    expect(
      Number(rowOnline!.precio_unitario).toFixed(2),
      "online debe usar el precio del catálogo"
    ).toBe(Number(precioCatalogo).toFixed(2));

    // OFFLINE: precio = el sentinel que mandó el cliente (divergencia D2).
    expect(
      Number(rowOffline!.precio_unitario).toFixed(2),
      "DIVERGENCIA D2: offline confía en el precio del cliente (doc 07)"
    ).toBe(SENTINEL_PRECIO_OFFLINE.toFixed(2));
  });

  test("D4 — ocupar mesa: online marca 'ocupada', offline deja la mesa como estaba", async () => {
    // DIVERGENCIA CONOCIDA D4 (doc 07): fn_abrir_venta_comanda hace
    // UPDATE mesas SET estado='ocupada' (de 'libre') al abrir con mesa; el
    // offline NO toca `mesas` → la mesa queda en su estado previo (server
    // "miente" respecto a la ocupación real). Si esto cambia, actualizá doc 07.
    //
    // Uso una mesa de test DEDICADA (creada y borrada dentro del test) para no
    // tocar el plano real del local ni complicar el cleanup compartido.
    await asegurarTurnoAbierto();

    // Crear mesa de test en estado 'libre'.
    const numeroMesa = 990000 + Math.floor(Math.random() * 9000);
    const { data: mesaIns, error: eMesa } = await db.from("mesas").insert({
      tenant_id: tenantId,
      local_id: localId,
      numero: String(numeroMesa),
      estado: "libre",
    }).select("id").single();
    expect(eMesa, `crear mesa test: ${eMesa?.message}`).toBeNull();
    const mesaId = mesaIns!.id as number;

    try {
      // ── ONLINE con mesa → debe ocuparla ──
      const { data: ventaOnline, error: eOn } = await db.rpc("fn_abrir_venta_comanda", {
        p_local_id: localId,
        p_modo: "salon",
        p_canal_id: canalId,
        p_mesa_id: mesaId,
        p_origen: "pos",
        p_estado: "abierta",
      });
      expect(eOn, `abrir online con mesa: ${eOn?.message}`).toBeNull();
      createdVentaIds.push(ventaOnline as number);

      const { data: mesaTrasOnline } = await db.from("mesas")
        .select("estado").eq("id", mesaId).single();
      expect(mesaTrasOnline!.estado, "online debe ocupar la mesa").toBe("ocupada");

      // Reset a 'libre' para el camino offline (la venta online queda asociada,
      // se anula en cleanup; acá sólo testeamos el efecto sobre la mesa).
      await db.from("mesas").update({ estado: "libre" }).eq("id", mesaId);

      // ── OFFLINE con mesa → NO debe tocar la mesa (queda 'libre') ──
      const uuidOff = crypto.randomUUID();
      const { data: ventaOffline, error: eOff } = await db.rpc("fn_abrir_venta_comanda_offline", {
        p_local_id: localId,
        p_canal_id: canalId,
        p_modo: "salon",
        p_mesa_id: mesaId,
        p_idempotency_uuid: uuidOff,
      });
      expect(eOff, `abrir offline con mesa: ${eOff?.message}`).toBeNull();
      createdVentaIds.push(ventaOffline as number);

      const { data: mesaTrasOffline } = await db.from("mesas")
        .select("estado").eq("id", mesaId).single();
      expect(
        mesaTrasOffline!.estado,
        "DIVERGENCIA D4: offline NO ocupa la mesa (doc 07)"
      ).toBe("libre");
    } finally {
      // Limpiar la mesa de test (siempre, aunque el test falle).
      try { await db.from("mesas").delete().eq("id", mesaId); } catch (e) {
        console.error(`[cleanup] mesa ${mesaId}:`, e);
      }
    }
  });
});
