import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createE2EDuenoClient } from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

// E2E Test 47 — CIERRE DE MES: cerrar un mes bloquea crear_gasto con fecha en él;
// reabrir lo permite. INVARIANTE: con el mes cerrado, el INSERT financiero falla.
const MES = "2031-08-01";
const FECHA = "2031-08-15";
const SENT = "ZZE2EPERIODO47";

test.describe.serial("E2E Test 47 — CIERRE DE MES: bloqueo + reapertura", () => {
  let duenoDb: SupabaseClient;
  let localId: number;

  test.beforeAll(async () => {
    const seed = loadSharedSeed();
    localId = seed.local1Id;
    duenoDb = await createE2EDuenoClient();
  });

  test.afterAll(async () => {
    await duenoDb.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: MES }).then(() => {}, () => {});
    const { data: gs } = await duenoDb.from("gastos").select("id").eq("local_id", localId).eq("detalle", SENT);
    const ids = (gs ?? []).map((g) => g.id as string);
    if (ids.length) {
      await duenoDb.from("movimientos").delete().in("gasto_id_ref", ids).then(() => {}, () => {});
      await duenoDb.from("gastos").delete().in("id", ids).then(() => {}, () => {});
    }
    try { await duenoDb.auth.signOut(); } catch { /* */ }
  });

  test("cerrar bloquea el INSERT financiero; reabrir lo permite", async () => {
    const { error: eCerrar } = await duenoDb.rpc("cerrar_periodo", { p_local_id: localId, p_periodo_mes: MES });
    expect(eCerrar).toBeNull();

    const { error: eGasto } = await duenoDb.rpc("crear_gasto", {
      p_fecha: FECHA, p_local_id: localId, p_categoria: "Varios", p_tipo: "variable",
      p_monto: 1000, p_detalle: SENT, p_cuenta: "Caja Mayor", p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(String(eGasto?.message)).toContain("PERIODO_CERRADO"); // INVARIANTE

    const { error: eReabrir } = await duenoDb.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: MES });
    expect(eReabrir).toBeNull();

    const { data: ok, error: eOk } = await duenoDb.rpc("crear_gasto", {
      p_fecha: FECHA, p_local_id: localId, p_categoria: "Varios", p_tipo: "variable",
      p_monto: 1000, p_detalle: SENT, p_cuenta: "Caja Mayor", p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(eOk).toBeNull();
    expect((ok as { gasto_id: string }).gasto_id).toBeTruthy();
  });
});
