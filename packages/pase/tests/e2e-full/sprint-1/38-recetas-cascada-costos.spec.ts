// E2E Test 38 — Cascada de costos de recetas (Pieza B Fase 1)
//
// fn_recalc_costo_item + trigger trg_insumo_costo_cascada: el costo de un item
// se calcula desde su receta (insumos + sub-recetas anidadas), y cambiar el
// costo de un insumo recalcula en cascada los items y sus padres.
//
// Spec base: docs/superpowers/specs/2026-05-28-catalogo-recetas-rediseno.md

import { test, expect } from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

const SENT = "ZZE2ERECETA";

test.describe.serial("E2E Test 38 — Cascada de costos recetas", () => {
  let seed: E2ETenantSeedResult | null = null;
  test.beforeAll(() => { seed = loadSharedSeed(); });

  test("costo item = insumo + sub-receta anidada; cambio de costo cascadea", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const T = seed.tenantId;
    const L = seed.local1Id;
    const itemIds: number[] = [];
    const recetaIds: number[] = [];
    let insumoId: number | undefined;

    const costo = async (id: number) => Number(((await svc.from("items").select("costo_actual").eq("id", id).single()).data)!.costo_actual ?? 0);
    const mkItem = async (n: string, prep: boolean) => {
      const { data } = await svc.from("items").insert({ nombre: `${SENT} ${n}`, tenant_id: T, local_id: L, es_prep_item: prep, precio_madre: 1000, estado: "disponible" }).select("id").single();
      const id = data!.id as number; itemIds.push(id); return id;
    };
    const mkReceta = async (itemId: number, rend: number) => {
      const { data } = await svc.from("recetas").insert({ item_id: itemId, tenant_id: T, local_id: L, nombre: "r", rendimiento: rend, activa: true }).select("id").single();
      const id = data!.id as number; recetaIds.push(id); return id;
    };

    try {
      const { data: ins } = await svc.from("insumos").insert({ nombre: `${SENT} insumo`, unidad: "kg", tenant_id: T, activo: true, costo_actual: 100 }).select("id").single();
      insumoId = ins!.id as number;

      const A = await mkItem("A", false); const rA = await mkReceta(A, 1);
      await svc.from("receta_insumos").insert({ receta_id: rA, insumo_id: insumoId, cantidad: 2, merma_pct: 0, tenant_id: T });
      await duenoDb.rpc("fn_recalc_costo_item", { p_item_id: A, p_depth: 0 });
      expect(await costo(A)).toBe(200);

      const B = await mkItem("B prep", true); const rB = await mkReceta(B, 1);
      await svc.from("receta_insumos").insert({ receta_id: rB, insumo_id: insumoId, cantidad: 1, merma_pct: 0, tenant_id: T });
      await duenoDb.rpc("fn_recalc_costo_item", { p_item_id: B, p_depth: 0 });
      expect(await costo(B)).toBe(100);

      const C = await mkItem("C", false); const rC = await mkReceta(C, 1);
      await svc.from("receta_insumos").insert({ receta_id: rC, prep_item_id: B, cantidad: 3, merma_pct: 0, tenant_id: T });
      await duenoDb.rpc("fn_recalc_costo_item", { p_item_id: C, p_depth: 0 });
      expect(await costo(C)).toBe(300);

      // cambio de costo del insumo → cascada automática
      await svc.from("insumos").update({ costo_actual: 200 }).eq("id", insumoId);
      expect(await costo(A)).toBe(400);
      expect(await costo(B)).toBe(200);
      expect(await costo(C)).toBe(600);
    } finally {
      for (const rid of recetaIds) {
        await svc.from("receta_insumos").delete().eq("receta_id", rid);
        await svc.from("recetas").delete().eq("id", rid);
      }
      for (const iid of itemIds) await svc.from("items").delete().eq("id", iid);
      if (insumoId) await svc.from("insumos").delete().eq("id", insumoId);
      await duenoDb.auth.signOut();
    }
  });
});
