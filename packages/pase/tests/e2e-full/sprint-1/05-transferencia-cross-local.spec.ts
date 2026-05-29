// ─────────────────────────────────────────────────────────────────────────
// E2E Sprint 2 — Test 05: transferencia entre cuentas + cross-local
//
// Cubre la feature reciente (commit e0c4146 22-may): RPC transferencia_cuentas
// con p_local_destino_id opcional para transferir entre locales distintos.
//
// 2 tests:
//   (a) same-local: Caja Efectivo → Caja Mayor en Local 1 ($10K).
//       Verifica 2 movs balanceados + transferencia_id linkea ambos.
//   (b) cross-local: Caja Mayor Local 1 → Banco Local 2 ($3K).
//       Verifica saldos respectivos en ambos locales.
// ─────────────────────────────────────────────────────────────────────────

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

test.describe.serial("E2E Sprint 2 — Transferencia entre cuentas", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("same-local: Caja Efectivo → Caja Mayor crea 2 movs balanceados", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const monto = 10000;

    const { error } = await duenoDb.rpc("transferencia_cuentas", {
      p_local_id: seed.local1Id,
      p_cuenta_origen: "Caja Efectivo",
      p_cuenta_destino: "Caja Mayor",
      p_monto: monto,
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E same-local transfer",
    });
    if (error) throw new Error(`transferencia_cuentas same-local: ${error.message}`);

    // Verificar 2 movs creados con el mismo transferencia_id.
    // Filtramos ajuste_inicial porque el opening balance del seed también es mov.
    const { data: movs } = await svc.from("movimientos")
      .select("cuenta, importe, transferencia_id, tipo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .in("cuenta", ["Caja Efectivo", "Caja Mayor"])
      .eq("anulado", false)
      .neq("tipo", "ajuste_inicial")
      .order("cuenta");
    expect(movs).toHaveLength(2);
    expect(movs![0]!.transferencia_id).toBe(movs![1]!.transferencia_id);
    // Caja Efectivo: salida (-10000); Caja Mayor: entrada (+10000)
    const efectivoMov = movs!.find(m => m.cuenta === "Caja Efectivo")!;
    const mayorMov = movs!.find(m => m.cuenta === "Caja Mayor")!;
    expect(Number(efectivoMov.importe)).toBe(-monto);
    expect(Number(mayorMov.importe)).toBe(monto);

    // Saldos: Caja Efectivo $40K, Caja Mayor $10K
    const { data: saldos } = await svc.from("saldos_caja")
      .select("cuenta, saldo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .in("cuenta", ["Caja Efectivo", "Caja Mayor"]);
    const sBy = (cuenta: string) => Number(saldos!.find(s => s.cuenta === cuenta)!.saldo);
    expect(sBy("Caja Efectivo")).toBe(40000);
    expect(sBy("Caja Mayor")).toBe(10000);

    await duenoDb.auth.signOut();
  });

  test("cross-local: Caja Mayor L1 → Banco L2 mueve plata entre locales", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const monto = 3000;

    // Pre: Caja Mayor L1 tiene $10K (del test anterior). Banco L2 = $0.
    const { error } = await duenoDb.rpc("transferencia_cuentas", {
      p_local_id: seed.local1Id,
      p_cuenta_origen: "Caja Mayor",
      p_cuenta_destino: "Banco",
      p_monto: monto,
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E cross-local",
      p_local_destino_id: seed.local2Id,
    });
    if (error) throw new Error(`transferencia_cuentas cross-local: ${error.message}`);

    // Caja Mayor L1: $10K - $3K = $7K
    const { data: mayorL1 } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id).eq("cuenta", "Caja Mayor").single();
    expect(Number(mayorL1!.saldo)).toBe(7000);

    // Banco L2: $0 + $3K = $3K
    const { data: bancoL2 } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local2Id).eq("cuenta", "Banco").single();
    expect(Number(bancoL2!.saldo)).toBe(3000);

    // Verificar 2 movs cross-local con mismo transferencia_id (buscamos por
    // las 2 cuentas/locales involucradas en esta tx específica).
    const { data: movs } = await svc.from("movimientos")
      .select("local_id, cuenta, importe, transferencia_id")
      .eq("tenant_id", seed.tenantId)
      .eq("anulado", false)
      .eq("importe", monto)
      .eq("local_id", seed.local2Id);
    const movEntrada = movs![0]!;
    expect(movEntrada.cuenta).toBe("Banco");
    const { data: movsSalida } = await svc.from("movimientos")
      .select("local_id, cuenta, importe, transferencia_id")
      .eq("tenant_id", seed.tenantId)
      .eq("anulado", false)
      .eq("importe", -monto)
      .eq("transferencia_id", movEntrada.transferencia_id);
    expect(movsSalida).toHaveLength(1);
    expect(movsSalida![0]!.cuenta).toBe("Caja Mayor");
    expect(movsSalida![0]!.local_id).toBe(seed.local1Id);

    await duenoDb.auth.signOut();
  });
});
