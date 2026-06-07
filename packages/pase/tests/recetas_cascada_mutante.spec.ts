import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: cascada de costos de recetas (Pieza B Fase 1).
// Spec: docs/superpowers/specs/2026-05-28-catalogo-recetas-rediseno.md
//
// Valida fn_recalc_costo_item + el trigger trg_insumo_costo_cascada:
//   - item con insumo: costo_actual = cantidad × costo_insumo.
//   - sub-receta (prep-item): su costo_actual se calcula igual.
//   - item que USA la sub-receta: costo incluye el anidado.
//   - cambiar el costo del insumo → la cascada recalcula item + sub-receta +
//     el padre que usa la sub-receta, automáticamente.
//
// DB-only. Crea items/insumo/recetas con prefijo SENTINEL y limpia en afterEach.
// ─────────────────────────────────────────────────────────────────────────
const SENT = "ZZMUTRECETA";
const LOCAL = "Local Prueba 2";

test.describe("Recetas — cascada de costos (mutante)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let insumoId: number | undefined;
  const itemIds: number[] = [];
  const recetaIds: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locs } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locs || locs.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locs[0].id as number;
    tenantId = locs[0].tenant_id as string;
    insumoId = undefined; itemIds.length = 0; recetaIds.length = 0;
  });

  test.afterEach(async () => {
    for (const rid of recetaIds) {
      await db.from("receta_insumos").delete().eq("receta_id", rid).then(() => {}, () => {});
      await db.from("recetas").delete().eq("id", rid).then(() => {}, () => {});
    }
    for (const iid of itemIds) await db.from("items").delete().eq("id", iid).then(() => {}, () => {});
    if (insumoId) await db.from("insumos").delete().eq("id", insumoId).then(() => {}, () => {});
    try { await db.auth.signOut(); } catch { /* */ }
  });

  const mkItem = async (nombre: string, esPrep: boolean): Promise<number> => {
    const { data } = await db.from("items").insert([{ nombre: `${SENT} ${nombre}`, tenant_id: tenantId, local_id: localId, es_prep_item: esPrep, precio_madre: 1000, estado: "disponible" }]).select("id").single();
    const id = data!.id as number; itemIds.push(id); return id;
  };
  const mkReceta = async (itemId: number, rend: number): Promise<number> => {
    const { data } = await db.from("recetas").insert([{ item_id: itemId, tenant_id: tenantId, local_id: localId, nombre: "r", rendimiento: rend, activa: true }]).select("id").single();
    const id = data!.id as number; recetaIds.push(id); return id;
  };
  const costo = async (itemId: number): Promise<number> => {
    const { data } = await db.from("items").select("costo_actual").eq("id", itemId).single();
    return Number(data!.costo_actual ?? 0);
  };

  test("costo de item con insumo + sub-receta anidada + cascada al cambiar costo de insumo", async () => {
    // Insumo a $100/kg.
    const { data: ins } = await db.from("insumos").insert([{ nombre: `${SENT} insumo`, unidad: "kg", tenant_id: tenantId, activo: true, costo_actual: 100 }]).select("id").single();
    insumoId = ins!.id as number;

    // Item A: usa insumo x2 → costo 200.
    const A = await mkItem("A", false); const rA = await mkReceta(A, 1);
    await db.from("receta_insumos").insert([{ receta_id: rA, insumo_id: insumoId, cantidad: 2, merma_pct: 0, tenant_id: tenantId }]);
    await db.rpc("fn_recalc_costo_item", { p_item_id: A, p_depth: 0 });
    expect(await costo(A)).toBe(200);

    // Sub-receta B (prep): usa insumo x1 → costo 100.
    const B = await mkItem("B prep", true); const rB = await mkReceta(B, 1);
    await db.from("receta_insumos").insert([{ receta_id: rB, insumo_id: insumoId, cantidad: 1, merma_pct: 0, tenant_id: tenantId }]);
    await db.rpc("fn_recalc_costo_item", { p_item_id: B, p_depth: 0 });
    expect(await costo(B)).toBe(100);

    // Item C: usa la sub-receta B x3 → costo 300 (anidado).
    const C = await mkItem("C", false); const rC = await mkReceta(C, 1);
    await db.from("receta_insumos").insert([{ receta_id: rC, prep_item_id: B, cantidad: 3, merma_pct: 0, tenant_id: tenantId }]);
    await db.rpc("fn_recalc_costo_item", { p_item_id: C, p_depth: 0 });
    expect(await costo(C)).toBe(300);

    // ★ Cambiar el costo del insumo a $200 → la cascada recalcula todo solo.
    await db.from("insumos").update({ costo_actual: 200 }).eq("id", insumoId);
    expect(await costo(A)).toBe(400);
    expect(await costo(B)).toBe(200);
    expect(await costo(C)).toBe(600); // cascada subió por la sub-receta
  });
});
