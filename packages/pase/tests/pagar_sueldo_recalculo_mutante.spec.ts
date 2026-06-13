import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";
import {
  calcularTotalLiquidacion,
  type LiquidacionParams,
} from "../src/lib/calculos/rrhh";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: VALIDACIÓN SERVER-SIDE de pagar_sueldo (Tier 2, ítem 8).
// Migración 202606130400.
//
// Hoy `pagar_sueldo` recibía el desglose YA calculado por el navegador
// (`p_calc`) y lo guardaba tal cual. Un bug de JS escribía plata mal en
// silencio, y con multi-tenant cualquier usuario autenticado podía llamar la
// RPC con números inventados (tamper). El fix: la RPC recalcula el total
// canónico server-side (`fn_liquidacion_total_canonico`), RECHAZA si el
// total_a_pagar del cliente difiere >$1 con `LIQUIDACION_CALCULO_INCONSISTENTE`,
// y GUARDA los componentes recalculados (no los del cliente).
//
// Escenarios:
//   1. SQL == TS: para una batería de casos (mensual, hs negativas, Q1/Q2
//      quincenal, bono+otros, presentismo PIERDE vs PIERDE_LLEGADAS, con
//      adelanto), `fn_liquidacion_total_canonico` debe devolver EXACTAMENTE
//      lo mismo que `calcularTotalLiquidacion` de lib/calculos/rrhh.ts. Este
//      es el juez del espejo (si difieren → bug en la migración).
//   2. Pago normal OK: pagar_sueldo con p_calc correcto crea la liquidación
//      con el total canónico y los movimientos.
//   3. TAMPER rechazado: p_calc.total_a_pagar inflado +50.000 →
//      LIQUIDACION_CALCULO_INCONSISTENTE, y NO se crea liquidación ni mov.
//   4. Sobrepago de redondeo OK: total canónico correcto pero la suma de
//      formas_pago excede el total → NO rechaza, pagos_realizados sin capeo.
//
// DB-only (llama RPCs directo, sin UI). Reusa el seed "Empleado Prueba" en
// "Local Prueba 2". Meses 11/12/6 (fuera del rango productivo y distintos de
// los otros tests de sueldo: 1,2,3,7,8,9,10). ANIO 2099.
// ─────────────────────────────────────────────────────────────────────────

const SENTINEL_SUELDO = 567890; // sueldo_mensual del Empleado Prueba seed
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const CUENTA = "Caja Efectivo";
const ANIO = 2099;

// Mes dedicado a cada bloque para no chocar con los otros tests de sueldo.
const MES_SQLTS = 6;   // Junio — los casos del escenario 1 se crean/borran inline
const MES_PAGO = 11;   // Noviembre — escenario 2
const MES_TAMPER = 12; // Diciembre — escenario 3 (sin pago efectivo, DB queda limpia)
const MES_SOBREPAGO = 5; // Mayo — escenario 4

// Cómo TabSueldos arma los params de calcularTotalLiquidacion a partir de la
// novedad + sueldo del empleado (ver TabSueldos.tsx::calcularDesglose):
//   modo_pago = cuotas_total === 2 ? "QUINCENAL" : "MENSUAL"
//   valor_doble = sueldo / 30
//   presentismo_mantiene = presentismo !== "PIERDE"
//   pagos_dobles_realizados = 0 (siempre)
function tsParams(opts: {
  sueldo: number;
  inasistencias?: number;
  horas_extras?: number;
  dobles?: number;
  feriados?: number;
  vacaciones_dias?: number;
  presentismo?: string | null;
  otros_descuentos?: number;
  bono?: number;
  adelantos?: number;
  cuota_num?: number;
  cuotas_total?: number;
}): LiquidacionParams {
  const cuotas_total = opts.cuotas_total ?? 1;
  return {
    sueldo_mensual: opts.sueldo,
    modo_pago: cuotas_total === 2 ? "QUINCENAL" : "MENSUAL",
    inasistencias: opts.inasistencias ?? 0,
    horas_extras: opts.horas_extras ?? 0,
    dobles: opts.dobles ?? 0,
    valor_doble: opts.sueldo / 30,
    feriados: opts.feriados ?? 0,
    vacaciones_dias: opts.vacaciones_dias ?? 0,
    presentismo_mantiene: (opts.presentismo ?? "PIERDE") !== "PIERDE",
    adelantos: opts.adelantos ?? 0,
    pagos_dobles_realizados: 0,
    otros_descuentos: opts.otros_descuentos ?? 0,
    bono: opts.bono ?? 0,
    cuota_num: opts.cuota_num,
    cuotas_total,
  };
}

test.describe("pagar_sueldo recálculo server-side — mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let empId: string;
  let saldoCajaInicial = 0;
  let aguinaldoInicial = 0;

  // Trackers por test (cleanup en afterEach).
  let createdNovIds: string[] = [];
  let createdAdelantoIds: string[] = [];
  let createdLiqIds: string[] = [];
  let createdMovIds: string[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();
    createdNovIds = [];
    createdAdelantoIds = [];
    createdLiqIds = [];
    createdMovIds = [];

    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales "${LOCAL}" — desambiguar`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    const { data: emps, error: empErr } = await db
      .from("rrhh_empleados").select("id, sueldo_mensual, aguinaldo_acumulado")
      .eq("apellido", APELLIDO).eq("nombre", NOMBRE).eq("local_id", localId);
    if (empErr) throw new Error(`Error consultando empleados: ${empErr.message}`);
    if (!emps || emps.length === 0) {
      throw new Error(
        `Falta empleado "${APELLIDO}, ${NOMBRE}" en ${LOCAL} (id=${localId}). Crearlo con:\n` +
        `INSERT INTO rrhh_empleados (apellido, nombre, local_id, tenant_id, sueldo_mensual, puesto, activo, fecha_inicio, alias_mp, aguinaldo_acumulado, vacaciones_dias_acumulados) ` +
        `VALUES ('${APELLIDO}', '${NOMBRE}', ${localId}, '${tenantId}', ${SENTINEL_SUELDO}, 'Test', true, '2099-01-01', NULL, 0, 0);`
      );
    }
    if (emps.length > 1) throw new Error(`Hay ${emps.length} empleados "${APELLIDO} ${NOMBRE}" — desambiguar`);
    empId = emps[0]!.id as string;
    if (emps[0]!.sueldo_mensual !== SENTINEL_SUELDO) {
      throw new Error(
        `Empleado Prueba tiene sueldo_mensual=${emps[0]!.sueldo_mensual}, esperado ${SENTINEL_SUELDO}. Update con:\n` +
        `UPDATE rrhh_empleados SET sueldo_mensual=${SENTINEL_SUELDO} WHERE id='${empId}';`
      );
    }
    aguinaldoInicial = Number(emps[0]!.aguinaldo_acumulado ?? 0);

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
    saldoCajaInicial = Number(saldoRow.saldo);

    // Limpieza idempotente de los meses que tocamos.
    for (const mes of [MES_SQLTS, MES_PAGO, MES_TAMPER, MES_SOBREPAGO]) {
      const { data: prevNovs } = await db.from("rrhh_novedades")
        .select("id").eq("empleado_id", empId).eq("mes", mes).eq("anio", ANIO);
      const prevNovIds = (prevNovs || []).map(n => n.id as string);
      if (prevNovIds.length > 0) {
        const { data: prevLiqs } = await db.from("rrhh_liquidaciones")
          .select("id").in("novedad_id", prevNovIds);
        const prevLiqIds = (prevLiqs || []).map(l => l.id as string);
        if (prevLiqIds.length > 0) {
          await db.from("rrhh_adelantos")
            .update({ descontado: false, liquidacion_consumidora_id: null })
            .in("liquidacion_consumidora_id", prevLiqIds);
          await db.from("movimientos").delete().in("liquidacion_id", prevLiqIds);
          await db.from("rrhh_liquidaciones").delete().in("id", prevLiqIds);
        }
        await db.from("rrhh_novedades").delete().in("id", prevNovIds);
      }
    }
    // Adelantos sueltos sin descontar del empleado de test.
    await db.from("rrhh_adelantos").delete().eq("empleado_id", empId).eq("descontado", false);
  });

  test.afterEach(async () => {
    // Cleanup forzado en orden inverso. Cada step en su propio try/catch.
    for (const movId of createdMovIds) {
      try { await db.from("movimientos").delete().eq("id", movId); }
      catch (e) { console.error("[cleanup] mov:", e); }
    }
    for (const liqId of createdLiqIds) {
      try {
        await db.from("rrhh_adelantos").update({ liquidacion_consumidora_id: null })
          .eq("liquidacion_consumidora_id", liqId);
      } catch (e) { console.error("[cleanup] unlink adelantos:", e); }
      try { await db.from("rrhh_liquidaciones").delete().eq("id", liqId); }
      catch (e) { console.error("[cleanup] liq:", e); }
    }
    for (const adelId of createdAdelantoIds) {
      try { await db.from("rrhh_adelantos").delete().eq("id", adelId); }
      catch (e) { console.error("[cleanup] adelanto:", e); }
    }
    for (const novId of createdNovIds) {
      try { await db.from("rrhh_novedades").delete().eq("id", novId); }
      catch (e) { console.error("[cleanup] nov:", e); }
    }
    // Reset aguinaldo + saldo a los valores iniciales (por si un test rompió a mitad).
    try {
      await db.from("rrhh_empleados").update({ aguinaldo_acumulado: aguinaldoInicial }).eq("id", empId);
    } catch (e) { console.error("[cleanup] aguinaldo reset:", e); }
    try {
      await db.from("saldos_caja").update({ saldo: saldoCajaInicial })
        .eq("cuenta", CUENTA).eq("local_id", localId);
    } catch (e) { console.error("[cleanup] saldo reset:", e); }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  // Crea una novedad confirmada y la trackea para cleanup.
  async function crearNovedad(mes: number, n: {
    inasistencias?: number;
    horas_extras?: number;
    dobles?: number;
    feriados?: number;
    vacaciones_dias?: number;
    presentismo?: string;
    otros_descuentos?: number;
    bono?: number;
    cuota_num?: number;
    cuotas_total?: number;
  }): Promise<string> {
    const row: Record<string, unknown> = {
      empleado_id: empId, mes, anio: ANIO,
      inasistencias: n.inasistencias ?? 0,
      // "__NULL__" es un marcador del test para insertar SQL NULL (no se puede
      // insertar PIERDE_LLEGADAS desde 202605142200; NULL ejercita la misma
      // rama "mantiene" del espejo: presentismo IS DISTINCT FROM 'PIERDE').
      presentismo: n.presentismo === "__NULL__" ? null : (n.presentismo ?? "PIERDE"),
      horas_extras: n.horas_extras ?? 0,
      dobles: n.dobles ?? 0,
      pagos_dobles_realizados: 0,
      feriados: n.feriados ?? 0,
      adelantos: 0,
      vacaciones_dias: n.vacaciones_dias ?? 0,
      otros_descuentos: n.otros_descuentos ?? 0,
      bono: n.bono ?? 0,
      observaciones: "", estado: "confirmado", tenant_id: tenantId,
    };
    if (n.cuota_num != null) row.cuota_num = n.cuota_num;
    if (n.cuotas_total != null) row.cuotas_total = n.cuotas_total;
    const { data, error } = await db.from("rrhh_novedades").insert([row]).select();
    if (error) throw new Error(`Insert novedad: ${error.message}`);
    const id = data![0]!.id as string;
    createdNovIds.push(id);
    return id;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Escenario 1: SQL == TS (el assert más importante — juez del espejo).
  // ───────────────────────────────────────────────────────────────────────
  test("fn_liquidacion_total_canonico == calcularTotalLiquidacion (batería)", async () => {
    const ADELANTO = 50000;

    // (g) adelanto tildado: creamos un adelanto y pasamos su id.
    const { data: adelIns, error: adelErr } = await db.from("rrhh_adelantos").insert([{
      empleado_id: empId, monto: ADELANTO, fecha: `${ANIO}-06-15`,
      local_id: localId, cuenta: CUENTA, descontado: false, tenant_id: tenantId,
    }]).select();
    if (adelErr) throw new Error(`Insert adelanto: ${adelErr.message}`);
    const adelantoId = adelIns![0]!.id as string;
    createdAdelantoIds.push(adelantoId);

    interface Caso {
      nombre: string;
      nov: Parameters<typeof crearNovedad>[1];
      adelantos_ids: string[];
      ts_adelantos: number;
    }
    const casos: Caso[] = [
      {
        nombre: "(a) mensual normal",
        nov: { presentismo: "MANTIENE" },
        adelantos_ids: [], ts_adelantos: 0,
      },
      {
        nombre: "(b) hs_extra NEGATIVA (-5)",
        nov: { horas_extras: -5, presentismo: "PIERDE" },
        adelantos_ids: [], ts_adelantos: 0,
      },
      {
        nombre: "(c) quincenal Q1 (cuotas_total=2, cuota_num=1 → presentismo 0)",
        nov: { cuotas_total: 2, cuota_num: 1, presentismo: "MANTIENE" },
        adelantos_ids: [], ts_adelantos: 0,
      },
      {
        nombre: "(d) quincenal Q2 (cuota_num=2 → presentismo aplica)",
        nov: { cuotas_total: 2, cuota_num: 2, presentismo: "MANTIENE" },
        adelantos_ids: [], ts_adelantos: 0,
      },
      {
        nombre: "(e) bono + otros_descuentos > 0",
        nov: { bono: 30000, otros_descuentos: 12500, presentismo: "MANTIENE" },
        adelantos_ids: [], ts_adelantos: 0,
      },
      {
        nombre: "(f1) presentismo PIERDE → 0",
        nov: { presentismo: "PIERDE" },
        adelantos_ids: [], ts_adelantos: 0,
      },
      {
        // El check constraint de rrhh_novedades (202605142200) ya solo admite
        // MANTIENE/PIERDE — PIERDE_LLEGADAS no se puede insertar. Pero la lógica
        // del espejo es `presentismo IS DISTINCT FROM 'PIERDE'`, así que NULL
        // también "mantiene" el 5%. Probamos esa rama (NULL → mantiene).
        nombre: "(f2) presentismo NULL → mantiene 5% (IS DISTINCT FROM 'PIERDE')",
        nov: { presentismo: "__NULL__" },
        adelantos_ids: [], ts_adelantos: 0,
      },
      {
        nombre: "(g) con adelanto tildado",
        nov: { presentismo: "MANTIENE", feriados: 2, horas_extras: 3 },
        adelantos_ids: [adelantoId], ts_adelantos: ADELANTO,
      },
    ];

    const failures: string[] = [];

    for (const caso of casos) {
      const novId = await crearNovedad(MES_SQLTS, caso.nov);

      const { data: sql, error: sqlErr } = await db.rpc("fn_liquidacion_total_canonico", {
        p_nov_id: novId,
        p_adelantos_ids: caso.adelantos_ids,
      });
      expect(sqlErr, `[${caso.nombre}] RPC error: ${sqlErr?.message}`).toBeNull();
      expect(sql, `[${caso.nombre}] SQL devolvió null`).toBeTruthy();

      const ts = calcularTotalLiquidacion(tsParams({
        sueldo: SENTINEL_SUELDO,
        inasistencias: caso.nov.inasistencias,
        horas_extras: caso.nov.horas_extras,
        dobles: caso.nov.dobles,
        feriados: caso.nov.feriados,
        vacaciones_dias: caso.nov.vacaciones_dias,
        presentismo: caso.nov.presentismo,
        otros_descuentos: caso.nov.otros_descuentos,
        bono: caso.nov.bono,
        adelantos: caso.ts_adelantos,
        cuota_num: caso.nov.cuota_num,
        cuotas_total: caso.nov.cuotas_total,
      }));

      const s = sql as Record<string, string>;
      // total_a_pagar: ambos ya redondeados (TS Math.round; SQL round() + clamp 0).
      // El cliente envía Math.max(0, total) (TabSueldos), así que comparamos
      // SQL (clampeado) contra max(0, ts).
      const sqlTotal = Number(s.total_a_pagar);
      const tsTotal = Math.max(0, ts.total_a_pagar);
      if (sqlTotal !== tsTotal) {
        failures.push(`${caso.nombre}: total_a_pagar SQL=${sqlTotal} TS=${tsTotal}`);
      }

      // Componentes clave: SQL los devuelve round()-eados; TS los devuelve
      // crudos → comparamos contra Math.round(ts.<campo>) (es lo que el cliente
      // manda y la migración guarda).
      const componentes: Array<[string, number]> = [
        ["sueldo_base", ts.sueldo_base],
        ["descuento_ausencias", ts.descuento_ausencias],
        ["total_horas_extras", ts.total_horas_extras],
        ["total_dobles", ts.total_dobles],
        ["total_feriados", ts.total_feriados],
        ["total_vacaciones", ts.total_vacaciones],
        ["subtotal1", ts.subtotal1],
        ["monto_presentismo", ts.monto_presentismo],
        ["subtotal2", ts.subtotal2],
        ["adelantos", ts.adelantos],
        ["otros_descuentos", ts.otros_descuentos],
        ["bono", ts.bono],
      ];
      for (const [campo, tsVal] of componentes) {
        const sqlVal = Number(s[campo]);
        const tsRounded = Math.round(tsVal);
        if (sqlVal !== tsRounded) {
          failures.push(`${caso.nombre}: ${campo} SQL=${sqlVal} TS(round)=${tsRounded}`);
        }
      }

      // Limpieza inline de la novedad de este caso (mismo mes para todos).
      await db.from("rrhh_novedades").delete().eq("id", novId);
      createdNovIds = createdNovIds.filter(id => id !== novId);
    }

    expect(failures, `SQL≠TS en:\n${failures.join("\n")}`).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Escenario 2: Pago normal con p_calc correcto → liquidación + movimientos.
  // ───────────────────────────────────────────────────────────────────────
  test("pago normal con p_calc canónico → liquidación creada con total canónico", async () => {
    const novId = await crearNovedad(MES_PAGO, { presentismo: "MANTIENE" });

    // El total canónico (con presentismo 5%) lo calculamos con TS — y se lo
    // pasamos a la RPC como p_calc (lo que haría el cliente bien comportado).
    const ts = calcularTotalLiquidacion(tsParams({ sueldo: SENTINEL_SUELDO, presentismo: "MANTIENE" }));
    const totalCanonico = Math.max(0, ts.total_a_pagar);

    const pCalc = {
      sueldo_base: ts.sueldo_base, descuento_ausencias: ts.descuento_ausencias,
      total_horas_extras: ts.total_horas_extras, total_dobles: ts.total_dobles,
      total_feriados: ts.total_feriados, total_vacaciones: ts.total_vacaciones,
      subtotal1: ts.subtotal1, monto_presentismo: ts.monto_presentismo,
      subtotal2: ts.subtotal2, adelantos: 0,
      total_a_pagar: totalCanonico, efectivo: totalCanonico, transferencia: 0,
    };

    const { data: r, error: e } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId,
      p_formas_pago: [{ cuenta: CUENTA, monto: totalCanonico }],
      p_adelantos_ids: [],
      p_fecha: `${ANIO}-${String(MES_PAGO).padStart(2, "0")}-30`,
      p_mes: MES_PAGO, p_anio: ANIO, p_crear_liq: true, p_calc: pCalc,
    });
    expect(e).toBeNull();
    const liqId = (r as { liquidacion_id: string }).liquidacion_id;
    const movIds = (r as { mov_ids: string[] }).mov_ids;
    createdLiqIds.push(liqId);
    if (movIds?.[0]) createdMovIds.push(movIds[0]);

    expect((r as { completa: boolean }).completa).toBe(true);

    // La liquidación guarda el total CANÓNICO recalculado server-side.
    const { data: liq } = await db.from("rrhh_liquidaciones")
      .select("estado, pagos_realizados, total_a_pagar, subtotal2, monto_presentismo, anulado")
      .eq("id", liqId).single();
    expect(liq?.estado).toBe("pagado");
    expect(Number(liq?.total_a_pagar)).toBe(totalCanonico);
    expect(Number(liq?.pagos_realizados)).toBe(totalCanonico);
    expect(Number(liq?.monto_presentismo)).toBe(Math.round(ts.monto_presentismo));
    expect(liq?.anulado).not.toBe(true);

    // Movimiento por el total.
    const { data: movs } = await db.from("movimientos")
      .select("importe, cat, cuenta").eq("liquidacion_id", liqId);
    expect(movs?.length).toBe(1);
    expect(Number(movs?.[0]?.importe)).toBe(-totalCanonico);
    expect(movs?.[0]?.cat).toBe("SUELDOS");
  });

  // ───────────────────────────────────────────────────────────────────────
  // Escenario 3: TAMPER rechazado (p_calc.total_a_pagar inflado +50.000).
  // ───────────────────────────────────────────────────────────────────────
  test("tamper: p_calc inflado +50.000 → LIQUIDACION_CALCULO_INCONSISTENTE, DB limpia", async () => {
    const novId = await crearNovedad(MES_TAMPER, { presentismo: "MANTIENE" });

    const ts = calcularTotalLiquidacion(tsParams({ sueldo: SENTINEL_SUELDO, presentismo: "MANTIENE" }));
    const totalCanonico = Math.max(0, ts.total_a_pagar);
    const totalInflado = totalCanonico + 50000;

    const pCalc = {
      sueldo_base: ts.sueldo_base, descuento_ausencias: ts.descuento_ausencias,
      total_horas_extras: ts.total_horas_extras, total_dobles: ts.total_dobles,
      total_feriados: ts.total_feriados, total_vacaciones: ts.total_vacaciones,
      subtotal1: ts.subtotal1, monto_presentismo: ts.monto_presentismo,
      subtotal2: ts.subtotal2, adelantos: 0,
      total_a_pagar: totalInflado, efectivo: totalInflado, transferencia: 0,
    };

    const { data: r, error: e } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId,
      p_formas_pago: [{ cuenta: CUENTA, monto: totalInflado }],
      p_adelantos_ids: [],
      p_fecha: `${ANIO}-${String(MES_TAMPER).padStart(2, "0")}-30`,
      p_mes: MES_TAMPER, p_anio: ANIO, p_crear_liq: true, p_calc: pCalc,
    });

    // La RPC DEBE rechazar.
    expect(r).toBeNull();
    expect(e).not.toBeNull();
    expect(e?.message).toContain("LIQUIDACION_CALCULO_INCONSISTENTE");

    // NO se creó liquidación para esa novedad…
    const { data: liqs } = await db.from("rrhh_liquidaciones").select("id").eq("novedad_id", novId);
    expect(liqs?.length ?? 0).toBe(0);

    // …ni movimientos de sueldo de ese mes.
    const { data: movs } = await db.from("movimientos")
      .select("id").eq("local_id", localId).eq("cat", "SUELDOS")
      .gte("fecha", `${ANIO}-${String(MES_TAMPER).padStart(2, "0")}-01`)
      .lte("fecha", `${ANIO}-${String(MES_TAMPER).padStart(2, "0")}-31`);
    expect(movs?.length ?? 0).toBe(0);

    // …y el saldo de caja quedó intacto.
    const { data: saldo } = await db.from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).single();
    expect(Number(saldo?.saldo)).toBe(saldoCajaInicial);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Escenario 4: Sobrepago de redondeo OK (p_calc correcto, suma pagada > total).
  // La validación es sobre total_a_pagar canónico, NO sobre el monto pagado.
  // ───────────────────────────────────────────────────────────────────────
  test("sobrepago de redondeo: p_calc correcto pero suma pagada > total → NO rechaza, sin capeo", async () => {
    // presentismo PIERDE → total = sueldo_base exacto = SENTINEL_SUELDO (entero).
    const novId = await crearNovedad(MES_SOBREPAGO, { presentismo: "PIERDE" });

    const ts = calcularTotalLiquidacion(tsParams({ sueldo: SENTINEL_SUELDO, presentismo: "PIERDE" }));
    const totalCanonico = Math.max(0, ts.total_a_pagar); // = SENTINEL_SUELDO
    expect(totalCanonico).toBe(SENTINEL_SUELDO); // sanity del sentinel
    const EXTRA = 213; // redondeo: se paga de más
    const pagado = totalCanonico + EXTRA;

    const pCalc = {
      sueldo_base: ts.sueldo_base, descuento_ausencias: 0, total_horas_extras: 0,
      total_dobles: 0, total_feriados: 0, total_vacaciones: 0,
      subtotal1: ts.subtotal1, monto_presentismo: 0, subtotal2: ts.subtotal2,
      adelantos: 0,
      total_a_pagar: totalCanonico, // ← CORRECTO (no inflado); solo la SUMA pagada excede
      efectivo: pagado, transferencia: 0,
    };

    const { data: r, error: e } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId,
      p_formas_pago: [{ cuenta: CUENTA, monto: pagado }],
      p_adelantos_ids: [],
      p_fecha: `${ANIO}-${String(MES_SOBREPAGO).padStart(2, "0")}-30`,
      p_mes: MES_SOBREPAGO, p_anio: ANIO, p_crear_liq: true, p_calc: pCalc,
    });

    // NO rechaza: el total canónico coincide, el sobrepago es a nivel pago.
    expect(e).toBeNull();
    const liqId = (r as { liquidacion_id: string }).liquidacion_id;
    const movIds = (r as { mov_ids: string[] }).mov_ids;
    createdLiqIds.push(liqId);
    if (movIds?.[0]) createdMovIds.push(movIds[0]);

    expect((r as { completa: boolean }).completa).toBe(true);
    expect((r as { sobrepago: number }).sobrepago).toBe(EXTRA);

    // pagos_realizados = monto REAL pagado (sin capeo); total_a_pagar = canónico.
    const { data: liq } = await db.from("rrhh_liquidaciones")
      .select("pagos_realizados, total_a_pagar, estado").eq("id", liqId).single();
    expect(liq?.estado).toBe("pagado");
    expect(Number(liq?.pagos_realizados)).toBe(pagado);          // ← sin capeo
    expect(Number(liq?.total_a_pagar)).toBe(totalCanonico);      // ← total canónico
  });
});
