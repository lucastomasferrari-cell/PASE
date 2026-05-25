// E2E Sprint 3 — Test 13: registrar adelanto a empleado

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import { seedE2ETenant, cleanupE2ETenant, createServiceClient, createE2EDuenoClient, seedSaldoInicial, type E2ETenantSeedResult } from "../setup/seed-tenant";

test.describe.serial("E2E Sprint 3 — Adelanto RRHH", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: sess?.session?.access_token!, baseUrl });
    const svc = createServiceClient();
    await seedSaldoInicial(svc, seed.tenantId, seed.local1Id, "Caja Efectivo", 100000);
    await superdb.auth.signOut();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("registrar adelanto $25K crea adelanto + mov + saldo baja", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const monto = 25000;

    const { error } = await duenoDb.rpc("registrar_adelanto", {
      p_empleado_id: seed.empleados.mensual.id,
      p_monto: monto,
      p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E adelanto",
    });
    if (error) throw new Error(`registrar_adelanto: ${error.message}`);

    // Adelanto creado
    const { data: adels } = await svc.from("rrhh_adelantos")
      .select("monto, empleado_id, cuenta")
      .eq("tenant_id", seed.tenantId)
      .eq("empleado_id", seed.empleados.mensual.id);
    expect(adels).toHaveLength(1);
    expect(Number(adels![0]!.monto)).toBe(monto);

    // Movimiento negativo
    const { data: movs } = await svc.from("movimientos")
      .select("importe, tipo, adelanto_id_ref")
      .eq("tenant_id", seed.tenantId)
      .eq("anulado", false)
      .not("adelanto_id_ref", "is", null);
    expect(movs).toHaveLength(1);
    expect(Number(movs![0]!.importe)).toBe(-monto);

    // Saldo bajó
    const { data: saldo } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(saldo!.saldo)).toBe(100000 - monto);

    await duenoDb.auth.signOut();
  });
});
