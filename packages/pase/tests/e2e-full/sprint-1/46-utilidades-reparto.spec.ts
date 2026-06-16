// ─────────────────────────────────────────────────────────────────────────
// E2E Test 46 — UTILIDADES: socios + reparto + calculador
//
// Migraciones 202606160100–0500. Contra el tenant E2E compartido (DB-only):
//
//   [1] utilidades_guardar_socio × 2 (70 / 30) → suma de % = 100.
//   [2] utilidades_registrar_reparto $20.000 (14.000 / 6.000) → 1 gasto
//       tipo='retiro_socio' por socio + detalle linkeado a cada gasto.
//   [3] utilidades_cuanto_repartir cuenta el reparto en ya_repartido_mes
//       (delta exacto vs baseline = 20.000).
//   [4] INVARIANTE: Σ utilidades_reparto_detalle.monto = utilidades_repartos.total.
//
// Período aislado (2031-02) para no chocar con otros specs. El tenant E2E se
// destruye en global-teardown; igual se limpia todo en afterAll.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createE2EDuenoClient } from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

const SENT = "ZZE2EUTIL46";
const PERIODO = "2031-02-01";
const FECHA = "2031-02-15";
const IDEM = `${SENT}-idem`;

test.describe.serial("E2E Test 46 — UTILIDADES: socios → reparto → calculador", () => {
  let duenoDb: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let repartoId: string;
  let gastoIds: string[] = [];

  test.beforeAll(async () => {
    const seed = loadSharedSeed();
    localId = seed.local1Id;
    tenantId = seed.tenantId;
    duenoDb = await createE2EDuenoClient();
  });

  test.afterAll(async () => {
    if (gastoIds.length) {
      await duenoDb.from("movimientos").delete().in("gasto_id_ref", gastoIds).then(() => {}, () => {});
      await duenoDb.from("gastos").delete().in("id", gastoIds).then(() => {}, () => {});
    }
    if (repartoId) {
      await duenoDb.from("utilidades_repartos").delete().eq("id", repartoId).then(() => {}, () => {});
    }
    await duenoDb.from("utilidades_socios").delete()
      .eq("tenant_id", tenantId).eq("local_id", localId).like("nombre", `${SENT}%`).then(() => {}, () => {});
    await duenoDb.from("idempotency_keys").delete()
      .eq("rpc_name", "utilidades_registrar_reparto").eq("key", IDEM).then(() => {}, () => {});
    try { await duenoDb.auth.signOut(); } catch { /* */ }
  });

  test("socios + reparto generan retiros, el calculador lo cuenta, e invariante suma", async () => {
    // [1] Alta de 2 socios (70 / 30).
    const { data: s1, error: e1 } = await duenoDb.rpc("utilidades_guardar_socio", {
      p_local_id: localId, p_id: null, p_nombre: `${SENT} A`, p_porcentaje: 70, p_activo: true,
    });
    expect(e1).toBeNull();
    const socioA = s1 as { id: string; suma_porcentajes: number };

    const { data: s2, error: e2 } = await duenoDb.rpc("utilidades_guardar_socio", {
      p_local_id: localId, p_id: null, p_nombre: `${SENT} B`, p_porcentaje: 30, p_activo: true,
    });
    expect(e2).toBeNull();
    const socioB = s2 as { id: string; suma_porcentajes: number };
    expect(Number(socioB.suma_porcentajes)).toBe(100);

    // baseline ya_repartido (robusto contra datos del seed).
    const { data: cb } = await duenoDb.rpc("utilidades_cuanto_repartir", {
      p_local_id: localId, p_periodo_mes: PERIODO, p_meses_colchon: 1,
    });
    const yaAntes = Number((cb as { ya_repartido_mes: number }).ya_repartido_mes);

    // [2] Registrar el reparto $20.000 → 14.000 / 6.000.
    const { data: rep, error: eRep } = await duenoDb.rpc("utilidades_registrar_reparto", {
      p_local_id: localId, p_fecha: FECHA, p_total: 20000, p_cuenta_origen: "CAJA UTILIDADES",
      p_periodo_ref: PERIODO, p_nota: SENT,
      p_detalle: [{ socio_id: socioA.id, monto: 14000 }, { socio_id: socioB.id, monto: 6000 }],
      p_idempotency_key: IDEM,
    });
    expect(eRep).toBeNull();
    repartoId = (rep as { reparto_id: string }).reparto_id;
    expect(Number((rep as { total: number }).total)).toBe(20000);

    // Detalle + gastos retiro_socio.
    const { data: dets } = await duenoDb.from("utilidades_reparto_detalle")
      .select("socio_id, monto, gasto_id").eq("reparto_id", repartoId);
    expect(dets?.length).toBe(2);
    gastoIds = dets!.map((d) => d.gasto_id as string).filter(Boolean);
    expect(gastoIds.length).toBe(2);

    const { data: gastos } = await duenoDb.from("gastos").select("tipo, monto").in("id", gastoIds);
    expect(gastos?.length).toBe(2);
    for (const g of gastos!) expect(g.tipo).toBe("retiro_socio");
    expect(gastos!.map((g) => Number(g.monto)).sort((a, b) => a - b)).toEqual([6000, 14000]);

    // [3] El calculador cuenta el reparto (delta exacto = 20.000).
    const { data: ca } = await duenoDb.rpc("utilidades_cuanto_repartir", {
      p_local_id: localId, p_periodo_mes: PERIODO, p_meses_colchon: 1,
    });
    const yaDespues = Number((ca as { ya_repartido_mes: number }).ya_repartido_mes);
    expect(yaDespues - yaAntes).toBe(20000);

    // [4] INVARIANTE: Σ detalle.monto = reparto.total.
    const { data: detSum } = await duenoDb.from("utilidades_reparto_detalle")
      .select("monto").eq("reparto_id", repartoId);
    const suma = (detSum ?? []).reduce((s, d) => s + Number(d.monto), 0);
    const { data: repRow } = await duenoDb.from("utilidades_repartos")
      .select("total").eq("id", repartoId).single();
    expect(suma).toBe(Number((repRow as { total: number }).total));
    expect(suma).toBe(20000);
  });
});
