// ─────────────────────────────────────────────────────────────────────────
// E2E Sprint 3 (preview) — Test 08: trigger sync RRHH liquidaciones
//
// Testea la deuda C4-F15 que cerramos el 22-may noche (commit d0f67df):
// el trigger trg_sync_pagos_rrhh actualiza automáticamente
// rrhh_liquidaciones.pagos_realizados cuando se INSERT/UPDATE/DELETE en
// movimientos linkeados via liquidacion_id.
//
// Antes de este trigger, editar un movimiento de Pago Sueldo desde Caja
// dejaba la liquidación stale (caso real: Marcelo, +$350K que reportó Anto).
//
// Flujo:
//   1. Crear novedad + liquidación con total_a_pagar=$100.000.
//   2. Insertar movimiento de Pago Sueldo $60.000 (parcial) linkeado a la liq.
//      → liq.pagos_realizados debe quedar en $60.000 (trigger).
//   3. UPDATE del movimiento a $80.000.
//      → liq.pagos_realizados debe quedar en $80.000 (trigger lo reconcilia).
//   4. Anular el movimiento.
//      → liq.pagos_realizados debe quedar en $0.
//
// Si el trigger no estuviera, el assert (3) falla con $60K en lugar de $80K
// → exactamente el bug que reportó Anto antes del 22-may.
// ─────────────────────────────────────────────────────────────────────────

import {
  test,
  expect,
} from "@playwright/test";
import {
  cleanupE2ETenant,
  createServiceClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Sprint 3 — Trigger sync RRHH (C4-F15)", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("INSERT/UPDATE/DELETE movimiento → liq.pagos_realizados auto-sync", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    // ── 1. Crear novedad para el empleado MENSUAL ──────────────────────
    const empleado = seed.empleados.mensual;
    const fecha = new Date();
    const mes = fecha.getMonth() + 1;
    const anio = fecha.getFullYear();

    const { data: novedad, error: novErr } = await svc.from("rrhh_novedades").insert({
      tenant_id: seed.tenantId,
      empleado_id: empleado.id,
      mes, anio,
      inasistencias: 0,
      presentismo: "MANTIENE", // CHECK acepta MANTIENE|PIERDE
      dias_trabajados: 30,
      horas_extras: 0, dobles: 0, feriados: 0,
      adelantos: 0, vacaciones_dias: 0,
      estado: "confirmado", // CHECK acepta borrador|confirmado (sin 'a')
      fecha_inicio_mes: `${anio}-${String(mes).padStart(2, "0")}-01`,
      cuota_num: 1, cuotas_total: 1,
    }).select("id").single();
    if (novErr) throw new Error(`Crear novedad: ${novErr.message}`);

    // ── 2. Crear liquidación con total_a_pagar=$100K ────────────────────
    const { data: liq, error: liqErr } = await svc.from("rrhh_liquidaciones").insert({
      tenant_id: seed.tenantId,
      novedad_id: novedad.id,
      sueldo_base: 100000,
      descuento_ausencias: 0,
      total_horas_extras: 0, total_dobles: 0, total_feriados: 0, total_vacaciones: 0,
      subtotal1: 100000, monto_presentismo: 0, subtotal2: 100000,
      adelantos: 0, pagos_realizados: 0, total_a_pagar: 100000,
      efectivo: 100000, transferencia: 0,
      estado: "pendiente",
    }).select("id").single();
    if (liqErr) throw new Error(`Crear liquidación: ${liqErr.message}`);

    // ── 3. Insertar movimiento de Pago Sueldo $60K linkeado ─────────────
    // OJO: insertamos directo (no via RPC) porque queremos testear el trigger,
    // no la RPC. Esto es lo que pasaría si Anto edita el monto desde Caja.
    const movId = `MOV-E2E-${Date.now()}`;
    const { error: movErr } = await svc.from("movimientos").insert({
      id: movId,
      tenant_id: seed.tenantId,
      fecha: fecha.toISOString().slice(0, 10),
      cuenta: "Caja Efectivo",
      tipo: "Pago Sueldo",
      cat: "SUELDOS",
      importe: -60000,
      detalle: "E2E pago parcial sueldo Mensual",
      liquidacion_id: liq.id,
      local_id: seed.local1Id,
    });
    if (movErr) throw new Error(`Insert mov: ${movErr.message}`);

    // ── Assert: trigger actualizó liq.pagos_realizados a $60K ──────────
    const { data: liqAfter1 } = await svc.from("rrhh_liquidaciones")
      .select("pagos_realizados, estado").eq("id", liq.id).single();
    expect(Number(liqAfter1!.pagos_realizados)).toBe(60000);

    // ── 4. UPDATE del movimiento a $80K (Anto editó el monto) ───────────
    const { error: updErr } = await svc.from("movimientos")
      .update({ importe: -80000 })
      .eq("id", movId);
    if (updErr) throw new Error(`Update mov: ${updErr.message}`);

    // ── Assert: trigger reconcilió a $80K ──────────────────────────────
    // ESTE es el caso real que rompía antes del trigger (commit d0f67df).
    const { data: liqAfter2 } = await svc.from("rrhh_liquidaciones")
      .select("pagos_realizados, estado").eq("id", liq.id).single();
    expect(Number(liqAfter2!.pagos_realizados)).toBe(80000);

    // ── 5. Anular movimiento → pagos_realizados vuelve a $0 ─────────────
    const { error: anuErr } = await svc.from("movimientos")
      .update({ anulado: true, anulado_motivo: "E2E test" })
      .eq("id", movId);
    if (anuErr) throw new Error(`Anular mov: ${anuErr.message}`);

    const { data: liqAfter3 } = await svc.from("rrhh_liquidaciones")
      .select("pagos_realizados").eq("id", liq.id).single();
    expect(Number(liqAfter3!.pagos_realizados)).toBe(0);

    // ── 6. Re-activar el movimiento → vuelve a $80K ─────────────────────
    await svc.from("movimientos").update({ anulado: false }).eq("id", movId);
    const { data: liqAfter4 } = await svc.from("rrhh_liquidaciones")
      .select("pagos_realizados").eq("id", liq.id).single();
    expect(Number(liqAfter4!.pagos_realizados)).toBe(80000);

    // ── 7. DELETE del movimiento → vuelve a $0 ──────────────────────────
    await svc.from("movimientos").delete().eq("id", movId);
    const { data: liqAfter5 } = await svc.from("rrhh_liquidaciones")
      .select("pagos_realizados").eq("id", liq.id).single();
    expect(Number(liqAfter5!.pagos_realizados)).toBe(0);
  });
});
