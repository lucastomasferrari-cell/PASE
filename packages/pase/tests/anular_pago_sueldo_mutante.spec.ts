import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: anular un pago de sueldo que incluyó un adelanto consumido
// debe revertir TODO atómicamente:
//   - movimiento.anulado = true
//   - saldos_caja: vuelve al valor pre-pago
//   - rrhh_liquidaciones: anulado=true, pagos_realizados=0, estado='pendiente'
//   - rrhh_adelantos: descontado=false, liquidacion_consumidora_id=NULL
//   - rrhh_empleados.aguinaldo_acumulado: revertido al valor pre-pago
//
// Bug corregido en migration 202605141800 (auditoría 2026-05-14): antes,
// anular_movimiento solo revertía saldos_caja + marcaba liq.anulado=true.
// Quedaba huérfano:
//   - adelanto consumido (descontado=true para siempre)
//   - aguinaldo inflado en el empleado
//
// El test es DB-only (no UI) — replica el escenario completo vía RPCs y
// verifica el estado final en DB. Sentinel valores enteros para evitar
// rounding.

const SENTINEL_SUELDO = 567890;       // sueldo_mensual del Empleado Prueba seed
const ADELANTO_MONTO = 50000;
const CASH_MONTO = SENTINEL_SUELDO - ADELANTO_MONTO; // 517890
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const CUENTA = "Caja Efectivo";
const MES = 3; // Marzo (sueldo_pagar_mutante usa MES=1, no chocan)
const ANIO = 2099;

test.describe("anular_movimiento de pago de sueldo — mutante completo", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let empId: string;
  let novId: string | null = null;
  let liqId: string | null = null;
  let movId: string | null = null;
  let adelantoId: string | null = null;
  let aguinaldoInicial: number = 0;
  let saldoCajaInicial: number = 0;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    // Resolver local + tenant.
    const { data: locales } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    // Empleado seed.
    const { data: emps } = await db
      .from("rrhh_empleados").select("id, sueldo_mensual, aguinaldo_acumulado, alias_mp")
      .eq("apellido", APELLIDO).eq("nombre", NOMBRE).eq("local_id", localId);
    if (!emps || emps.length === 0) {
      throw new Error(
        `Falta empleado "${APELLIDO}, ${NOMBRE}" en ${LOCAL}. Ver sueldo_pagar_mutante.spec.ts para el seed.`
      );
    }
    empId = emps[0]!.id as string;
    if (emps[0]!.sueldo_mensual !== SENTINEL_SUELDO) {
      throw new Error(`Empleado tiene sueldo_mensual=${emps[0]!.sueldo_mensual}, esperado ${SENTINEL_SUELDO}.`);
    }
    aguinaldoInicial = Number(emps[0]!.aguinaldo_acumulado ?? 0);

    // Saldo caja inicial.
    const { data: saldoRow } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (!saldoRow) {
      throw new Error(`Falta saldos_caja(${CUENTA}, ${localId}). Ver sueldo_pagar_mutante para el seed.`);
    }
    saldoCajaInicial = Number(saldoRow.saldo);

    // Cleanup idempotente: borrar novedad/liq/mov/adelantos previos del mes.
    const { data: prevNovs } = await db.from("rrhh_novedades")
      .select("id").eq("empleado_id", empId).eq("mes", MES).eq("anio", ANIO);
    const prevNovIds = (prevNovs || []).map(n => n.id as string);
    if (prevNovIds.length > 0) {
      const { data: prevLiqs } = await db.from("rrhh_liquidaciones")
        .select("id").in("novedad_id", prevNovIds);
      const prevLiqIds = (prevLiqs || []).map(l => l.id as string);
      if (prevLiqIds.length > 0) {
        // Limpiar adelantos consumidos por esas liqs (importante: dropear el
        // link antes del DELETE de la liq para no chocar con la FK).
        await db.from("rrhh_adelantos").update({ descontado: false, liquidacion_consumidora_id: null })
          .in("liquidacion_consumidora_id", prevLiqIds);
        await db.from("movimientos").delete().in("liquidacion_id", prevLiqIds);
        await db.from("rrhh_liquidaciones").delete().in("id", prevLiqIds);
      }
      await db.from("rrhh_novedades").delete().in("id", prevNovIds);
    }
    // Cleanup también de adelantos sueltos sin descontar del empleado de
    // test (para que el SELECT por adelanto_id sea inequívoco).
    await db.from("rrhh_adelantos").delete()
      .eq("empleado_id", empId).eq("descontado", false);

    // INSERT novedad confirmada para MES/ANIO. presentismo="PIERDE" para que
    // el total_a_pagar = sueldo_base exacto.
    const { data: novIns, error: novErr } = await db.from("rrhh_novedades").insert([{
      empleado_id: empId, mes: MES, anio: ANIO,
      inasistencias: 0, presentismo: "PIERDE",
      horas_extras: 0, dobles: 0, pagos_dobles_realizados: 0,
      feriados: 0, adelantos: 0, vacaciones_dias: 0,
      observaciones: "", estado: "confirmado", tenant_id: tenantId,
    }]).select();
    if (novErr) throw new Error(`Insert novedad: ${novErr.message}`);
    novId = novIns![0]!.id as string;

    // INSERT adelanto pendiente (descontado=false).
    const { data: adelIns, error: adelErr } = await db.from("rrhh_adelantos").insert([{
      empleado_id: empId, monto: ADELANTO_MONTO, fecha: `${ANIO}-${String(MES).padStart(2, "0")}-15`,
      local_id: localId, cuenta: CUENTA, descontado: false, tenant_id: tenantId,
    }]).select();
    if (adelErr) throw new Error(`Insert adelanto: ${adelErr.message}`);
    adelantoId = adelIns![0]!.id as string;

    liqId = null;
    movId = null;
  });

  test.afterEach(async () => {
    // Cleanup forzado en orden inverso. Cada step en su propio try/catch.
    if (movId) {
      try {
        await db.from("movimientos").delete().eq("id", movId);
      } catch (e) {
        console.error("[cleanup] mov:", e);
      }
    }
    if (liqId) {
      // Si el test no anuló, dropear el link de adelantos antes de borrar liq.
      try {
        await db.from("rrhh_adelantos").update({ liquidacion_consumidora_id: null })
          .eq("liquidacion_consumidora_id", liqId);
      } catch (e) {
        console.error("[cleanup] unlink adelantos:", e);
      }
      try {
        await db.from("rrhh_liquidaciones").delete().eq("id", liqId);
      } catch (e) {
        console.error("[cleanup] liq:", e);
      }
    }
    if (adelantoId) {
      try {
        await db.from("rrhh_adelantos").delete().eq("id", adelantoId);
      } catch (e) {
        console.error("[cleanup] adelanto:", e);
      }
    }
    if (novId) {
      try {
        await db.from("rrhh_novedades").delete().eq("id", novId);
      } catch (e) {
        console.error("[cleanup] nov:", e);
      }
    }
    // Reset aguinaldo al valor inicial (por si el test rompió a mitad).
    try {
      await db.from("rrhh_empleados").update({ aguinaldo_acumulado: aguinaldoInicial }).eq("id", empId);
    } catch (e) {
      console.error("[cleanup] aguinaldo reset:", e);
    }
    // Reset saldo caja al valor inicial.
    try {
      await db.from("saldos_caja").update({ saldo: saldoCajaInicial })
        .eq("cuenta", CUENTA).eq("local_id", localId);
    } catch (e) {
      console.error("[cleanup] saldo reset:", e);
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("pago completo con adelanto → anular → todo revertido", async () => {
    // ── 1. Pagar sueldo via RPC (DB-only, no UI). 100% efectivo. ─────────
    const pCalc = {
      sueldo_base: SENTINEL_SUELDO,
      descuento_ausencias: 0,
      total_horas_extras: 0,
      total_dobles: 0,
      total_feriados: 0,
      total_vacaciones: 0,
      subtotal1: SENTINEL_SUELDO,
      monto_presentismo: 0,
      subtotal2: SENTINEL_SUELDO,
      adelantos: ADELANTO_MONTO,
      total_a_pagar: SENTINEL_SUELDO,
      efectivo: CASH_MONTO,
      transferencia: 0,
    };
    const formasPago = [{ cuenta: CUENTA, monto: CASH_MONTO }];

    const { data: payResult, error: payErr } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId,
      p_formas_pago: formasPago,
      p_adelantos_ids: [adelantoId],
      p_fecha: `${ANIO}-${String(MES).padStart(2, "0")}-30`,
      p_mes: MES,
      p_anio: ANIO,
      p_crear_liq: true,
      p_calc: pCalc,
    });
    expect(payErr).toBeNull();
    expect(payResult).toBeTruthy();
    liqId = (payResult as { liquidacion_id: string }).liquidacion_id;
    movId = (payResult as { mov_ids: string[] }).mov_ids[0]!;
    expect(liqId).toBeTruthy();
    expect(movId).toBeTruthy();

    // ── 2. Verificar estado PRE-anulación ─────────────────────────────────
    const { data: preLiq } = await db.from("rrhh_liquidaciones")
      .select("estado, pagos_realizados, total_a_pagar, anulado").eq("id", liqId).single();
    expect(preLiq?.estado).toBe("pagado");
    expect(Number(preLiq?.pagos_realizados)).toBe(SENTINEL_SUELDO);
    expect(preLiq?.anulado).not.toBe(true);

    const { data: preMov } = await db.from("movimientos")
      .select("anulado, importe").eq("id", movId).single();
    expect(preMov?.anulado).not.toBe(true);
    expect(Number(preMov?.importe)).toBe(-CASH_MONTO);

    const { data: preAdelanto } = await db.from("rrhh_adelantos")
      .select("descontado, liquidacion_consumidora_id").eq("id", adelantoId).single();
    expect(preAdelanto?.descontado).toBe(true);
    expect(preAdelanto?.liquidacion_consumidora_id).toBe(liqId);

    const { data: preEmp } = await db.from("rrhh_empleados")
      .select("aguinaldo_acumulado").eq("id", empId).single();
    // total_a_pagar / 12.0 sumado al inicial. toBeCloseTo por floats.
    expect(Number(preEmp?.aguinaldo_acumulado))
      .toBeCloseTo(aguinaldoInicial + SENTINEL_SUELDO / 12.0, 2);

    const { data: preSaldo } = await db.from("saldos_caja")
      .select("saldo").eq("cuenta", CUENTA).eq("local_id", localId).single();
    expect(Number(preSaldo?.saldo)).toBe(saldoCajaInicial - CASH_MONTO);

    // ── 3. Anular el movimiento ──────────────────────────────────────────
    const { error: anErr } = await db.rpc("anular_movimiento", {
      p_mov_id: movId,
      p_motivo: "test mutante: anular pago",
    });
    expect(anErr).toBeNull();

    // ── 4. Verificar estado POST-anulación ────────────────────────────────
    const { data: postLiq } = await db.from("rrhh_liquidaciones")
      .select("estado, pagos_realizados, total_a_pagar, anulado, pagado_at, pagado_por").eq("id", liqId).single();
    expect(postLiq?.anulado).toBe(true);
    expect(Number(postLiq?.pagos_realizados)).toBe(0);
    expect(postLiq?.estado).toBe("pendiente");
    expect(postLiq?.pagado_at).toBeNull();
    expect(postLiq?.pagado_por).toBeNull();

    const { data: postMov } = await db.from("movimientos")
      .select("anulado").eq("id", movId).single();
    expect(postMov?.anulado).toBe(true);

    const { data: postAdelanto } = await db.from("rrhh_adelantos")
      .select("descontado, liquidacion_consumidora_id").eq("id", adelantoId).single();
    expect(postAdelanto?.descontado).toBe(false);
    expect(postAdelanto?.liquidacion_consumidora_id).toBeNull();

    const { data: postEmp } = await db.from("rrhh_empleados")
      .select("aguinaldo_acumulado").eq("id", empId).single();
    expect(Number(postEmp?.aguinaldo_acumulado)).toBeCloseTo(aguinaldoInicial, 2);

    const { data: postSaldo } = await db.from("saldos_caja")
      .select("saldo").eq("cuenta", CUENTA).eq("local_id", localId).single();
    expect(Number(postSaldo?.saldo)).toBe(saldoCajaInicial);
  });
});
