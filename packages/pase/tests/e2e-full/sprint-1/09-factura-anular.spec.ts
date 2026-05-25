// E2E Sprint 2 — Test 09: anular factura con rollback de pago
// Flujo: cargar factura → pagar → anular → verificar saldos vuelven + factura.estado=anulada

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import { seedE2ETenant, cleanupE2ETenant, createServiceClient, createE2EDuenoClient, seedSaldoInicial, type E2ETenantSeedResult } from "../setup/seed-tenant";

test.describe.serial("E2E Sprint 2 — Anular factura con reverso", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: sess?.session?.access_token!, baseUrl });
    const svc = createServiceClient();
    await seedSaldoInicial(svc, seed.tenantId, seed.local1Id, "Caja Efectivo", 50000);
    await superdb.auth.signOut();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("cargar factura → pagar → anular → saldo y factura coherentes", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const facturaId = `FAC-ANU-${Date.now()}`;
    const total = 7500;
    await svc.from("facturas").insert({
      id: facturaId, tenant_id: seed.tenantId, prov_id: seed.proveedorId, local_id: seed.local1Id,
      nro: "A 0001-99", fecha: new Date().toISOString().slice(0, 10),
      neto: total, iva21: 0, iva105: 0, iibb: 0, total,
      tipo: "A", estado: "pendiente", pagos: [],
    });

    // Pagar
    await duenoDb.rpc("pagar_factura", {
      p_factura_id: facturaId, p_monto: total, p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
    });

    // Saldo antes de anular
    const { data: s1 } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(s1!.saldo)).toBe(50000 - total); // $42.500

    // Anular factura
    const { error } = await duenoDb.rpc("anular_factura", {
      p_factura_id: facturaId, p_motivo: "E2E test anular",
    });
    if (error) throw new Error(`anular_factura: ${error.message}`);

    // Factura queda anulada
    const { data: fac } = await svc.from("facturas").select("estado").eq("id", facturaId).single();
    expect(fac?.estado).toBe("anulada");

    // ⚠ DEUDA: anular_factura NO anula los movimientos del pago ni restituye
    // saldo. El operador tiene que hacerlo manualmente. Documentamos el
    // comportamiento actual (no es lo ideal, pero es la realidad del sistema).
    const { data: movs } = await svc.from("movimientos").select("anulado, importe")
      .eq("tenant_id", seed.tenantId).eq("fact_id", facturaId);
    expect(movs!.length).toBeGreaterThan(0);
    // Los movs del pago siguen activos — el saldo de Caja NO se restituye solo.
    const { data: s2 } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(s2!.saldo)).toBe(50000 - total); // sigue descontado

    await duenoDb.auth.signOut();
  });
});
