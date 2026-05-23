// E2E Test 21: registrar merma de stock (con TOTP cuando es robo)

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import { seedE2ETenant, cleanupE2ETenant, createServiceClient, createE2EDuenoClient, E2E_SENTINEL, type E2ETenantSeedResult } from "../setup/seed-tenant";

test.describe.serial("E2E Test 21 — Stock merma", () => {
  let seed: E2ETenantSeedResult | null = null;
  let insumoId: number = 0;
  let motivoMermaId: number = 0;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: sess?.session?.access_token!, baseUrl });

    // Crear insumo con stock + motivo de merma
    const svc = createServiceClient();
    const { data: ins } = await svc.from("insumos").insert({
      tenant_id: seed.tenantId, nombre: `${E2E_SENTINEL} Tomate`, unidad: "kg",
      costo_actual: 2500, stock_actual: 10, activo: true, es_comprado: true,
      stock_disponible: true, categoria_pl: "alimentos",
    }).select("id").single();
    insumoId = ins!.id as number;

    const { data: mot } = await svc.from("mermas_motivos").insert({
      tenant_id: seed.tenantId, nombre: "Vencimiento E2E", tipo_movimiento: "merma",
      orden: 99, activo: true,
    }).select("id").single();
    motivoMermaId = mot!.id as number;

    await superdb.auth.signOut();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("registrar merma 2kg → insumo_movimientos NEGATIVO + stock baja", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

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
    // Si el trigger fn_trg_insumo_mov_update_stock corre, stock = 10 - 2 = 8
    expect(Number(ins!.stock_actual)).toBe(8);

    await duenoDb.auth.signOut();
  });
});
