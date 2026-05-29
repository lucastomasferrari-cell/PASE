// E2E Test 21: registrar merma de stock (con TOTP cuando es robo)

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

test.describe.serial("E2E Test 21 — Stock merma", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("registrar merma 2kg → insumo_movimientos NEGATIVO + stock baja", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // 29-may fix: usar IDs del seed (antes eran 0 hardcoded → INSUMO_NO_ENCONTRADO).
    const insumoId = seed.insumoId;
    const motivoMermaId = seed.mermaMotivoId;

    // Stock inicial del insumo (configurado en seed = 20kg para "Arroz")
    const { data: insAntes } = await svc.from("insumos").select("stock_actual").eq("id", insumoId).single();
    const stockAntes = Number(insAntes!.stock_actual ?? 0);

    const { data: movId, error } = await duenoDb.rpc("fn_registrar_merma", {
      p_insumo_id: insumoId,
      p_local_id: seed.local1Id,
      p_cantidad: 2,
      p_motivo_id: motivoMermaId,
      p_notas: "E2E test merma vencimiento",
    });
    if (error) throw new Error(`fn_registrar_merma: ${error.message}`);
    expect(movId).toBeTruthy();

    // Insumo_movimientos debe tener fila NEGATIVA
    const { data: movs } = await svc.from("insumo_movimientos")
      .select("cantidad, tipo").eq("insumo_id", insumoId).eq("tenant_id", seed.tenantId);
    expect(movs!.length).toBeGreaterThan(0);
    const mermaMov = movs!.find(m => Number(m.cantidad) === -2);
    expect(mermaMov).toBeDefined();
    expect(mermaMov!.tipo).toBe("merma");

    // Stock del insumo bajó (trigger sobre insumo_movimientos)
    const { data: ins } = await svc.from("insumos").select("stock_actual").eq("id", insumoId).single();
    expect(Number(ins!.stock_actual)).toBe(stockAntes - 2);

    await duenoDb.auth.signOut();
  });
});
