import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";
import { calcularLiquidacionFinal } from "../src/lib/calculos/rrhh";

// Test mutante: liquidación final por despido sin causa.
//
// El cálculo del monto vive en TS (src/lib/calculos/rrhh.ts) y se pasa a la
// RPC liquidacion_final_empleado como p_total. La RPC NO recalcula —
// acepta el monto y lo inserta. Si el frontend o la RPC tienen un bug en
// los efectos colaterales (empleado.activo, vacaciones=0, aguinaldo=0,
// fecha_egreso, motivo_baja, saldos_caja, rrhh_pagos_especiales,
// movimientos), este test lo detecta.
//
// Setup completo en beforeEach: crea un empleado dedicado con valores fijos
// para que la antigüedad y el total sean predecibles. Cleanup en afterEach
// borra todo lo creado.
//
// Bug huérfano (auditoría 2026-05-14): no había test mutante para
// liquidacion_final_empleado. Cualquier regresión en los efectos
// colaterales se descubría en producción con plata real (indemnización).

const SUELDO = 360000;          // divisible limpiamente por 30, 25, 12, 2
const FECHA_INICIO = "2094-01-15";
const FECHA_EGRESO = "2099-01-30";
const VAC_ACUM = 21;            // 5 años → 21 días/año LCT Art 150
const MOTIVO = "Despido sin causa";
const LOCAL = "Local Prueba 2";
const CUENTA = "Caja Efectivo";
const APELLIDO = "DespidoTest";
const NOMBRE = "Mutante";

test.describe("liquidacion_final_empleado — mutante DB-only", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let empId: string | null = null;
  let saldoCajaInicial = 0;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    // Local + tenant.
    const { data: locales } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length === 0) throw new Error(`Falta local "${LOCAL}"`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    // Saldo caja inicial.
    const { data: saldoRow } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (!saldoRow) throw new Error(`Falta saldos_caja(${CUENTA}, ${localId}).`);
    saldoCajaInicial = Number(saldoRow.saldo);

    // Cleanup idempotente: borrar empleados de test previos + pagos especiales.
    const { data: prevEmps } = await db.from("rrhh_empleados")
      .select("id").eq("apellido", APELLIDO).eq("nombre", NOMBRE);
    const prevEmpIds = (prevEmps || []).map(e => e.id as string);
    for (const id of prevEmpIds) {
      const { data: prevPagos } = await db.from("rrhh_pagos_especiales")
        .select("id").eq("empleado_id", id);
      const pagoIds = (prevPagos || []).map(p => p.id as string);
      if (pagoIds.length > 0) {
        await db.from("movimientos").delete().in("pago_especial_id_ref", pagoIds);
        await db.from("rrhh_pagos_especiales").delete().in("id", pagoIds);
      }
      await db.from("rrhh_empleados").delete().eq("id", id);
    }

    // Crear empleado seed con valores fijos.
    const { data: empIns, error: empErr } = await db.from("rrhh_empleados").insert([{
      apellido: APELLIDO, nombre: NOMBRE,
      local_id: localId, tenant_id: tenantId,
      sueldo_mensual: SUELDO, puesto: "Test",
      activo: true, fecha_inicio: FECHA_INICIO,
      alias_mp: null,
      aguinaldo_acumulado: 0,
      vacaciones_dias_acumulados: VAC_ACUM,
    }]).select();
    if (empErr) throw new Error(`Insert empleado: ${empErr.message}`);
    empId = empIns![0]!.id as string;
  });

  test.afterEach(async () => {
    if (empId) {
      try {
        const { data: pagos } = await db.from("rrhh_pagos_especiales")
          .select("id").eq("empleado_id", empId);
        const pagoIds = (pagos || []).map(p => p.id as string);
        if (pagoIds.length > 0) {
          await db.from("movimientos").delete().in("pago_especial_id_ref", pagoIds);
          await db.from("rrhh_pagos_especiales").delete().in("id", pagoIds);
        }
        await db.from("rrhh_empleados").delete().eq("id", empId);
      } catch (e) {
        console.error("[cleanup] empleado:", e);
      }
    }
    // Reset saldo caja al valor inicial (por si el test rompió mid-camino).
    try {
      await db.from("saldos_caja").update({ saldo: saldoCajaInicial })
        .eq("cuenta", CUENTA).eq("local_id", localId);
    } catch (e) {
      console.error("[cleanup] saldo:", e);
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("despido sin causa → RPC guarda monto y efectos colaterales", async () => {
    // ── 1. Calcular total con la fórmula TS (fuente de verdad UI) ────────
    const tsResult = calcularLiquidacionFinal({
      sueldo_mensual: SUELDO,
      fecha_inicio: FECHA_INICIO,
      fecha_egreso: FECHA_EGRESO,
      vacaciones_acumuladas: VAC_ACUM,
      motivo: MOTIVO,
    });
    const total = Math.round(tsResult.total);
    expect(total).toBeGreaterThan(0);

    // ── 2. Llamar la RPC con ese total ────────────────────────────────────
    const { data: payResult, error: payErr } = await db.rpc("liquidacion_final_empleado", {
      p_empleado_id: empId,
      p_fecha_egreso: FECHA_EGRESO,
      p_motivo: MOTIVO,
      p_total: total,
      p_cuenta: CUENTA,
    });
    expect(payErr).toBeNull();
    expect(payResult).toBeTruthy();
    const { pago_id: pagoId, mov_id: movId } = payResult as { pago_id: string; mov_id: string };
    expect(pagoId).toBeTruthy();
    expect(movId).toBeTruthy();

    // ── 3. Verificar rrhh_pagos_especiales ───────────────────────────────
    const { data: pago } = await db.from("rrhh_pagos_especiales")
      .select("monto, tipo, empleado_id").eq("id", pagoId).single();
    expect(Number(pago?.monto)).toBe(total);
    expect(pago?.tipo).toBe("liquidacion_final");
    expect(pago?.empleado_id).toBe(empId);

    // ── 4. Verificar movimiento ──────────────────────────────────────────
    const { data: mov } = await db.from("movimientos")
      .select("importe, cuenta, local_id, tipo, cat, pago_especial_id_ref").eq("id", movId).single();
    expect(Number(mov?.importe)).toBe(-total);
    expect(mov?.cuenta).toBe(CUENTA);
    expect(mov?.local_id).toBe(localId);
    expect(mov?.tipo).toBe("Liquidación Final");
    expect(mov?.cat).toBe("SUELDOS");
    expect(mov?.pago_especial_id_ref).toBe(pagoId);

    // ── 5. Verificar empleado: activo=false, fecha_egreso, motivo_baja, etc.
    const { data: emp } = await db.from("rrhh_empleados")
      .select("activo, fecha_egreso, motivo_baja, vacaciones_dias_acumulados, aguinaldo_acumulado")
      .eq("id", empId).single();
    expect(emp?.activo).toBe(false);
    expect(emp?.fecha_egreso).toBe(FECHA_EGRESO);
    expect(emp?.motivo_baja).toBe(MOTIVO);
    expect(Number(emp?.vacaciones_dias_acumulados)).toBe(0);
    expect(Number(emp?.aguinaldo_acumulado)).toBe(0);

    // ── 6. Verificar saldo caja: bajó por el total exacto ─────────────────
    const { data: saldo } = await db.from("saldos_caja")
      .select("saldo").eq("cuenta", CUENTA).eq("local_id", localId).single();
    expect(Number(saldo?.saldo)).toBe(saldoCajaInicial - total);

    // ── 7. LIQ_FINAL_YA_EXISTE: 2da llamada debe fallar ──────────────────
    const { error: dupErr } = await db.rpc("liquidacion_final_empleado", {
      p_empleado_id: empId,
      p_fecha_egreso: FECHA_EGRESO,
      p_motivo: MOTIVO,
      p_total: total,
      p_cuenta: CUENTA,
    });
    expect(dupErr).toBeTruthy();
    expect(dupErr?.message).toContain("LIQ_FINAL_YA_EXISTE");
  });
});
