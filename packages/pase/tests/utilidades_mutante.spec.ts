import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: módulo Utilidades — socios + reparto + calculador + anular.
// Spec: docs/superpowers/specs/2026-06-16-utilidades-reparto-design.md
//
// Valida el circuito clave de plata:
//   1. utilidades_guardar_socio: alta de 2 socios (60/40), devuelve suma %.
//   2. utilidades_registrar_reparto $10.000 (6.000/4.000) → crea 1 gasto
//      tipo='retiro_socio' por socio + el detalle linkea cada gasto.
//   3. utilidades_cuanto_repartir cuenta el reparto en ya_repartido_mes (delta
//      exacto = 10.000), sin tocar plata real previa.
//   4. utilidades_anular_reparto revierte: gastos quedan estado='anulado',
//      reparto.anulado=true, y ya_repartido_mes vuelve a 0 (delta).
//
// DB-only. Local Prueba 2 + período aislado (2030-01) + sentinel.
// Cleanup: movimientos → gastos → repartos (cascade detalle) → socios → idem.
// ─────────────────────────────────────────────────────────────────────────
const SENT = "ZZMUTUTIL";
const LOCAL = "Local Prueba 2";
const PERIODO = "2030-01-01";
const FECHA = "2030-01-15";
const IDEM = `${SENT}-idem-key`;

test.describe("Utilidades — mutante (socios + reparto + calculador + anular)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locs } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locs || locs.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locs[0].id as number;
    tenantId = locs[0].tenant_id as string;
    await limpiar();
  });

  test.afterEach(async () => {
    await limpiar();
    try { await db.auth.signOut(); } catch { /* */ }
  });

  async function limpiar() {
    // 1) Repartos del test (por nota sentinel) → sus gastos/movimientos.
    const { data: reps } = await db.from("utilidades_repartos")
      .select("id").eq("tenant_id", tenantId).eq("local_id", localId).eq("nota", SENT);
    const repIds = (reps ?? []).map((r) => r.id as string);
    if (repIds.length) {
      const { data: dets } = await db.from("utilidades_reparto_detalle")
        .select("gasto_id").in("reparto_id", repIds);
      const gastoIds = (dets ?? []).map((d) => d.gasto_id as string | null).filter((x): x is string => !!x);
      if (gastoIds.length) {
        await db.from("movimientos").delete().in("gasto_id_ref", gastoIds).then(() => {}, () => {});
        await db.from("gastos").delete().in("id", gastoIds).then(() => {}, () => {});
      }
      await db.from("utilidades_repartos").delete().in("id", repIds).then(() => {}, () => {});
    }
    // 2) Socios del test.
    await db.from("utilidades_socios").delete()
      .eq("tenant_id", tenantId).eq("local_id", localId).like("nombre", `${SENT}%`)
      .then(() => {}, () => {});
    // 3) Idempotency key.
    await db.from("idempotency_keys").delete()
      .eq("rpc_name", "utilidades_registrar_reparto").eq("key", IDEM)
      .then(() => {}, () => {});
  }

  test("socios + reparto crea retiros, el calculador lo cuenta, y anular revierte", async () => {
    // 1. Alta de 2 socios (60 / 40).
    const { data: s1, error: e1 } = await db.rpc("utilidades_guardar_socio", {
      p_local_id: localId, p_id: null, p_nombre: `${SENT} Socio A`, p_porcentaje: 60, p_activo: true,
    });
    expect(e1).toBeNull();
    const socioA = (s1 as { id: string; suma_porcentajes: number });
    expect(Number(socioA.suma_porcentajes)).toBe(60);

    const { data: s2, error: e2 } = await db.rpc("utilidades_guardar_socio", {
      p_local_id: localId, p_id: null, p_nombre: `${SENT} Socio B`, p_porcentaje: 40, p_activo: true,
    });
    expect(e2).toBeNull();
    const socioB = (s2 as { id: string; suma_porcentajes: number });
    expect(Number(socioB.suma_porcentajes)).toBe(100); // 60 + 40

    // 2. ya_repartido ANTES (baseline robusto contra datos previos).
    const { data: cb } = await db.rpc("utilidades_cuanto_repartir", {
      p_local_id: localId, p_periodo_mes: PERIODO, p_meses_colchon: 0,
    });
    const yaAntes = Number((cb as { ya_repartido_mes: number }).ya_repartido_mes);

    // 3. Registrar el reparto $10.000 → 6.000 / 4.000.
    const { data: rep, error: eRep } = await db.rpc("utilidades_registrar_reparto", {
      p_local_id: localId, p_fecha: FECHA, p_total: 10000, p_cuenta_origen: "CAJA UTILIDADES",
      p_periodo_ref: PERIODO, p_nota: SENT,
      p_detalle: [{ socio_id: socioA.id, monto: 6000 }, { socio_id: socioB.id, monto: 4000 }],
      p_idempotency_key: IDEM,
    });
    expect(eRep).toBeNull();
    const reparto = (rep as { reparto_id: string; total: number });
    expect(Number(reparto.total)).toBe(10000);

    // 4. Detalle: 2 filas, montos correctos, cada una con gasto_id.
    const { data: dets } = await db.from("utilidades_reparto_detalle")
      .select("socio_id, monto, gasto_id").eq("reparto_id", reparto.reparto_id);
    expect(dets?.length).toBe(2);
    const detA = dets!.find((d) => d.socio_id === socioA.id)!;
    const detB = dets!.find((d) => d.socio_id === socioB.id)!;
    expect(Number(detA.monto)).toBe(6000);
    expect(Number(detB.monto)).toBe(4000);
    expect(detA.gasto_id).toBeTruthy();
    expect(detB.gasto_id).toBeTruthy();

    // 5. Los 2 gastos generados son tipo='retiro_socio' y activos.
    const gastoIds = [detA.gasto_id, detB.gasto_id] as string[];
    const { data: gastos } = await db.from("gastos")
      .select("id, tipo, monto, estado").in("id", gastoIds);
    expect(gastos?.length).toBe(2);
    for (const g of gastos!) {
      expect(g.tipo).toBe("retiro_socio");
      expect(g.estado).toBe("activo");
    }
    expect(gastos!.map((g) => Number(g.monto)).sort((a, b) => a - b)).toEqual([4000, 6000]);

    // 6. El calculador cuenta el reparto (delta exacto = 10.000).
    const { data: ca } = await db.rpc("utilidades_cuanto_repartir", {
      p_local_id: localId, p_periodo_mes: PERIODO, p_meses_colchon: 0,
    });
    const yaDespues = Number((ca as { ya_repartido_mes: number }).ya_repartido_mes);
    expect(yaDespues - yaAntes).toBe(10000);

    // 7. Idempotency: re-registrar con la misma key no duplica.
    const { data: rep2 } = await db.rpc("utilidades_registrar_reparto", {
      p_local_id: localId, p_fecha: FECHA, p_total: 10000, p_cuenta_origen: "CAJA UTILIDADES",
      p_periodo_ref: PERIODO, p_nota: SENT,
      p_detalle: [{ socio_id: socioA.id, monto: 6000 }, { socio_id: socioB.id, monto: 4000 }],
      p_idempotency_key: IDEM,
    });
    expect((rep2 as { idempotent_replay?: boolean }).idempotent_replay).toBe(true);
    const { count } = await db.from("utilidades_repartos")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("local_id", localId).eq("nota", SENT);
    expect(count).toBe(1); // sigue habiendo 1 reparto, no 2

    // 8. Anular revierte: gastos anulados + reparto.anulado + ya_repartido vuelve.
    const { data: anu, error: eAnu } = await db.rpc("utilidades_anular_reparto", {
      p_reparto_id: reparto.reparto_id, p_motivo: `${SENT} test`,
    });
    expect(eAnu).toBeNull();
    expect((anu as { anulado: boolean; gastos_revertidos: number }).anulado).toBe(true);
    expect((anu as { gastos_revertidos: number }).gastos_revertidos).toBe(2);

    const { data: gastos2 } = await db.from("gastos").select("estado").in("id", gastoIds);
    for (const g of gastos2!) expect(g.estado).toBe("anulado");

    const { data: repRow } = await db.from("utilidades_repartos")
      .select("anulado").eq("id", reparto.reparto_id).single();
    expect((repRow as { anulado: boolean }).anulado).toBe(true);

    const { data: cf } = await db.rpc("utilidades_cuanto_repartir", {
      p_local_id: localId, p_periodo_mes: PERIODO, p_meses_colchon: 0,
    });
    const yaFinal = Number((cf as { ya_repartido_mes: number }).ya_repartido_mes);
    expect(yaFinal - yaAntes).toBe(0); // anulado → no cuenta
  });
});
