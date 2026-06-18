import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Cierre de mes: cerrar 2031-07 en Local Prueba 2 → crear_gasto con fecha en ese
// mes es rechazado (PERIODO_CERRADO); reabrir → se puede; cleanup completo.
const LOCAL = "Local Prueba 2";
const MES = "2031-07-01";
const FECHA = "2031-07-15";
const SENT = "ZZMUTPERIODO";

test.describe("Cierre de mes — mutante (bloqueo + reapertura)", () => {
  let db: SupabaseClient;
  let localId: number;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locs } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locs || locs.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locs[0].id as number;
    await limpiar();
  });

  test.afterEach(async () => {
    await limpiar();
    try { await db.auth.signOut(); } catch { /* */ }
  });

  async function limpiar() {
    // Reabrir primero (si no, el guard bloquea el borrado de los gastos del mes).
    await db.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: MES }).then(() => {}, () => {});
    const { data: gs } = await db.from("gastos").select("id").eq("local_id", localId).eq("detalle", SENT);
    const ids = (gs ?? []).map((g) => g.id as string);
    if (ids.length) {
      await db.from("movimientos").delete().in("gasto_id_ref", ids).then(() => {}, () => {});
      await db.from("gastos").delete().in("id", ids).then(() => {}, () => {});
    }
  }

  test("cerrar bloquea crear_gasto en el mes; reabrir lo permite", async () => {
    // 1. Cerrar el mes.
    const { error: eCerrar } = await db.rpc("cerrar_periodo", { p_local_id: localId, p_periodo_mes: MES });
    expect(eCerrar).toBeNull();

    // 2. crear_gasto con fecha en el mes cerrado → PERIODO_CERRADO.
    const { error: eGasto } = await db.rpc("crear_gasto", {
      p_fecha: FECHA, p_local_id: localId, p_categoria: "Varios", p_tipo: "variable",
      p_monto: 1000, p_detalle: SENT, p_cuenta: "Caja Mayor", p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(eGasto).not.toBeNull();
    expect(String(eGasto?.message)).toContain("PERIODO_CERRADO");

    // 3. Reabrir el mes.
    const { error: eReabrir } = await db.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: MES });
    expect(eReabrir).toBeNull();

    // 4. Ahora crear_gasto sí funciona.
    const { data: ok, error: eOk } = await db.rpc("crear_gasto", {
      p_fecha: FECHA, p_local_id: localId, p_categoria: "Varios", p_tipo: "variable",
      p_monto: 1000, p_detalle: SENT, p_cuenta: "Caja Mayor", p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(eOk).toBeNull();
    expect((ok as { gasto_id: string }).gasto_id).toBeTruthy();
  });
});
