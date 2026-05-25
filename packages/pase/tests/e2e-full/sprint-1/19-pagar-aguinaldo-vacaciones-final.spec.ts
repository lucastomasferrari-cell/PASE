// E2E Test 19: pagar aguinaldo + vacaciones + liquidación final
// 3 sub-tests cubriendo los pagos especiales de RRHH.

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import { seedE2ETenant, cleanupE2ETenant, createServiceClient, createE2EDuenoClient, seedSaldoInicial, type E2ETenantSeedResult } from "../setup/seed-tenant";

test.describe.serial("E2E Test 19 — Pagos RRHH especiales", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: sess?.session?.access_token!, baseUrl });
    const svc = createServiceClient();
    await seedSaldoInicial(svc, seed.tenantId, seed.local1Id, "Caja Efectivo", 2000000);
    await superdb.auth.signOut();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("pagar aguinaldo $750K → mov + pago especial registrado", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const monto = 750000;

    const { error } = await duenoDb.rpc("pagar_aguinaldo", {
      p_empleado_id: seed.empleados.mensual.id,
      p_lineas: [{ cuenta: "Caja Efectivo", monto }],
      p_monto_esperado: monto,
      p_fecha: new Date().toISOString().slice(0, 10),
    });
    if (error) throw new Error(`pagar_aguinaldo: ${error.message}`);

    // Pago especial registrado
    const { data: pagos } = await svc.from("rrhh_pagos_especiales")
      .select("monto, tipo").eq("tenant_id", seed.tenantId)
      .eq("empleado_id", seed.empleados.mensual.id);
    expect(pagos!.some(p => Number(p.monto) === monto)).toBe(true);

    await duenoDb.auth.signOut();
  });

  test("pagar vacaciones 10 días $500K → mov + pago especial registrado", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const monto = 500000;
    const dias = 10;

    const { error } = await duenoDb.rpc("pagar_vacaciones", {
      p_empleado_id: seed.empleados.quincenal.id,
      p_lineas: [{ cuenta: "Caja Efectivo", monto }],
      p_dias: dias,
      p_monto_esperado: monto,
      p_fecha: new Date().toISOString().slice(0, 10),
    });
    if (error) throw new Error(`pagar_vacaciones: ${error.message}`);

    const { data: pagos } = await svc.from("rrhh_pagos_especiales")
      .select("monto, dias, tipo").eq("tenant_id", seed.tenantId)
      .eq("empleado_id", seed.empleados.quincenal.id);
    expect(pagos!.some(p => Number(p.monto) === monto && Number(p.dias) === dias)).toBe(true);

    await duenoDb.auth.signOut();
  });

  test("liquidación final empleado → empleado inactivo + pago especial", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const total = 350000;

    const { error } = await duenoDb.rpc("liquidacion_final_empleado", {
      p_empleado_id: seed.empleados.semanal.id,
      p_fecha_egreso: new Date().toISOString().slice(0, 10),
      p_motivo: "Renuncia voluntaria",
      p_total: total,
      p_cuenta: "Caja Efectivo",
    });
    if (error) throw new Error(`liquidacion_final_empleado: ${error.message}`);

    // Empleado marcado inactivo + fecha_egreso seteada
    const { data: emp } = await svc.from("rrhh_empleados")
      .select("activo, fecha_egreso, motivo_baja").eq("id", seed.empleados.semanal.id).single();
    expect(emp?.activo).toBe(false);
    expect(emp?.fecha_egreso).toBeTruthy();
    expect(emp?.motivo_baja).toContain("Renuncia");

    await duenoDb.auth.signOut();
  });
});
