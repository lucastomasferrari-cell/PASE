import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: pagar un sueldo, ANULAR el pago, y volver a pagar la MISMA
// quincena (mismo novedad/cuota).
//
// Regresión del bug 05-jun (caso DIAZ Josefina): al anular el pago para
// corregir las formas de pago, la liquidación quedaba anulado=true (no se
// borra por el constraint UNIQUE(novedad_id,cuota_num)). Al re-pagar,
// pagar_sueldo la encontraba y cortaba con LIQUIDACION_ANULADA -> la quincena
// quedaba TRABADA, imposible de re-pagar. Migración 202606051200 hace que, si
// viene p_calc, la liquidación anulada se REVIVA (reset + valores nuevos) en
// vez de cortar.
//
// DB-only. Mes 9 (Septiembre) 2099 para no colisionar con otros tests.
// ─────────────────────────────────────────────────────────────────────────
const SENTINEL = 567890; // sueldo_mensual del Empleado Prueba
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const CUENTA = "Caja Efectivo";
const MES = 9;
const ANIO = 2099;

const CALC = {
  sueldo_base: SENTINEL, descuento_ausencias: 0, total_horas_extras: 0, total_dobles: 0,
  total_feriados: 0, total_vacaciones: 0, subtotal1: SENTINEL, monto_presentismo: 0,
  subtotal2: SENTINEL, adelantos: 0, total_a_pagar: SENTINEL, efectivo: SENTINEL, transferencia: 0,
};

test.describe("Sueldo re-pago tras anular — mutante (revivir liquidación anulada)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let empId: string;
  let novId: string | null = null;
  let liqId: string | null = null;
  let movIds: string[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locales } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;
    const { data: emps } = await db.from("rrhh_empleados")
      .select("id, sueldo_mensual").eq("apellido", APELLIDO).eq("nombre", NOMBRE).eq("local_id", localId);
    if (!emps || emps.length !== 1) throw new Error(`Empleado "${APELLIDO},${NOMBRE}" no único en ${LOCAL}`);
    empId = emps[0].id as string;
    if (emps[0].sueldo_mensual !== SENTINEL) throw new Error(`sueldo_mensual != ${SENTINEL}`);

    // Limpieza idempotente de la novedad del mes test + sus liquidaciones/movs.
    const { data: prevN } = await db.from("rrhh_novedades").select("id").eq("empleado_id", empId).eq("mes", MES).eq("anio", ANIO);
    for (const n of prevN || []) {
      const { data: prevL } = await db.from("rrhh_liquidaciones").select("id").eq("novedad_id", n.id as string);
      for (const l of prevL || []) {
        await db.from("movimientos").delete().eq("liquidacion_id", l.id as string);
        await db.from("rrhh_liquidaciones").delete().eq("id", l.id as string);
      }
      await db.from("rrhh_novedades").delete().eq("id", n.id as string);
    }
    novId = null; liqId = null; movIds = [];
  });

  test.afterEach(async () => {
    for (const m of movIds) {
      try { await db.rpc("anular_movimiento", { p_mov_id: m, p_motivo: "e2e cleanup" }); } catch { /* */ }
      try { await db.from("movimientos").delete().eq("id", m); } catch { /* */ }
    }
    if (novId) {
      const { data: liqs } = await db.from("rrhh_liquidaciones").select("id").eq("novedad_id", novId);
      for (const l of liqs || []) {
        try { await db.from("movimientos").delete().eq("liquidacion_id", l.id as string); } catch { /* */ }
        try { await db.from("rrhh_liquidaciones").delete().eq("id", l.id as string); } catch { /* */ }
      }
      try { await db.from("rrhh_novedades").delete().eq("id", novId); } catch { /* */ }
    }
    try { await db.auth.signOut(); } catch { /* */ }
  });

  test("anular un pago de sueldo y re-pagar la misma quincena NO tira LIQUIDACION_ANULADA", async () => {
    // 1. Novedad confirmada (presentismo PIERDE -> total = SENTINEL).
    const { data: novIns } = await db.from("rrhh_novedades").insert([{
      empleado_id: empId, mes: MES, anio: ANIO, inasistencias: 0, presentismo: "PIERDE",
      horas_extras: 0, dobles: 0, feriados: 0, vacaciones_dias: 0, otros_descuentos: 0,
      observaciones: "", estado: "confirmado", tenant_id: tenantId,
    }]).select();
    novId = novIns![0]!.id as string;

    // 2. Pagar el sueldo (crea la liquidación).
    const { data: r1, error: e1 } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId, p_formas_pago: [{ cuenta: CUENTA, monto: SENTINEL }],
      p_adelantos_ids: null, p_fecha: `${ANIO}-09-05`, p_mes: MES, p_anio: ANIO,
      p_crear_liq: true, p_calc: CALC, p_idempotency_key: null,
    });
    expect(e1).toBeNull();
    liqId = (r1 as { liquidacion_id: string }).liquidacion_id;
    const movs1 = ((r1 as { mov_ids: string[] }).mov_ids) || [];
    expect((r1 as { completa: boolean }).completa).toBe(true);
    expect(movs1.length).toBeGreaterThan(0);

    // 3. Anular el/los movimiento(s) del pago -> la liquidación queda anulada.
    for (const m of movs1) {
      const { error: ae } = await db.rpc("anular_movimiento", { p_mov_id: m, p_motivo: "cambio formas de pago" });
      expect(ae).toBeNull();
    }
    const { data: liqAnul } = await db.from("rrhh_liquidaciones").select("anulado, estado, pagos_realizados").eq("id", liqId).single();
    expect(liqAnul!.anulado).toBe(true);
    expect(Number(liqAnul!.pagos_realizados)).toBe(0);

    // 4. ★ CLAVE: re-pagar la MISMA novedad/cuota. Antes -> LIQUIDACION_ANULADA.
    const { data: r2, error: e2 } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId, p_formas_pago: [{ cuenta: CUENTA, monto: SENTINEL }],
      p_adelantos_ids: null, p_fecha: `${ANIO}-09-06`, p_mes: MES, p_anio: ANIO,
      p_crear_liq: true, p_calc: CALC, p_idempotency_key: null,
    });
    expect(e2).toBeNull();
    expect((r2 as { completa: boolean }).completa).toBe(true);
    expect((r2 as { liquidacion_id: string }).liquidacion_id).toBe(liqId); // reusó la misma fila
    movIds = ((r2 as { mov_ids: string[] }).mov_ids) || [];
    expect(movIds.length).toBeGreaterThan(0);

    // 5. La liquidación quedó revivida y pagada con los valores nuevos.
    const { data: liqFinal } = await db.from("rrhh_liquidaciones").select("anulado, estado, pagos_realizados").eq("id", liqId).single();
    expect(liqFinal!.anulado).toBe(false);
    expect(liqFinal!.estado).toBe("pagado");
    expect(Number(liqFinal!.pagos_realizados)).toBe(SENTINEL);
  });
});
