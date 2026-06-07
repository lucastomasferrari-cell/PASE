import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: pagar una novedad de SEGUNDA quincena (cuota 2/2) que todavía
// no tiene liquidación → la liquidación creada debe HEREDAR la cuota de la
// novedad (2/2), no quedar hardcodeada en 1/1.
//
// Regresión del bug 07-jun: pagar_sueldo (única función que inserta en
// rrhh_liquidaciones) hardcodeaba cuota_num=1, cuotas_total=1 en su rama
// INSERT. Al pagar una Q2 sin liquidación previa, quedaba etiquetada 1/1 →
// recibos y movimientos con la quincena equivocada. Migración 202606071200
// la hace leer cuota_num/cuotas_total de la novedad.
//
// DB-only. Mes 10 (Octubre) 2099 para no colisionar con otros tests.
// ─────────────────────────────────────────────────────────────────────────
const SENTINEL = 567890;
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const CUENTA = "Caja Efectivo";
const MES = 10;
const ANIO = 2099;

// La Q2 paga la mitad del sueldo (quincena). El total acá es arbitrario para
// el test: lo importante es la cuota, no el monto.
const MITAD = Math.round(SENTINEL / 2);
const CALC = {
  sueldo_base: MITAD, descuento_ausencias: 0, total_horas_extras: 0, total_dobles: 0,
  total_feriados: 0, total_vacaciones: 0, subtotal1: MITAD, monto_presentismo: 0,
  subtotal2: MITAD, adelantos: 0, total_a_pagar: MITAD, efectivo: MITAD, transferencia: 0,
};

test.describe("Sueldo cuota real — mutante (liquidación hereda cuota de la novedad)", () => {
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
    if (liqId) { try { await db.from("rrhh_liquidaciones").delete().eq("id", liqId); } catch { /* */ } }
    if (novId) { try { await db.from("rrhh_novedades").delete().eq("id", novId); } catch { /* */ } }
    try { await db.auth.signOut(); } catch { /* */ }
  });

  test("pagar una Q2 sin liq previa → la liquidación creada queda cuota 2/2 (no 1/1)", async () => {
    // 1. Novedad confirmada de SEGUNDA quincena (cuota_num=2, cuotas_total=2).
    const { data: novIns, error: novErr } = await db.from("rrhh_novedades").insert([{
      empleado_id: empId, mes: MES, anio: ANIO, inasistencias: 0, presentismo: "PIERDE",
      horas_extras: 0, dobles: 0, feriados: 0, vacaciones_dias: 0, otros_descuentos: 0,
      observaciones: "", estado: "confirmado", tenant_id: tenantId,
      cuota_num: 2, cuotas_total: 2,
    }]).select();
    expect(novErr).toBeNull();
    novId = novIns![0]!.id as string;

    // 2. Pagar con crear_liq=true → pagar_sueldo INSERTA la liquidación.
    const { data: r, error: payErr } = await db.rpc("pagar_sueldo", {
      p_nov_id: novId,
      p_formas_pago: [{ cuenta: CUENTA, monto: MITAD }],
      p_adelantos_ids: null,
      p_fecha: `${ANIO}-10-20`, p_mes: MES, p_anio: ANIO,
      p_crear_liq: true, p_calc: CALC, p_idempotency_key: null,
    });
    expect(payErr).toBeNull();
    liqId = (r as { liquidacion_id: string }).liquidacion_id;
    movIds = ((r as { mov_ids: string[] }).mov_ids) || [];

    // ★ CLAVE: la liquidación creada hereda la cuota de la novedad (2/2),
    // antes quedaba hardcodeada 1/1.
    const { data: liq } = await db.from("rrhh_liquidaciones")
      .select("cuota_num, cuotas_total").eq("id", liqId).single();
    expect(liq!.cuota_num).toBe(2);
    expect(liq!.cuotas_total).toBe(2);

    // El resultado de la RPC también reporta la cuota correcta.
    expect((r as { cuota_num: number }).cuota_num).toBe(2);
    expect((r as { cuotas_total: number }).cuotas_total).toBe(2);

    // Y el detalle del movimiento lleva la etiqueta [Cuota 2/2].
    const { data: mov } = await db.from("movimientos")
      .select("detalle").eq("id", movIds[0]!).single();
    expect(mov!.detalle).toContain("[Cuota 2/2]");
  });
});
