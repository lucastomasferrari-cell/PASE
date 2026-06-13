import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: COBRO OFFLINE incremental (Tier 2) — invoca directo el wrapper
// `fn_agregar_pago_venta_comanda_offline` desde el cliente Supabase, igual que
// haría el push de la cola offline cuando vuelve internet.
//
// El wrapper (migración 202606130600) resuelve la venta por UUID (puede ser un
// tempId nunca sincronizado) vía fn_resolver_venta_id_por_uuid y delega en la
// inner fn_agregar_pago_venta_comanda, que es idempotente por idempotency_key
// (per-pago) y marca la venta `cobrada` cuando los pagos cubren el total
// (lo que libera la mesa + dispara triggers de stock/proyección/reserva).
//
// Mutantes que cubre:
//   1. RESOLUCIÓN POR UUID: el pago llega con p_venta_id=null + uuid de venta
//      → el wrapper encuentra la venta correcta. Si fn_resolver_venta_id_por_uuid
//      se rompe, el pago no aparece o cae con error.
//   2. MARCA COBRADA: con un solo pago que cubre el total, la venta queda
//      estado='cobrada'. Si la inner deja de marcar, esto cae.
//   3. IDEMPOTENCIA: 2 llamadas con el MISMO idempotency_key NO duplican el
//      pago (mismo count, mismo id retornado). Si el dedup de la inner se
//      rompe → doble cobro (bug de plata).
//   4. SPLIT: dos pagos parciales (efectivo mitad + tarjeta mitad) con keys
//      distintas → recién con el 2do la venta queda cobrada; ambos pagos viven.
//
// Setup: Local Prueba 2 + canal slug 'mostrador' + un item activo cualquiera.
// El precio sentinel hace que el total sea conocido y único.
// Cleanup en afterEach: borra pagos/items + soft-delete venta (cada paso en su
// propio try/catch para que un test interrumpido no rompa el siguiente run).

const SENTINEL_PRECIO = 432105; // precio único — identifica items creados por este test
const LOCAL = "Local Prueba 2";

test.describe("Cobro offline — flow mutante (agregar pago via UUID)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;

  let createdVentaIds: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();
    createdVentaIds = [];

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

    // items.estado='disponible' = item activo (la columna `activo` no existe;
    // el catálogo COMANDA usa estado disponible/agotado + deleted_at).
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
  });

  test.afterEach(async () => {
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
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  // Helper: abre una venta offline (UUID) y le agrega UN item por `cantidad`
  // unidades al precio sentinel. Devuelve { ventaId, ventaUuid, total }.
  async function abrirVentaConItem(cantidad: number): Promise<{ ventaId: number; ventaUuid: string; total: number }> {
    const ventaUuid = crypto.randomUUID();
    const { data: ventaId, error: errV } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: ventaUuid,
    });
    expect(errV, `abrir venta: ${errV?.message}`).toBeNull();
    expect(ventaId).toBeGreaterThan(0);
    createdVentaIds.push(ventaId as number);

    const { data: itemRes, error: errItem } = await db.rpc("fn_agregar_item_comanda_offline", {
      p_venta_id: null,
      p_venta_idempotency_uuid: ventaUuid,
      p_item_id: itemId,
      p_cantidad: cantidad,
      p_precio_unitario: SENTINEL_PRECIO,
      p_curso: 1,
      p_idempotency_uuid: crypto.randomUUID(),
    });
    expect(errItem, `agregar item: ${errItem?.message}`).toBeNull();
    expect(itemRes).toBeGreaterThan(0);

    // El total de la venta lo recalcula el server al agregar el item.
    const { data: vRow } = await db.from("ventas_pos")
      .select("total").eq("id", ventaId).single();
    return { ventaId: ventaId as number, ventaUuid, total: Number(vRow!.total) };
  }

  test("MUTANTE: pago via UUID resuelve la venta + la marca cobrada al cubrir el total", async () => {
    const { ventaId, ventaUuid, total } = await abrirVentaConItem(1);
    expect(total).toBe(SENTINEL_PRECIO); // 1 × sentinel

    const k1 = crypto.randomUUID();
    const { data: pagoId, error } = await db.rpc("fn_agregar_pago_venta_comanda_offline", {
      p_venta_id: null,                       // ← null: simula tempId no sincronizado
      p_venta_idempotency_uuid: ventaUuid,    // ← resuelve la venta por UUID
      p_metodo: "efectivo",
      p_monto: total,
      p_idempotency_key: k1,
      p_cobrado_por: null,
      p_vuelto: null,
      p_propina_incluida: 0,
      p_cuotas: null,
      p_idempotency_uuid: crypto.randomUUID(),
    });

    expect(error, `agregar pago: ${error?.code} / ${error?.message}`).toBeNull();
    expect(typeof pagoId).toBe("number");
    expect(pagoId).toBeGreaterThan(0);

    // El pago se creó asociado a la venta RESUELTA (no a null/0).
    const { data: pagoRow } = await db.from("ventas_pos_pagos")
      .select("id, venta_id, metodo, monto, idempotency_key")
      .eq("id", pagoId).single();
    expect(pagoRow!.venta_id).toBe(ventaId);
    expect(pagoRow!.metodo).toBe("efectivo");
    expect(Number(pagoRow!.monto).toFixed(2)).toBe(total.toFixed(2));
    expect(pagoRow!.idempotency_key).toBe(k1);

    // MUTANTE marca cobrada: el pago cubrió el total → venta 'cobrada'.
    const { data: vRow } = await db.from("ventas_pos")
      .select("estado").eq("id", ventaId).single();
    expect(vRow!.estado).toBe("cobrada");
  });

  test("MUTANTE: idempotencia — 2 calls con mismo idempotency_key NO duplican el pago", async () => {
    const { ventaId, ventaUuid, total } = await abrirVentaConItem(1);

    const k1 = crypto.randomUUID();
    const call = () => db.rpc("fn_agregar_pago_venta_comanda_offline", {
      p_venta_id: null,
      p_venta_idempotency_uuid: ventaUuid,
      p_metodo: "efectivo",
      p_monto: total,
      p_idempotency_key: k1,          // ← MISMA key en ambas llamadas
      p_cobrado_por: null,
      p_vuelto: null,
      p_propina_incluida: 0,
      p_cuotas: null,
      p_idempotency_uuid: crypto.randomUUID(),
    });

    const r1 = await call();
    const r2 = await call();

    expect(r1.error, `1er pago: ${r1.error?.message}`).toBeNull();
    expect(r2.error, `2do pago (replay): ${r2.error?.message}`).toBeNull();
    // MUTANTE dedup: el replay retorna el MISMO id del pago original.
    expect(r2.data).toBe(r1.data);

    // Confirmar en DB: EXACTAMENTE 1 pago para esa venta.
    const { data: pagos } = await db.from("ventas_pos_pagos")
      .select("id").eq("venta_id", ventaId);
    expect(pagos?.length).toBe(1);
  });

  test("MUTANTE: split — dos pagos parciales con keys distintas; recién el 2do cobra la venta", async () => {
    // total = 2 × sentinel para que mitad sea entero.
    const { ventaId, ventaUuid, total } = await abrirVentaConItem(2);
    expect(total).toBe(SENTINEL_PRECIO * 2);
    const mitad = total / 2;

    const k1 = crypto.randomUUID();
    const k2 = crypto.randomUUID();

    // 1er pago: efectivo por la mitad → NO cubre, venta sigue abierta.
    const { error: e1 } = await db.rpc("fn_agregar_pago_venta_comanda_offline", {
      p_venta_id: null,
      p_venta_idempotency_uuid: ventaUuid,
      p_metodo: "efectivo",
      p_monto: mitad,
      p_idempotency_key: k1,
      p_cobrado_por: null, p_vuelto: null, p_propina_incluida: 0, p_cuotas: null,
      p_idempotency_uuid: crypto.randomUUID(),
    });
    expect(e1, `pago 1: ${e1?.message}`).toBeNull();

    const { data: vMedio } = await db.from("ventas_pos")
      .select("estado").eq("id", ventaId).single();
    expect(vMedio!.estado).toBe("abierta"); // mitad no cubre

    // 2do pago: tarjeta por la otra mitad → cubre el total → cobrada.
    const { error: e2 } = await db.rpc("fn_agregar_pago_venta_comanda_offline", {
      p_venta_id: null,
      p_venta_idempotency_uuid: ventaUuid,
      p_metodo: "tarjeta-debito",
      p_monto: mitad,
      p_idempotency_key: k2,
      p_cobrado_por: null, p_vuelto: null, p_propina_incluida: 0, p_cuotas: null,
      p_idempotency_uuid: crypto.randomUUID(),
    });
    expect(e2, `pago 2: ${e2?.message}`).toBeNull();

    const { data: vFinal } = await db.from("ventas_pos")
      .select("estado").eq("id", ventaId).single();
    expect(vFinal!.estado).toBe("cobrada");

    // Ambos pagos existen, suman el total.
    const { data: pagos } = await db.from("ventas_pos_pagos")
      .select("monto, metodo").eq("venta_id", ventaId).order("id", { ascending: true });
    expect(pagos?.length).toBe(2);
    const suma = (pagos ?? []).reduce((s, p) => s + Number(p.monto), 0);
    expect(suma.toFixed(2)).toBe(total.toFixed(2));
    expect((pagos ?? []).map((p) => p.metodo).sort()).toEqual(["efectivo", "tarjeta-debito"]);
  });
});
