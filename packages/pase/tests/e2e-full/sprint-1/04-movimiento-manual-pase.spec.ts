// ─────────────────────────────────────────────────────────────────────────
// E2E Sprint 2 — Test 04: movimiento manual en Caja (PASE — RPC crear_movimiento_caja)
//
// Cubre el flow de "cargar ingreso/egreso manual desde la pantalla Caja de
// PASE". Es el RPC más usado: cualquier ingreso ad-hoc, propina, ajuste,
// liquidación de Rappi/MP, etc. pasa por acá.
//
// Tests inline:
//   (a) Ingreso de $20.000 a Caja Efectivo → saldo sube
//   (b) Egreso de $7.500 desde Caja Efectivo → saldo baja
//   (c) Anular el ingreso (a) → saldo vuelve a estado original tras (b)
// ─────────────────────────────────────────────────────────────────────────

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

test.describe.serial("E2E Sprint 2 — Movimiento manual Caja (PASE)", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("ingreso + egreso + anular ingreso → saldo coherente al final", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const cuenta = "Caja Efectivo";
    const local = seed.local1Id;

    // Patrón delta (29-may): bajo shared-seed no podemos asumir saldo inicial 0.
    // Tomamos snapshot ANTES y verificamos deltas relativos.
    const saldoOf = async () => {
      const { data } = await svc.from("saldos_caja")
        .select("saldo")
        .eq("tenant_id", seed!.tenantId).eq("local_id", local).eq("cuenta", cuenta).single();
      return Number(data?.saldo || 0);
    };
    const saldoBase = await saldoOf();

    // (a) Ingreso $20.000
    const { data: ingRes, error: ingErr } = await duenoDb.rpc("crear_movimiento_caja", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_cuenta: cuenta,
      p_tipo: "Ingreso Manual",
      p_cat: null,
      p_importe: 20000,
      p_detalle: "E2E ingreso de prueba",
      p_local_id: local,
    });
    if (ingErr) throw new Error(`crear_movimiento_caja ingreso: ${ingErr.message}`);
    const ingresoId = (ingRes as { mov_id?: string })?.mov_id;
    expect(ingresoId).toBeTruthy();
    expect(await saldoOf()).toBe(saldoBase + 20000);

    // (b) Egreso $7.500
    const { error: egrErr } = await duenoDb.rpc("crear_movimiento_caja", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_cuenta: cuenta,
      p_tipo: "Egreso Manual",
      p_cat: null,
      p_importe: -7500, // signed: negativo = egreso
      p_detalle: "E2E egreso de prueba",
      p_local_id: local,
    });
    if (egrErr) throw new Error(`crear_movimiento_caja egreso: ${egrErr.message}`);
    expect(await saldoOf()).toBe(saldoBase + 12500);

    // (c) Anular el ingreso (a) → saldo final = saldoBase + (-7500)
    const { error: anuErr } = await duenoDb.rpc("anular_movimiento", {
      p_mov_id: ingresoId,
      p_motivo: "E2E test anular ingreso",
    });
    if (anuErr) throw new Error(`anular_movimiento: ${anuErr.message}`);
    expect(await saldoOf()).toBe(saldoBase - 7500);

    // Verificar: los 2 movs de ESTE test (filtrados por detalle sentinel)
    // → 1 activo (egreso) + 1 anulado (ingreso)
    const { data: movs } = await svc.from("movimientos")
      .select("importe, anulado, detalle")
      .eq("tenant_id", seed.tenantId).eq("local_id", local).eq("cuenta", cuenta)
      .in("detalle", ["E2E ingreso de prueba", "E2E egreso de prueba"]);
    const activos = movs!.filter(m => !m.anulado);
    const anulados = movs!.filter(m => m.anulado);
    expect(activos).toHaveLength(1);
    expect(anulados).toHaveLength(1);
    expect(Number(activos[0]!.importe)).toBe(-7500);
    expect(Number(anulados[0]!.importe)).toBe(20000);

    await duenoDb.auth.signOut();
  });
});
