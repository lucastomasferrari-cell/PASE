// E2E Test 22: ajuste manual de stock + entrada por compra simulada

import {
  test,
  expect,
} from "@playwright/test";
import {
  cleanupE2ETenant,
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Test 22 — Stock ajuste manual", () => {
  let seed: E2ETenantSeedResult | null = null;
  const insumoId: number = 0;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("ajuste +3kg (entrada) → stock sube a 8kg", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const { error } = await duenoDb.rpc("fn_ajustar_stock_insumo", {
      p_insumo_id: insumoId,
      p_cantidad: 3,
      p_tipo: "entrada_ajuste",
      p_motivo: "E2E test entrada por compra al contado",
    });
    if (error) throw new Error(`fn_ajustar_stock_insumo: ${error.message}`);

    const { data: ins } = await svc.from("insumos").select("stock_actual").eq("id", insumoId).single();
    expect(Number(ins!.stock_actual)).toBe(8); // 5 + 3

    // Verificar audit en insumo_movimientos
    const { data: movs } = await svc.from("insumo_movimientos")
      .select("cantidad, tipo").eq("insumo_id", insumoId);
    const entrada = movs!.find(m => Number(m.cantidad) === 3);
    expect(entrada).toBeDefined();
    expect(entrada!.tipo).toBe("entrada_ajuste");

    await duenoDb.auth.signOut();
  });

  test("ajuste -1.5kg (salida) → stock baja a 6.5kg", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const { error } = await duenoDb.rpc("fn_ajustar_stock_insumo", {
      p_insumo_id: insumoId,
      p_cantidad: -1.5,
      p_tipo: "salida_ajuste",
      p_motivo: "E2E ajuste menos",
    });
    if (error) throw new Error(`fn_ajustar_stock_insumo: ${error.message}`);

    const { data: ins } = await svc.from("insumos").select("stock_actual").eq("id", insumoId).single();
    expect(Number(ins!.stock_actual)).toBeCloseTo(6.5, 1);

    await duenoDb.auth.signOut();
  });
});
