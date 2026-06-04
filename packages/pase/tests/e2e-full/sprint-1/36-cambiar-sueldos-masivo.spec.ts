// ─────────────────────────────────────────────────────────────────────────
// E2E full — Test 36: cambiar_sueldos_masivo (aumentos masivos) — Lucas 04-jun
//
// La RPC aplica varios cambios de sueldo en UNA transacción + guarda historial
// por cada uno + idempotency. Acá: aumento masivo sobre 2 empleados del seed
// (mensual + quincenal), verifica sueldos + 2 filas de historial + replay.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E full — cambiar_sueldos_masivo", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => { seed = loadSharedSeed(); });

  test("aumento masivo a 2 empleados → sueldos + historial + idempotency", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const idA = seed.empleados.mensual.id;
    const idB = seed.empleados.quincenal.id;

    // Sueldos actuales
    const { data: antes } = await svc.from("rrhh_empleados")
      .select("id, sueldo_mensual").in("id", [idA, idB]);
    const map = new Map(antes!.map(e => [e.id as string, Number(e.sueldo_mensual)]));
    const origA = map.get(idA)!;
    const origB = map.get(idB)!;
    const nuevoA = origA + 11111;
    const nuevoB = origB + 22222;

    const idemKey = `e2e36-${seed.tenantId.slice(0, 8)}`;
    const cambios = [
      { emp_id: idA, nuevo_sueldo: nuevoA },
      { emp_id: idB, nuevo_sueldo: nuevoB },
    ];

    const { data: r1, error: e1 } = await duenoDb.rpc("cambiar_sueldos_masivo", {
      p_cambios: cambios, p_motivo: "E2E aumento masivo", p_idempotency_key: idemKey,
    });
    if (e1) throw new Error(`cambiar_sueldos_masivo: ${e1.message}`);
    expect((r1 as { cambiados: number }).cambiados).toBe(2);

    // Sueldos actualizados
    const { data: despues } = await svc.from("rrhh_empleados")
      .select("id, sueldo_mensual").in("id", [idA, idB]);
    const mapAfter = new Map(despues!.map(e => [e.id as string, Number(e.sueldo_mensual)]));
    expect(mapAfter.get(idA)).toBe(nuevoA);
    expect(mapAfter.get(idB)).toBe(nuevoB);

    // 2 filas de historial (una por empleado) con anterior→nuevo
    const { data: histA } = await svc.from("rrhh_historial_sueldos")
      .select("sueldo_anterior, sueldo_nuevo").eq("empleado_id", idA).eq("sueldo_nuevo", nuevoA);
    expect(histA!.length).toBe(1);
    expect(Number(histA![0]!.sueldo_anterior)).toBe(origA);
    const { data: histB } = await svc.from("rrhh_historial_sueldos")
      .select("sueldo_nuevo").eq("empleado_id", idB).eq("sueldo_nuevo", nuevoB);
    expect(histB!.length).toBe(1);

    // Idempotency: 2da llamada misma key → replay, no duplica historial
    const { data: r2 } = await duenoDb.rpc("cambiar_sueldos_masivo", {
      p_cambios: cambios, p_motivo: "E2E aumento masivo", p_idempotency_key: idemKey,
    });
    expect((r2 as { idempotent_replay?: boolean }).idempotent_replay).toBe(true);
    const { data: histA2 } = await svc.from("rrhh_historial_sueldos")
      .select("id").eq("empleado_id", idA).eq("sueldo_nuevo", nuevoA);
    expect(histA2!.length).toBe(1);

    // Cleanup: revertir sueldos (no romper otros tests del run que lean el sueldo)
    await svc.from("rrhh_empleados").update({ sueldo_mensual: origA }).eq("id", idA);
    await svc.from("rrhh_empleados").update({ sueldo_mensual: origB }).eq("id", idB);
    await duenoDb.auth.signOut();
  });
});
