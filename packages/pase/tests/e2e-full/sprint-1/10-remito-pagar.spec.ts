// E2E Sprint 2 — Test 10: cargar remito + pagarlo

import {
  test,
  expect,
} from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Sprint 2 — Remito pagar", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("cargar remito $5000 + pagar → estado=pagado + mov + saldo baja", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const remId = `REM-E2E-${Date.now()}`;
    const monto = 5000;
    const { error: insErr } = await svc.from("remitos").insert({
      id: remId, tenant_id: seed.tenantId, prov_id: seed.proveedorId, local_id: seed.local1Id,
      nro: "R-001", fecha: new Date().toISOString().slice(0, 10), monto,
      estado: "sin_factura", // CHECK: sin_factura|pagado|facturado|anulado
      detalle: "E2E remito",
    });
    if (insErr) throw new Error(`Insert remito: ${insErr.message}`);

    await duenoDb.rpc("pagar_remito", {
      p_remito_id: remId, p_monto: monto, p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
    });

    const { data: rem } = await svc.from("remitos").select("estado").eq("id", remId).single();
    expect(rem?.estado).toBe("pagado");

    const { data: movs } = await svc.from("movimientos").select("importe, tipo")
      .eq("tenant_id", seed.tenantId).eq("remito_id_ref", remId).eq("anulado", false);
    expect(movs).toHaveLength(1);
    expect(Number(movs![0]!.importe)).toBe(-monto);

    const { data: saldo } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(saldo!.saldo)).toBe(30000 - monto);

    await duenoDb.auth.signOut();
  });
});
