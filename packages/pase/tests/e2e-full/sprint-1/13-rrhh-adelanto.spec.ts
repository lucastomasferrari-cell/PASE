// E2E Sprint 3 — Test 13: registrar adelanto a empleado

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

test.describe.serial("E2E Sprint 3 — Adelanto RRHH", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("registrar adelanto $25K crea adelanto + mov + saldo baja", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const monto = 25000;

    // Patrón delta (29-may): bajo shared-seed no podemos asumir saldos
    // absolutos ni asumir 0 adelantos previos. Guardamos baseline y verificamos.
    const { data: saldoAntes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    const saldoBase = Number(saldoAntes?.saldo ?? 0);

    const { data: adelsAntes } = await svc.from("rrhh_adelantos")
      .select("id").eq("tenant_id", seed.tenantId)
      .eq("empleado_id", seed.empleados.mensual.id);
    const idsAntes = new Set((adelsAntes ?? []).map(a => a.id));

    const { error } = await duenoDb.rpc("registrar_adelanto", {
      p_empleado_id: seed.empleados.mensual.id,
      p_monto: monto,
      p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E adelanto",
    });
    if (error) throw new Error(`registrar_adelanto: ${error.message}`);

    // Adelanto NUEVO creado (filtrado por id no presente antes)
    const { data: adelsDespues } = await svc.from("rrhh_adelantos")
      .select("id, monto, empleado_id, cuenta")
      .eq("tenant_id", seed.tenantId)
      .eq("empleado_id", seed.empleados.mensual.id);
    const nuevos = (adelsDespues ?? []).filter(a => !idsAntes.has(a.id));
    expect(nuevos).toHaveLength(1);
    expect(Number(nuevos[0]!.monto)).toBe(monto);
    const adelantoIdNuevo = nuevos[0]!.id;

    // Movimiento ligado al adelanto NUEVO
    const { data: movs } = await svc.from("movimientos")
      .select("importe, tipo, adelanto_id_ref")
      .eq("tenant_id", seed.tenantId)
      .eq("anulado", false)
      .eq("adelanto_id_ref", adelantoIdNuevo);
    expect(movs).toHaveLength(1);
    expect(Number(movs![0]!.importe)).toBe(-monto);

    // Saldo bajó exactamente -monto (delta)
    const { data: saldoDespues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(saldoDespues!.saldo)).toBe(saldoBase - monto);

    await duenoDb.auth.signOut();
  });
});
