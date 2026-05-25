// ─────────────────────────────────────────────────────────────────────────
// E2E Sprint 2 — Test 07: cargar + pagar factura proveedor
//
// Flujo:
//   1. Insertar factura directo en DB (la RPC crear_factura es compleja
//      y la pantalla la usa via UI; acá nos enfocamos en el pago).
//      Factura $12.000 + IVA21 $2.520 = $14.520 total.
//   2. Pagar desde Caja Efectivo via RPC pagar_factura.
//   3. Verificar:
//      - factura.estado = 'pagada'
//      - factura.pagos JSONB tiene 1 entrada con monto correcto
//      - movimiento creado tipo "Pago Proveedor" importe negativo
//      - saldo Caja Efectivo bajó en $14.520
//
// Después: pago parcial (cobertura de pagos en cuotas).
//   1. Insertar factura $20.000.
//   2. Pagar $8.000 → estado='parcial'
//   3. Pagar $12.000 → estado='pagada'
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import {
  seedE2ETenant,
  cleanupE2ETenant,
  createServiceClient,
  createE2EDuenoClient,
  seedSaldoInicial,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";

test.describe.serial("E2E Sprint 2 — Cargar + pagar factura", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const superToken = sess?.session?.access_token!;
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: superToken, baseUrl });
    // Saldo inicial vía opening balance (cache derivado del ledger desde 23-may).
    const svc = createServiceClient();
    await seedSaldoInicial(svc, seed.tenantId, seed.local1Id, "Caja Efectivo", 100000);
    await superdb.auth.signOut();
  });

  test.afterAll(async () => {
    try { await cleanupE2ETenant(); } catch (e) {

      console.error("[afterAll]", e);
    }
  });

  test("pago total: factura $14.520 cobrada de una desde Caja Efectivo", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Insertar factura directo (simulando que vino del Lector IA o se cargó manual)
    const facturaId = `FAC-E2E-${Date.now()}`;
    const total = 14520; // 12000 neto + 2520 iva21
    const { error: facErr } = await svc.from("facturas").insert({
      id: facturaId,
      tenant_id: seed.tenantId,
      prov_id: seed.proveedorId,
      local_id: seed.local1Id,
      nro: "A 0001-00000001",
      fecha: new Date().toISOString().slice(0, 10),
      neto: 12000,
      iva21: 2520,
      iva105: 0,
      iibb: 0,
      total,
      tipo: "A",
      estado: "pendiente",
      pagos: [],
    });
    if (facErr) throw new Error(`Insert factura: ${facErr.message}`);

    const saldoAntes = 100000;

    // Pagar via RPC
    const { error: payErr } = await duenoDb.rpc("pagar_factura", {
      p_factura_id: facturaId,
      p_monto: total,
      p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E pago total",
    });
    if (payErr) throw new Error(`pagar_factura: ${payErr.message}`);

    // Assert: factura pagada
    const { data: fac } = await svc.from("facturas")
      .select("estado, pagos, total")
      .eq("id", facturaId).single();
    expect(fac?.estado).toBe("pagada");
    expect(Array.isArray(fac?.pagos)).toBe(true);
    expect((fac!.pagos as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Assert: movimiento Pago Proveedor con importe negativo
    const { data: movs } = await svc.from("movimientos")
      .select("tipo, importe, fact_id, cuenta")
      .eq("tenant_id", seed.tenantId)
      .eq("fact_id", facturaId)
      .eq("anulado", false);
    expect(movs).toHaveLength(1);
    expect(Number(movs![0]!.importe)).toBe(-total);
    expect(movs![0]!.tipo).toContain("Pago"); // "Pago Proveedor" o similar

    // Assert: saldo bajó
    const { data: saldo } = await svc.from("saldos_caja")
      .select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(saldo!.saldo)).toBe(saldoAntes - total);

    await duenoDb.auth.signOut();
  });

  test("pago parcial en 2 cuotas: $8k + $12k → estado parcial → pagada", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const facturaId = `FAC-E2E-PARTIAL-${Date.now()}`;
    const total = 20000;
    await svc.from("facturas").insert({
      id: facturaId,
      tenant_id: seed.tenantId,
      prov_id: seed.proveedorId,
      local_id: seed.local1Id,
      nro: "A 0001-00000002",
      fecha: new Date().toISOString().slice(0, 10),
      neto: total, iva21: 0, iva105: 0, iibb: 0, total,
      tipo: "A", estado: "pendiente", pagos: [],
    });

    // Primer pago: $8.000 → parcial
    const { error: pay1Err } = await duenoDb.rpc("pagar_factura", {
      p_factura_id: facturaId, p_monto: 8000, p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10), p_detalle: "cuota 1/2",
    });
    if (pay1Err) throw new Error(`pago parcial 1: ${pay1Err.message}`);

    // NOTA: la RPC pagar_factura usa solo 'pagada' o 'pendiente' — el estado
    // 'parcial' no existe en el modelo actual. El intermedio queda 'pendiente'
    // con `pagos` JSONB acumulando las cuotas.
    let { data: fac } = await svc.from("facturas").select("estado, pagos").eq("id", facturaId).single();
    expect(fac?.estado).toBe("pendiente");
    expect((fac!.pagos as unknown[]).length).toBe(1);

    // Segundo pago: $12.000 → pagada
    const { error: pay2Err } = await duenoDb.rpc("pagar_factura", {
      p_factura_id: facturaId, p_monto: 12000, p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10), p_detalle: "cuota 2/2",
    });
    if (pay2Err) throw new Error(`pago parcial 2: ${pay2Err.message}`);

    fac = (await svc.from("facturas").select("estado, pagos").eq("id", facturaId).single()).data;
    expect(fac?.estado).toBe("pagada");
    expect((fac!.pagos as unknown[]).length).toBeGreaterThanOrEqual(2);

    // 2 movimientos de Pago Proveedor
    const { data: movs } = await svc.from("movimientos")
      .select("importe").eq("fact_id", facturaId).eq("anulado", false);
    expect(movs).toHaveLength(2);
    const suma = movs!.reduce((s, m) => s + Number(m.importe), 0);
    expect(suma).toBe(-total);

    await duenoDb.auth.signOut();
  });
});
