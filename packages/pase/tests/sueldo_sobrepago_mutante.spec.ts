import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: PAGAR DE MÁS (redondeo para arriba) — Lucas 04-jun.
//
// La RPC pagar_sueldo, tras la migración 202606042100, ya NO capea
// pagos_realizados al total: guarda el MONTO REAL pagado (incluye el
// sobrepago de redondeo). El movimiento de caja sale por el monto real.
// El aguinaldo se sigue calculando sobre el sueldo real (total/12), NO
// sobre lo pagado de más.
//
// DB-only (llama la RPC directo, sin UI). Sentinel entero. Mes/año fuera de
// rango productivo. Reusa el seed "Empleado Prueba" en "Local Prueba 2".
// Mes 7 (Julio) para no colisionar con sueldo_pagar_mutante (Enero).
// ─────────────────────────────────────────────────────────────────────────
const SENTINEL = 567890;     // sueldo_mensual del Empleado Prueba
const EXTRA = 110;           // se paga de más (redondeo)
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const CUENTA = "Caja Efectivo";
const MES = 7;     // Julio (distinto de los otros tests de sueldo)
const ANIO = 2099;

test.describe("Sueldo — pagar de más (sobrepago) mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let empId: string;
  let saldoCajaInicial: number;
  let aguinaldoInicial: number;
  let novId: string | null = null;
  let liqId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales "${LOCAL}" — desambiguar`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: emps, error: empErr } = await db
      .from("rrhh_empleados").select("id, sueldo_mensual, alias_mp, aguinaldo_acumulado")
      .eq("apellido", APELLIDO).eq("nombre", NOMBRE).eq("local_id", localId);
    if (empErr) throw new Error(`Error consultando empleados: ${empErr.message}`);
    if (!emps || emps.length === 0) {
      throw new Error(
        `Falta empleado "${APELLIDO}, ${NOMBRE}" en Local Prueba 2 (id=${localId}). Crearlo con:\n` +
        `INSERT INTO rrhh_empleados (apellido, nombre, local_id, tenant_id, sueldo_mensual, puesto, activo, fecha_inicio, alias_mp, aguinaldo_acumulado, vacaciones_dias_acumulados) ` +
        `VALUES ('${APELLIDO}', '${NOMBRE}', ${localId}, '${tenantId}', ${SENTINEL}, 'Test', true, '2099-01-01', NULL, 0, 0);`
      );
    }
    if (emps.length > 1) throw new Error(`Hay ${emps.length} empleados "${APELLIDO} ${NOMBRE}" — desambiguar`);
    empId = emps[0].id as string;
    if (emps[0].sueldo_mensual !== SENTINEL) {
      throw new Error(
        `Empleado Prueba tiene sueldo_mensual=${emps[0].sueldo_mensual}, esperado ${SENTINEL}. Update con:\n` +
        `UPDATE rrhh_empleados SET sueldo_mensual=${SENTINEL} WHERE id='${empId}';`
      );
    }
    aguinaldoInicial = Number(emps[0].aguinaldo_acumulado ?? 0);

    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    if (saldoRow == null) {
      throw new Error(
        `Falta fila en saldos_caja (cuenta="${CUENTA}", local_id=${localId}). Crear con:\n` +
        `INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id) VALUES ('${CUENTA}', ${localId}, 0, '${tenantId}');`
      );
    }
    saldoCajaInicial = saldoRow.saldo as number;

    // Limpieza idempotente (mov → liq → nov).
    const { data: prevNovs } = await db.from("rrhh_novedades")
      .select("id").eq("empleado_id", empId).eq("mes", MES).eq("anio", ANIO);
    const prevNovIds = (prevNovs || []).map(n => n.id as string);
    if (prevNovIds.length > 0) {
      const { data: prevLiqs } = await db.from("rrhh_liquidaciones")
        .select("id").in("novedad_id", prevNovIds);
      const prevLiqIds = (prevLiqs || []).map(l => l.id as string);
      if (prevLiqIds.length > 0) {
        await db.from("movimientos").delete().in("liquidacion_id", prevLiqIds);
        await db.from("rrhh_liquidaciones").delete().in("id", prevLiqIds);
      }
      await db.from("rrhh_novedades").delete().in("id", prevNovIds);
    }

    // Novedad confirmada, presentismo PIERDE (sin bonus 5%) → total = SENTINEL.
    const { data: novIns, error: novErr } = await db.from("rrhh_novedades").insert([{
      empleado_id: empId, mes: MES, anio: ANIO,
      inasistencias: 0, presentismo: "PIERDE", horas_extras: 0, dobles: 0,
      pagos_dobles_realizados: 0, feriados: 0, adelantos: 0, vacaciones_dias: 0,
      observaciones: "", estado: "confirmado", tenant_id: tenantId,
    }]).select();
    if (novErr) throw new Error(`Error insertando novedad: ${novErr.message}`);
    novId = novIns![0]!.id as string;
    liqId = null;
    movId = null;
  });

  test.afterEach(async () => {
    // anular_movimiento revierte saldo + aguinaldo + marca liq.anulado.
    if (movId) {
      try {
        const { error } = await db.rpc("anular_movimiento", { p_mov_id: movId, p_motivo: "e2e mutante cleanup" });
        if (error && !error.message.includes("YA_ANULADO")) console.error(`[cleanup] anular_movimiento: ${error.message}`);
      } catch (e) { console.error(`[cleanup] anular_movimiento threw:`, e); }
    }
    if (movId) {
      try { await db.from("movimientos").delete().eq("id", movId); }
      catch (e) { console.error(`[cleanup] delete mov threw:`, e); }
    }
    if (liqId) {
      try { await db.from("rrhh_liquidaciones").delete().eq("id", liqId); }
      catch (e) { console.error(`[cleanup] delete liq threw:`, e); }
    }
    if (novId) {
      try { await db.from("rrhh_novedades").delete().eq("id", novId); }
      catch (e) { console.error(`[cleanup] delete nov threw:`, e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("pagar de más: pagos_realizados = monto real, caja real, aguinaldo sobre sueldo real", async () => {
    const pagado = SENTINEL + EXTRA;
    const pCalc = {
      sueldo_base: SENTINEL, descuento_ausencias: 0, total_horas_extras: 0,
      total_dobles: 0, total_feriados: 0, total_vacaciones: 0,
      subtotal1: SENTINEL, monto_presentismo: 0, subtotal2: SENTINEL,
      adelantos: 0, total_a_pagar: SENTINEL, efectivo: pagado, transferencia: 0,
    };
    // Se asigna en formas de pago MÁS que el total (redondeo para arriba).
    const formasPago = [{ cuenta: CUENTA, monto: pagado }];

    const { data: r, error: e } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId,
      p_formas_pago: formasPago,
      p_adelantos_ids: [],
      p_fecha: new Date().toISOString().slice(0, 10),
      p_mes: MES,
      p_anio: ANIO,
      p_crear_liq: true,
      p_calc: pCalc,
      p_idempotency_key: null,
    });
    expect(e).toBeNull();
    liqId = (r as { liquidacion_id: string }).liquidacion_id;
    const movIds = (r as { mov_ids: string[] }).mov_ids;
    if (movIds && movIds.length > 0) movId = movIds[0]!;

    // El resultado reporta el sobrepago y la liquidación completa.
    expect((r as { completa: boolean }).completa).toBe(true);
    expect((r as { sobrepago: number }).sobrepago).toBe(EXTRA);

    // ── Assert 1: liquidación pagada, pagos_realizados = MONTO REAL ──────
    // (sin capear al total). total_a_pagar queda en el sueldo real.
    const { data: liqs, error: liqErr } = await db
      .from("rrhh_liquidaciones")
      .select("estado, pagos_realizados, total_a_pagar, anulado")
      .eq("id", liqId);
    expect(liqErr).toBeNull();
    expect(liqs?.length).toBe(1);
    expect(liqs?.[0]?.estado).toBe("pagado");
    expect(Number(liqs?.[0]?.pagos_realizados)).toBe(pagado);     // ← clave: monto real, no SENTINEL
    expect(Number(liqs?.[0]?.total_a_pagar)).toBe(SENTINEL);
    expect(liqs?.[0]?.anulado).not.toBe(true);

    // ── Assert 2: movimiento por el monto REAL pagado ───────────────────
    const { data: movs, error: movErr } = await db.from("movimientos")
      .select("importe, cuenta, local_id, tipo, cat").eq("liquidacion_id", liqId);
    expect(movErr).toBeNull();
    expect(movs?.length).toBe(1);
    expect(Number(movs?.[0]?.importe)).toBe(-pagado);
    expect(movs?.[0]?.cuenta).toBe(CUENTA);
    expect(movs?.[0]?.local_id).toBe(localId);
    expect(movs?.[0]?.cat).toBe("SUELDOS");

    // ── Assert 3: saldos_caja bajó por el monto REAL pagado ─────────────
    const { data: saldoFinal } = await db.from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(Number(saldoFinal?.saldo)).toBe(saldoCajaInicial - pagado);

    // ── Assert 4: aguinaldo sumó sobre el SUELDO REAL (total/12), NO sobre
    //    lo pagado de más. delta = SENTINEL/12, no (SENTINEL+EXTRA)/12. ──
    const { data: empAfter } = await db.from("rrhh_empleados")
      .select("aguinaldo_acumulado").eq("id", empId).maybeSingle();
    const delta = Number(empAfter?.aguinaldo_acumulado ?? 0) - aguinaldoInicial;
    expect(delta).toBeCloseTo(SENTINEL / 12, 2);
    // Y NO el que incluiría el sobrepago:
    expect(delta).not.toBeCloseTo((SENTINEL + EXTRA) / 12, 2);
  });
});
