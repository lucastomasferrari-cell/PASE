// ─────────────────────────────────────────────────────────────────────────
// E2E full — Test 35: hs extras negativas + sobrepago (redondeo) — Lucas 04-jun
//
// Cubre dos features nuevas vía service client (DB-only):
//
//  (A) Hs extras NEGATIVAS: la migración 202606042000 aflojó el CHECK
//      rrhh_novedades_no_negativos_ck para permitir horas_extras < 0 (ajuste
//      de horas). Verificamos que una novedad con horas_extras=-3 PERSISTE
//      (antes el constraint la rechazaba). El resto de columnas sigue >= 0.
//
//  (B) SOBREPAGO end-state: la migración 202606042100 destapó el cap de
//      pagar_sueldo → pagos_realizados guarda el monto REAL pagado. Acá lo
//      validamos por la vía del trigger _resync_liquidacion_pagos (que ya
//      computaba uncapped): un movimiento que excede el total deja
//      pagos_realizados = monto real y estado='pagado'. (La RPC con auth se
//      cubre en tests/sueldo_sobrepago_mutante.spec.ts.)
//
// No llamamos pagar_sueldo acá: usa auth_tenant_id() y el service client no
// tiene JWT de tenant (mismo motivo que el test 08).
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import {
  createServiceClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E full — Hs extras negativas + sobrepago", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    seed = loadSharedSeed();
  });

  test("(A) novedad con horas_extras negativas persiste (constraint aflojado)", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const empleado = seed.empleados.mensual;
    const anio = 2098; // aislado de otros tests RRHH (que usan el año actual)
    const mes = 4;

    const { data: nov, error: novErr } = await svc.from("rrhh_novedades").insert({
      tenant_id: seed.tenantId,
      empleado_id: empleado.id,
      mes, anio,
      inasistencias: 0,
      presentismo: "MANTIENE",
      dias_trabajados: 30,
      horas_extras: -3,           // ← NEGATIVO: antes el CHECK lo rechazaba
      dobles: 0, feriados: 0,
      adelantos: 0, vacaciones_dias: 0,
      estado: "confirmado",
      fecha_inicio_mes: `${anio}-${String(mes).padStart(2, "0")}-01`,
      cuota_num: 1, cuotas_total: 1,
    }).select("id, horas_extras").single();

    expect(novErr).toBeNull();
    expect(nov).not.toBeNull();
    expect(Number(nov!.horas_extras)).toBe(-3);

    // Sanity: un negativo en OTRA columna (ej. inasistencias) SIGUE rechazado.
    const { error: malErr } = await svc.from("rrhh_novedades").insert({
      tenant_id: seed.tenantId,
      empleado_id: empleado.id,
      mes: 5, anio,
      inasistencias: -1,          // ← debe violar el constraint
      presentismo: "MANTIENE",
      dias_trabajados: 30,
      horas_extras: 0, dobles: 0, feriados: 0,
      adelantos: 0, vacaciones_dias: 0,
      estado: "borrador",
      fecha_inicio_mes: `${anio}-05-01`,
      cuota_num: 1, cuotas_total: 1,
    }).select("id").single();
    expect(malErr).not.toBeNull(); // violación de rrhh_novedades_no_negativos_ck

    // Cleanup local de la fila válida.
    await svc.from("rrhh_novedades").delete().eq("id", nov!.id);
  });

  test("(B) sobrepago: movimiento > total → pagos_realizados real + pagado", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const empleado = seed.empleados.mensual;
    const anio = 2098;
    const mes = 6;
    const TOTAL = 100000;
    const EXTRA = 110;
    const PAGADO = TOTAL + EXTRA;

    const { data: nov, error: novErr } = await svc.from("rrhh_novedades").insert({
      tenant_id: seed.tenantId,
      empleado_id: empleado.id,
      mes, anio,
      inasistencias: 0, presentismo: "MANTIENE", dias_trabajados: 30,
      horas_extras: 0, dobles: 0, feriados: 0, adelantos: 0, vacaciones_dias: 0,
      estado: "confirmado",
      fecha_inicio_mes: `${anio}-${String(mes).padStart(2, "0")}-01`,
      cuota_num: 1, cuotas_total: 1,
    }).select("id").single();
    if (novErr) throw new Error(`Crear novedad: ${novErr.message}`);

    const { data: liq, error: liqErr } = await svc.from("rrhh_liquidaciones").insert({
      tenant_id: seed.tenantId,
      novedad_id: nov!.id,
      sueldo_base: TOTAL, descuento_ausencias: 0,
      total_horas_extras: 0, total_dobles: 0, total_feriados: 0, total_vacaciones: 0,
      subtotal1: TOTAL, monto_presentismo: 0, subtotal2: TOTAL,
      adelantos: 0, pagos_realizados: 0, total_a_pagar: TOTAL,
      efectivo: TOTAL, transferencia: 0, estado: "pendiente",
    }).select("id").single();
    if (liqErr) throw new Error(`Crear liquidación: ${liqErr.message}`);

    // Movimiento que paga DE MÁS (redondeo): -(TOTAL + EXTRA).
    const movId = `MOV-E2E35-${Date.now()}`;
    const { error: movErr } = await svc.from("movimientos").insert({
      id: movId,
      tenant_id: seed.tenantId,
      fecha: `${anio}-${String(mes).padStart(2, "0")}-10`,
      cuenta: "Caja Efectivo",
      tipo: "Pago Sueldo", cat: "SUELDOS",
      importe: -PAGADO,
      detalle: "E2E sobrepago redondeo",
      liquidacion_id: liq!.id,
      local_id: seed.local1Id,
    });
    if (movErr) throw new Error(`Insert mov: ${movErr.message}`);

    // El trigger deja pagos_realizados con el MONTO REAL (sin capear al total)
    // y estado='pagado' (pagado >= total).
    const { data: liqAfter } = await svc.from("rrhh_liquidaciones")
      .select("pagos_realizados, total_a_pagar, estado").eq("id", liq!.id).single();
    expect(Number(liqAfter!.pagos_realizados)).toBe(PAGADO);   // ← real, no capeado a TOTAL
    expect(Number(liqAfter!.total_a_pagar)).toBe(TOTAL);
    expect(liqAfter!.estado).toBe("pagado");

    // Cleanup.
    await svc.from("movimientos").delete().eq("id", movId);
    await svc.from("rrhh_liquidaciones").delete().eq("id", liq!.id);
    await svc.from("rrhh_novedades").delete().eq("id", nov!.id);
  });
});
