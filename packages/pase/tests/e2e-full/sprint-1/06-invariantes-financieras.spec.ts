// ─────────────────────────────────────────────────────────────────────────
// E2E Sprint 4 (preview) — Test 06: invariantes financieras SQL
//
// Después de toda la operación, verifica que el sistema mantiene las reglas
// que SIEMPRE deben cumplirse. Si algo se descalibra (ej. una RPC olvidó
// actualizar saldos_caja), uno de estos invariantes lo flagea.
//
// Ejecutamos después del test 05 (que dejó movimientos + transferencias).
// El estado al iniciar este test: tenant fresh + algunos movimientos
// creados arriba en sprint-1. Verificamos:
//
// INV1: saldos_caja[c] == SUM(movimientos.importe WHERE cuenta=c AND anulado=false)
//       Para cada cuenta/local del tenant. Si falla, hay drift como el de
//       Caja Chica Villa Crespo.
//
// INV2: cada movimiento con `transferencia_id` debe tener exactamente 2 patas
//       y la suma de las patas debe ser 0 (balance).
//
// INV3: cada movimiento con `anulado=true` NO debe estar incluido en el saldo.
//       (Si lo está, el cache no procesó la anulación correctamente.)
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

test.describe.serial("E2E Sprint 4 — Invariantes financieras (SQL)", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => {
    try { await cleanupE2ETenant(); } catch (e) {

      console.error("[afterAll]", e);
    }
  });

  test("genera 5 ops + verifica los 3 invariantes financieros", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // ── Generar actividad: 5 movs en distintas cuentas ──────────────────
    const fecha = new Date().toISOString().slice(0, 10);
    const ops = [
      { cuenta: "Caja Efectivo", importe: 50000, tipo: "Ingreso Manual" },
      { cuenta: "Caja Efectivo", importe: -10000, tipo: "Egreso Manual" },
      { cuenta: "Banco", importe: 30000, tipo: "Ingreso Manual" },
      { cuenta: "MercadoPago", importe: 15000, tipo: "Ingreso Manual" },
      { cuenta: "Caja Efectivo", importe: 2000, tipo: "Ingreso Manual" }, // se anula después
    ];
    const movIds: string[] = [];
    for (const op of ops) {
      const { data, error } = await duenoDb.rpc("crear_movimiento_caja", {
        p_fecha: fecha, p_cuenta: op.cuenta, p_tipo: op.tipo, p_cat: null,
        p_importe: op.importe, p_detalle: `inv ${op.cuenta}`, p_local_id: seed.local1Id,
      });
      if (error) throw new Error(`mov: ${error.message}`);
      movIds.push((data as { mov_id: string }).mov_id);
    }

    // Anular el último (para tener un anulado en el set)
    await duenoDb.rpc("anular_movimiento", {
      p_mov_id: movIds[4], p_motivo: "test invariante anulado",
    });

    // ── INV1: saldos_caja[c] == SUM(movs.importe WHERE cuenta=c AND !anulado) ─
    const { data: cuentas } = await svc.from("saldos_caja")
      .select("cuenta, saldo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id);
    for (const c of cuentas!) {
      const { data: movsCuenta } = await svc.from("movimientos")
        .select("importe")
        .eq("tenant_id", seed.tenantId)
        .eq("local_id", seed.local1Id)
        .eq("cuenta", c.cuenta)
        .eq("anulado", false);
      const calculado = (movsCuenta || []).reduce((s, m) => s + Number(m.importe), 0);
      expect(
        Math.abs(Number(c.saldo) - calculado),
        `INV1 drift en cuenta "${c.cuenta}" del local ${seed.local1Id}: ` +
        `cache=${c.saldo} vs calculado=${calculado}`,
      ).toBeLessThan(0.01);
    }

    // ── INV2: cada transferencia_id tiene 2 patas que suman 0 ────────────
    await duenoDb.rpc("transferencia_cuentas", {
      p_local_id: seed.local1Id,
      p_cuenta_origen: "Caja Efectivo",
      p_cuenta_destino: "MercadoPago",
      p_monto: 5000,
      p_fecha: fecha,
      p_detalle: "inv transfer",
    });
    const { data: transfMovs } = await svc.from("movimientos")
      .select("transferencia_id, importe")
      .eq("tenant_id", seed.tenantId)
      .eq("anulado", false)
      .not("transferencia_id", "is", null);
    const porTransfId = new Map<string, number[]>();
    for (const m of transfMovs!) {
      const arr = porTransfId.get(m.transferencia_id) || [];
      arr.push(Number(m.importe));
      porTransfId.set(m.transferencia_id, arr);
    }
    for (const [tid, importes] of porTransfId.entries()) {
      expect(importes.length, `INV2 transferencia ${tid} tiene ${importes.length} patas (esperado 2)`).toBe(2);
      const suma = importes.reduce((a, b) => a + b, 0);
      expect(Math.abs(suma), `INV2 transferencia ${tid} no balanceada: importes=${importes.join(",")}`).toBeLessThan(0.01);
    }

    // ── INV3: ningún anulado entra en el saldo ───────────────────────────
    // Validamos: si forzáramos el saldo a (suma con anulados), sería distinto
    // del cache → confirma que el cache solo cuenta no-anulados.
    const { data: anulados } = await svc.from("movimientos")
      .select("importe, cuenta")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("anulado", true);
    expect(anulados!.length).toBeGreaterThan(0); // el de arriba quedó anulado
    // El anulado tenía importe +2000 en Caja Efectivo. Si se hubiera contado,
    // el saldo sería 2000 más. Verifico contraprueba:
    const { data: cajaEfSaldo } = await svc.from("saldos_caja")
      .select("saldo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    // Caja Efectivo: +50000 -10000 +2000(anulado, no cuenta) -5000(transfer out) = 35000
    expect(Number(cajaEfSaldo!.saldo)).toBe(35000);

    await duenoDb.auth.signOut();
  });
});
