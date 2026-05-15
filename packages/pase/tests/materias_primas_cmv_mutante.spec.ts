import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// CMV refactor 2026-05-15 — flujo end-to-end materia prima → insumo unificado.
//
// Invariantes:
//   1. Crear MP con precio + factor + merma → trigger setea insumo.costo_actual
//      = precio / (factor × (1 - merma/100)).
//   2. Crear 2da MP del mismo insumo → costo_actual = promedio simple.
//   3. Cargar factura_item con materia_prima_id → trigger actualiza
//      precio_actual de la MP → cascada al insumo.
//   4. Marcar MP inactiva → recalcula sin esa MP.
//   5. Cambiar merma_pct → recalcula con nuevo costo efectivo.

const SENTINEL = `Test-CMV-${Date.now()}`;
const LOCAL = "Local Prueba 2";

test.describe("CMV refactor — materia prima ↔ insumo unificado (mutante)", () => {
  let db: SupabaseClient;
  let tenantId: string;
  let localId: number;
  let insumoId: number | null = null;
  let mp1Id: number | null = null;
  let mp2Id: number | null = null;
  let proveedorId: number | null = null;
  let facturaId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length === 0) throw new Error(`No existe "${LOCAL}"`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    // Crear insumo unificado sentinel "Trucha test"
    const { data: ins, error: errIns } = await db.from("insumos").insert({
      tenant_id: tenantId, local_id: localId,
      nombre: `${SENTINEL}-Insumo-Trucha`,
      unidad: "kg",
      es_comprado: true,
    }).select("id").single();
    if (errIns) throw new Error(`Error creando insumo: ${errIns.message}`);
    insumoId = ins!.id as number;

    // Buscar un proveedor cualquiera del tenant
    const { data: provs } = await db.from("proveedores")
      .select("id").eq("tenant_id", tenantId).limit(1);
    proveedorId = provs?.[0]?.id ?? null;
  });

  test.afterEach(async () => {
    // Cleanup en orden inverso
    if (facturaId) {
      try {
        await db.from("factura_items").delete().eq("factura_id", facturaId);
        await db.from("facturas").delete().eq("id", facturaId);
      } catch (e) { console.error("[cleanup factura]", e); }
    }
    for (const id of [mp1Id, mp2Id].filter(Boolean) as number[]) {
      try {
        await db.from("materias_primas").update({ deleted_at: new Date().toISOString(), activa: false }).eq("id", id);
      } catch (e) { console.error(`[cleanup mp ${id}]`, e); }
    }
    if (insumoId) {
      try {
        await db.from("insumos").update({ deleted_at: new Date().toISOString() }).eq("id", insumoId);
      } catch (e) { console.error("[cleanup insumo]", e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("crear MP → recalcula insumo · 2da MP → promedio · factura → cascada", async () => {
    if (insumoId === null) throw new Error("Pre: insumo no se creó");

    // ── 1. Crear MP1: precio $10.000/kg, factor 1, merma 35%
    //     costo_efectivo = 10.000 / (1 * 0.65) = 15.384,615...
    const { data: mp1, error: errMp1 } = await db.from("materias_primas").insert({
      tenant_id: tenantId,
      nombre: `${SENTINEL}-MP-Trucha-c-visceras`,
      proveedor_id: proveedorId,
      insumo_id: insumoId,
      unidad_compra: "kg",
      factor_conversion: 1,
      merma_pct: 35,
      precio_actual: 10000,
      activa: true,
    }).select("id").single();
    expect(errMp1).toBeNull();
    mp1Id = mp1!.id as number;

    // Verificar que el insumo recibió el costo efectivo de MP1
    const { data: ins1 } = await db.from("insumos").select("costo_actual").eq("id", insumoId).single();
    const costoEsperado1 = 10000 / (1 * 0.65);
    expect(Math.abs(Number(ins1?.costo_actual) - costoEsperado1)).toBeLessThan(0.5);

    // ── 2. Crear MP2 del mismo insumo: $12.000/kg, factor 1, merma 5%
    //     costo_efectivo = 12.000 / (1 * 0.95) = 12.631,57...
    //     promedio simple = (15.384 + 12.631) / 2 = ~14.008
    const { data: mp2, error: errMp2 } = await db.from("materias_primas").insert({
      tenant_id: tenantId,
      nombre: `${SENTINEL}-MP-Trucha-s-visceras`,
      proveedor_id: proveedorId,
      insumo_id: insumoId,
      unidad_compra: "kg",
      factor_conversion: 1,
      merma_pct: 5,
      precio_actual: 12000,
      activa: true,
    }).select("id").single();
    expect(errMp2).toBeNull();
    mp2Id = mp2!.id as number;

    const { data: ins2 } = await db.from("insumos").select("costo_actual").eq("id", insumoId).single();
    const costoEsperado2 = (10000 / 0.65 + 12000 / 0.95) / 2;
    expect(Math.abs(Number(ins2?.costo_actual) - costoEsperado2)).toBeLessThan(0.5);

    // ── 3. Cargar factura_item con MP1 + precio_unitario nuevo $15.000 →
    //     trigger debería actualizar MP1.precio_actual → recalcular insumo
    const idFact = `FACT-TEST-${Date.now()}`;
    const { error: errFact } = await db.from("facturas").insert({
      id: idFact,
      tenant_id: tenantId,
      local_id: localId,
      prov_id: proveedorId,
      nro: `TEST-${Date.now()}`,
      fecha: new Date().toISOString().slice(0, 10),
      neto: 15000,
      total: 15000,
      estado: "pendiente",
    });
    expect(errFact).toBeNull();
    facturaId = idFact;

    const { error: errFi } = await db.from("factura_items").insert({
      factura_id: idFact,
      tenant_id: tenantId,
      producto: "Trucha c/visceras test",
      cantidad: 1,
      unidad: "kg",
      precio_unitario: 15000,
      subtotal: 15000,
      materia_prima_id: mp1Id,
    });
    expect(errFi).toBeNull();

    // Trigger debió haber actualizado MP1.precio_actual = 15000 + recalcular insumo
    const { data: mp1Post } = await db.from("materias_primas").select("precio_actual").eq("id", mp1Id!).single();
    expect(Number(mp1Post?.precio_actual)).toBe(15000);

    const { data: ins3 } = await db.from("insumos").select("costo_actual").eq("id", insumoId).single();
    const costoEsperado3 = (15000 / 0.65 + 12000 / 0.95) / 2;
    expect(Math.abs(Number(ins3?.costo_actual) - costoEsperado3)).toBeLessThan(0.5);

    // ── 4. Marcar MP2 como inactiva → insumo recalcula sin MP2
    await db.from("materias_primas").update({ activa: false }).eq("id", mp2Id!);
    const { data: ins4 } = await db.from("insumos").select("costo_actual").eq("id", insumoId).single();
    const costoEsperado4 = 15000 / 0.65; // solo MP1
    expect(Math.abs(Number(ins4?.costo_actual) - costoEsperado4)).toBeLessThan(0.5);

    // ── 5. Cambiar merma de MP1 de 35% a 50% → costo cambia
    await db.from("materias_primas").update({ merma_pct: 50 }).eq("id", mp1Id!);
    const { data: ins5 } = await db.from("insumos").select("costo_actual").eq("id", insumoId).single();
    const costoEsperado5 = 15000 / (1 * 0.5);
    expect(Math.abs(Number(ins5?.costo_actual) - costoEsperado5)).toBeLessThan(0.5);
  });
});
