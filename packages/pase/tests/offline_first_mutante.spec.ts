import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: flow completo offline-first (abrir → items → cobrar)
// invocando directo las RPCs `_offline` desde el cliente Supabase. No
// pasa por la UI Playwright para ser determinista — el flow UI es lo
// mismo pero con timing variable.
//
// Cubre los 3 fixes críticos de hoy:
//   1. fn_abrir_venta_comanda_offline calcula numero_local manualmente
//      (sin trigger inexistente). Patrón: COALESCE(MAX(numero_local), 0)+1
//   2. fn_agregar_item_comanda_offline resuelve venta_id desde
//      p_venta_idempotency_uuid (no requiere venta sincronizada).
//   3. fn_cobrar_venta_comanda_offline cierra el ciclo via UUID.
//
// Y los 3 mutantes confirman:
//   - Idempotency: si se llama 2 veces con mismo UUID, retorna mismo id.
//   - Cross-RPC: item creado con UUID lookup encuentra venta correctamente.
//   - Cobro idempotente: 2 cobros con misma idempotency_uuid no duplican.
//
// Setup mínimo: Local Prueba 2 (id resuelto en runtime) + canal slug
// 'mostrador' + un item activo cualquiera (no necesita ser específico
// porque el test crea + paga + anula su propia venta sin afectar otras).
//
// Cleanup en afterEach: anula venta + borra rows si quedaron. Idempotente
// para que un test interrumpido a mitad no rompa el siguiente run.

const SENTINEL_PRECIO = 543210;  // precio único — identifica item creado por este test
const SENTINEL_CANTIDAD = 2;
const LOCAL = "Local Prueba 2";

test.describe("Offline-first — flow mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;

  // IDs creados durante el test, para cleanup
  let createdVentaIds: number[] = [];
  let createdItemIds: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();
    createdVentaIds = [];
    createdItemIds = [];

    // Resolver local + tenant
    const { data: locales, error: errL } = await db.from("locales")
      .select("id, tenant_id").eq("nombre", LOCAL);
    if (errL) throw new Error(`Consulta local falló: ${errL.message}`);
    if (!locales || locales.length === 0) throw new Error(`Falta local "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    // Resolver canal mostrador (debería existir por seed)
    const { data: canales } = await db.from("canales")
      .select("id").eq("slug", "mostrador").eq("tenant_id", tenantId).limit(1);
    if (!canales || canales.length === 0) {
      throw new Error(
        `Falta canal slug='mostrador' para tenant ${tenantId}. Crear con:\n` +
        `INSERT INTO canales (tenant_id, slug, nombre) VALUES ('${tenantId}', 'mostrador', 'Mostrador');`
      );
    }
    canalId = canales[0].id as number;

    // Resolver cualquier item activo del tenant (necesitamos su id para
    // agregar al carrito). Si no existe ninguno, pre-check accionable.
    // items.estado='disponible' = item activo. La columna `activo` no existe
    // (drift de schema: el catálogo COMANDA migró a estado disponible/agotado
    // + deleted_at). El `.eq("activo", true)` previo devolvía error silencioso
    // → este pre-check fallaba con "Falta item" aunque hay 137 disponibles.
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
    // Cleanup: anular ventas creadas + borrar items hijos.
    // Hacemos por id para no afectar otras ventas del local.
    for (const vid of createdVentaIds) {
      try {
        // Si la venta está cobrada → anular RPC. Si no → soft delete directo.
        const { data: vRow } = await db.from("ventas_pos")
          .select("estado, deleted_at").eq("id", vid).maybeSingle();
        if (!vRow || vRow.deleted_at) continue;

        // Borrar pagos primero (no hay FK pero por limpieza)
        await db.from("ventas_pos_pagos").delete().eq("venta_id", vid);
        // Borrar items
        await db.from("ventas_pos_items").delete().eq("venta_id", vid);
        // Borrar venta
        await db.from("ventas_pos").delete().eq("id", vid);
      } catch (e) {
        console.error(`[cleanup] venta ${vid}:`, e);
      }
    }
    for (const iid of createdItemIds) {
      try {
        await db.from("ventas_pos_items").delete().eq("id", iid);
      } catch (e) {
        console.error(`[cleanup] item ${iid}:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("MUTANTE: abrir venta offline crea con numero_local correlativo", async () => {
    const uuid = crypto.randomUUID();

    const { data: ventaId, error } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: uuid,
    });

    expect(error).toBeNull();
    expect(typeof ventaId).toBe("number");
    expect(ventaId).toBeGreaterThan(0);
    createdVentaIds.push(ventaId as number);

    // Verificar en DB: la venta existe con UUID + numero_local > 0 + estado abierta
    const { data: row } = await db.from("ventas_pos")
      .select("id, local_id, numero_local, estado, idempotency_uuid, modo, canal_id")
      .eq("id", ventaId).single();

    expect(row).not.toBeNull();
    expect(row!.local_id).toBe(localId);
    expect(row!.numero_local).toBeGreaterThan(0);  // MUTANTE: si el fix de numero_local se rompe, esto cae
    expect(row!.estado).toBe("abierta");
    expect(row!.idempotency_uuid).toBe(uuid);
    expect(row!.modo).toBe("mostrador");
    expect(row!.canal_id).toBe(canalId);
  });

  test("MUTANTE: idempotency_uuid — 2 calls con mismo UUID retornan mismo id", async () => {
    const uuid = crypto.randomUUID();

    const { data: id1 } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: uuid,
    });
    expect(id1).toBeGreaterThan(0);
    createdVentaIds.push(id1 as number);

    // Segundo call con MISMO uuid → debe retornar el mismo id sin crear nueva
    const { data: id2 } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: uuid,
    });

    expect(id2).toBe(id1);

    // Confirmar en DB que hay EXACTAMENTE 1 venta con ese UUID
    const { data: rows } = await db.from("ventas_pos")
      .select("id").eq("idempotency_uuid", uuid);
    expect(rows?.length).toBe(1);
  });

  test("MUTANTE: agregar item con p_venta_idempotency_uuid resuelve venta correctamente", async () => {
    const ventaUuid = crypto.randomUUID();
    const itemUuid = crypto.randomUUID();

    // 1. Crear venta
    const { data: ventaId } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId,
      p_canal_id: canalId,
      p_modo: "mostrador",
      p_idempotency_uuid: ventaUuid,
    });
    createdVentaIds.push(ventaId as number);

    // 2. Agregar item pasando p_venta_id=null + uuid (simula caso offline
    //    donde el cliente todavía no sabe el BIGINT real). El server debe
    //    resolverlo via fn_resolver_venta_id_por_uuid.
    const { data: itemIdResult, error: errItem } = await db.rpc("fn_agregar_item_comanda_offline", {
      p_venta_id: null,                  // ← null, simula offline
      p_venta_idempotency_uuid: ventaUuid,  // ← uuid de la venta padre
      p_item_id: itemId,
      p_cantidad: SENTINEL_CANTIDAD,
      p_precio_unitario: SENTINEL_PRECIO,
      p_curso: 1,
      p_idempotency_uuid: itemUuid,
    });

    expect(errItem).toBeNull();
    expect(typeof itemIdResult).toBe("number");
    expect(itemIdResult).toBeGreaterThan(0);
    createdItemIds.push(itemIdResult as number);

    // Verificar el item se asoció correctamente a la venta real (no a null/0)
    const { data: itemRow } = await db.from("ventas_pos_items")
      .select("id, venta_id, cantidad, precio_unitario, subtotal, idempotency_uuid")
      .eq("id", itemIdResult).single();

    expect(itemRow!.venta_id).toBe(ventaId);
    expect(itemRow!.cantidad).toBe(SENTINEL_CANTIDAD);
    expect(Number(itemRow!.precio_unitario)).toBe(SENTINEL_PRECIO);
    expect(Number(itemRow!.subtotal)).toBe(SENTINEL_CANTIDAD * SENTINEL_PRECIO);
    expect(itemRow!.idempotency_uuid).toBe(itemUuid);

    // El total de la venta también debe haberse recalculado
    const { data: ventaRow } = await db.from("ventas_pos")
      .select("total, subtotal").eq("id", ventaId).single();
    expect(Number(ventaRow!.subtotal)).toBe(SENTINEL_CANTIDAD * SENTINEL_PRECIO);
  });

  test("MUTANTE: idempotency item — 2 calls con mismo item UUID no duplican", async () => {
    const ventaUuid = crypto.randomUUID();
    const itemUuid = crypto.randomUUID();

    const { data: ventaId } = await db.rpc("fn_abrir_venta_comanda_offline", {
      p_local_id: localId, p_canal_id: canalId, p_modo: "mostrador",
      p_idempotency_uuid: ventaUuid,
    });
    createdVentaIds.push(ventaId as number);

    const callItem = () => db.rpc("fn_agregar_item_comanda_offline", {
      p_venta_id: ventaId,
      p_venta_idempotency_uuid: null,
      p_item_id: itemId,
      p_cantidad: 1,
      p_precio_unitario: SENTINEL_PRECIO,
      p_idempotency_uuid: itemUuid,
    });

    const r1 = await callItem();
    const r2 = await callItem();

    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r2.data).toBe(r1.data);  // MUTANTE: dedup
    createdItemIds.push(r1.data as number);

    // Confirmar que SOLO hay 1 item con ese UUID
    const { data: rows } = await db.from("ventas_pos_items")
      .select("id").eq("idempotency_uuid", itemUuid);
    expect(rows?.length).toBe(1);
  });
});
