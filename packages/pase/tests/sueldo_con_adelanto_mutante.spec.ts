import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: pagar un sueldo de un empleado CON adelanto tildado.
//
// Regresión del bug 04-jun: pagar_sueldo hacía `SELECT SUM(monto) ... FOR
// UPDATE`, y Postgres NO permite FOR UPDATE junto a un agregado → tiraba
// "FOR UPDATE is not allowed with aggregate functions" y NO se podía pagar a
// nadie con adelantos. Migración 202606042700 lo arregla (lock aparte + sum).
//
// DB-only. Mes 8 (Agosto) 2099 para no colisionar con otros tests de sueldo.
// ─────────────────────────────────────────────────────────────────────────
const SENTINEL = 567890;     // sueldo_mensual del Empleado Prueba
const ADELANTO = 5000;
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const CUENTA = "Caja Efectivo";
const MES = 8;
const ANIO = 2099;

test.describe("Sueldo con adelanto — mutante (FOR UPDATE fix)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let empId: string;
  let novId: string | null = null;
  let liqId: string | null = null;
  let movIds: string[] = [];
  let adelId: string | null = null;
  let adelMovId: string | null = null;

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

    // Limpieza idempotente de la novedad del mes test.
    const { data: prevN } = await db.from("rrhh_novedades").select("id").eq("empleado_id", empId).eq("mes", MES).eq("anio", ANIO);
    for (const n of prevN || []) {
      const { data: prevL } = await db.from("rrhh_liquidaciones").select("id").eq("novedad_id", n.id as string);
      for (const l of prevL || []) {
        await db.from("movimientos").delete().eq("liquidacion_id", l.id as string);
        await db.from("rrhh_liquidaciones").delete().eq("id", l.id as string);
      }
      await db.from("rrhh_novedades").delete().eq("id", n.id as string);
    }

    novId = null; liqId = null; movIds = []; adelId = null; adelMovId = null;
  });

  test.afterEach(async () => {
    // Anular movimientos del pago + del adelanto, borrar filas.
    for (const m of movIds) {
      try { await db.rpc("anular_movimiento", { p_mov_id: m, p_motivo: "e2e cleanup" }); } catch { /* */ }
      try { await db.from("movimientos").delete().eq("id", m); } catch { /* */ }
    }
    if (adelMovId) {
      try { await db.rpc("anular_movimiento", { p_mov_id: adelMovId, p_motivo: "e2e cleanup" }); } catch { /* */ }
      try { await db.from("movimientos").delete().eq("id", adelMovId); } catch { /* */ }
    }
    if (liqId) { try { await db.from("rrhh_liquidaciones").delete().eq("id", liqId); } catch { /* */ } }
    if (novId) { try { await db.from("rrhh_novedades").delete().eq("id", novId); } catch { /* */ } }
    if (adelId) { try { await db.from("rrhh_adelantos").delete().eq("id", adelId); } catch { /* */ } }
    try { await db.auth.signOut(); } catch { /* */ }
  });

  test("pagar con adelanto NO tira 'FOR UPDATE is not allowed' y descuenta el adelanto", async () => {
    // 1. Registrar un adelanto (crea adelanto + movimiento de caja).
    const { error: adErr } = await db.rpc("registrar_adelanto", {
      p_empleado_id: empId, p_monto: ADELANTO, p_cuenta: CUENTA,
      p_fecha: `${ANIO}-08-01`, p_detalle: "e2e adelanto test",
    });
    expect(adErr).toBeNull();
    const { data: adels } = await db.from("rrhh_adelantos")
      .select("id").eq("empleado_id", empId).eq("monto", ADELANTO).eq("descontado", false)
      .order("created_at", { ascending: false }).limit(1);
    expect(adels?.length).toBe(1);
    adelId = adels![0]!.id as string;
    const { data: adMovs } = await db.from("movimientos").select("id").eq("adelanto_id_ref", adelId);
    if (adMovs?.length) adelMovId = adMovs[0]!.id as string;

    // 2. Novedad confirmada (presentismo PIERDE → total = SENTINEL).
    const { data: novIns } = await db.from("rrhh_novedades").insert([{
      empleado_id: empId, mes: MES, anio: ANIO, inasistencias: 0, presentismo: "PIERDE",
      horas_extras: 0, dobles: 0, feriados: 0, vacaciones_dias: 0, otros_descuentos: 0,
      observaciones: "", estado: "confirmado", tenant_id: tenantId,
    }]).select();
    novId = novIns![0]!.id as string;

    // 3. Pagar con el adelanto tildado. Total = SENTINEL; efectivo = SENTINEL - ADELANTO.
    const pCalc = {
      sueldo_base: SENTINEL, descuento_ausencias: 0, total_horas_extras: 0, total_dobles: 0,
      total_feriados: 0, total_vacaciones: 0, subtotal1: SENTINEL, monto_presentismo: 0,
      subtotal2: SENTINEL, adelantos: ADELANTO, total_a_pagar: SENTINEL,
      efectivo: SENTINEL - ADELANTO, transferencia: 0,
    };
    const { data: r, error: payErr } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId,
      p_formas_pago: [{ cuenta: CUENTA, monto: SENTINEL - ADELANTO }],
      p_adelantos_ids: [adelId],
      p_fecha: `${ANIO}-08-05`, p_mes: MES, p_anio: ANIO,
      p_crear_liq: true, p_calc: pCalc, p_idempotency_key: null,
    });
    // ★ CLAVE: antes esto tiraba "FOR UPDATE is not allowed with aggregate functions".
    expect(payErr).toBeNull();
    liqId = (r as { liquidacion_id: string }).liquidacion_id;
    movIds = ((r as { mov_ids: string[] }).mov_ids) || [];
    expect((r as { completa: boolean }).completa).toBe(true);

    // El adelanto quedó descontado.
    const { data: adAfter } = await db.from("rrhh_adelantos").select("descontado").eq("id", adelId).single();
    expect(adAfter!.descontado).toBe(true);
  });
});
