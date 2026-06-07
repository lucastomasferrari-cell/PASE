// ─────────────────────────────────────────────────────────────────────────
// E2E full — Test 40: adelanto NO se cuenta doble en pagos_realizados
// (caso Esteban Adrian — 07-jun, migración 202606072100)
//
// BUG: el frontend calcula total_a_pagar = bruto − adelanto (NETO). El backend
// pagar_sueldo, además, sumaba el adelanto a pagos_realizados → doble conteo.
// El sistema creía que se había pagado de más (= el monto del adelanto), y
// quedaba desalineado con el trigger _resync_liquidacion_pagos (que cuenta solo
// los movimientos de efectivo/transferencia).
//
// FIX: pagos_realizados = SOLO efectivo/transferencia. El adelanto únicamente:
// (a) ya está restado de total_a_pagar, (b) se marca descontado=true.
//
// Escenario: bruto 100.000, adelanto 30.000 → neto 70.000.
//   - Pago PARCIAL de 40.000 en efectivo + tildo el adelanto.
//   - Esperado (post-fix): pagos_realizados = 40.000 (solo efectivo),
//     pendiente, falta 30.000, adelanto descontado=true.
//   - Pre-fix (bug): pagos_realizados = 70.000 (40.000 + 30.000 adelanto).
// Luego pago el resto (30.000) → completa, pagos = 70.000 = neto.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Test 40 — adelanto sin doble conteo", () => {
  let seed: E2ETenantSeedResult | null = null;
  test.beforeAll(() => { seed = loadSharedSeed(); });

  test("pagar sueldo con adelanto: pagos_realizados = solo efectivo (no efectivo+adelanto)", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const empleado = seed.empleados.mensual;
    const mes = 9, anio = 2099; // aislado
    const BRUTO = 100000, ADELANTO = 30000, NETO = BRUTO - ADELANTO; // 70.000
    let novId: string | undefined, adelId: string | undefined;
    const movIds: string[] = [];

    try {
      // Limpieza preventiva.
      await svc.from("rrhh_novedades").delete()
        .eq("tenant_id", seed.tenantId).eq("empleado_id", empleado.id).eq("mes", mes).eq("anio", anio);

      // 1. Adelanto pendiente (descontado=false).
      const { data: adel, error: adelErr } = await svc.from("rrhh_adelantos").insert({
        tenant_id: seed.tenantId, empleado_id: empleado.id,
        fecha: `${anio}-${String(mes).padStart(2, "0")}-05`,
        monto: ADELANTO, cuenta: "Caja Efectivo",
        descontado: false, concepto: "adelanto",
      }).select("id").single();
      if (adelErr) throw new Error(`adelanto: ${adelErr.message}`);
      adelId = adel!.id as string;

      // 2. Novedad confirmada.
      const { data: nov, error: novErr } = await svc.from("rrhh_novedades").insert({
        tenant_id: seed.tenantId, empleado_id: empleado.id, mes, anio,
        inasistencias: 0, presentismo: "MANTIENE", dias_trabajados: 30,
        horas_extras: 0, dobles: 0, feriados: 0, adelantos: 0, vacaciones_dias: 0,
        estado: "confirmado", fecha_inicio_mes: `${anio}-${String(mes).padStart(2, "0")}-01`,
        cuota_num: 1, cuotas_total: 1,
      }).select("id").single();
      if (novErr) throw new Error(`novedad: ${novErr.message}`);
      novId = nov!.id as string;

      // p_calc: total_a_pagar = NETO (bruto − adelanto), como hace el frontend.
      const calc = {
        sueldo_base: BRUTO, descuento_ausencias: 0, total_horas_extras: 0, total_dobles: 0,
        total_feriados: 0, total_vacaciones: 0, subtotal1: BRUTO, monto_presentismo: 0,
        subtotal2: BRUTO, adelantos: ADELANTO, total_a_pagar: NETO, efectivo: NETO, transferencia: 0,
      };

      // 3. PAGO PARCIAL: 40.000 efectivo + adelanto tildado.
      const PARCIAL = 40000;
      const { data: r1, error: e1 } = await duenoDb.rpc("pagar_sueldo", {
        p_nov_id: novId, p_formas_pago: [{ cuenta: "Caja Efectivo", monto: PARCIAL }],
        p_adelantos_ids: [adelId], p_fecha: `${anio}-${String(mes).padStart(2, "0")}-10`,
        p_mes: mes, p_anio: anio, p_crear_liq: true, p_calc: calc, p_idempotency_key: null,
      });
      if (e1) throw new Error(`pago parcial: ${e1.message}`);
      const res1 = r1 as { completa: boolean; pagos_realizados: number; liquidacion_id: string; mov_ids: string[] };
      movIds.push(...(res1.mov_ids || []));

      // ★ ASSERT CLAVE: pagos = SOLO efectivo (40.000), NO 70.000 (40k + 30k adelanto).
      expect(Number(res1.pagos_realizados)).toBe(PARCIAL);
      expect(res1.completa).toBe(false); // 40.000 < 70.000 neto

      const { data: liq1 } = await svc.from("rrhh_liquidaciones")
        .select("pagos_realizados, total_a_pagar, estado").eq("id", res1.liquidacion_id).single();
      expect(Number(liq1!.pagos_realizados)).toBe(PARCIAL);       // ← no inflado por el adelanto
      expect(Number(liq1!.total_a_pagar)).toBe(NETO);
      expect(liq1!.estado).toBe("pendiente");

      // El adelanto quedó consumido.
      const { data: adelAfter } = await svc.from("rrhh_adelantos").select("descontado").eq("id", adelId).single();
      expect(adelAfter!.descontado).toBe(true);

      // 4. PAGO DEL RESTO: 30.000 efectivo → completa (pagos = 70.000 = neto).
      const { data: r2, error: e2 } = await duenoDb.rpc("pagar_sueldo", {
        p_nov_id: novId, p_formas_pago: [{ cuenta: "Caja Efectivo", monto: NETO - PARCIAL }],
        p_adelantos_ids: null, p_fecha: `${anio}-${String(mes).padStart(2, "0")}-11`,
        p_mes: mes, p_anio: anio, p_crear_liq: false, p_calc: calc,
        p_liq_id: res1.liquidacion_id, p_idempotency_key: null,
      });
      if (e2) throw new Error(`pago resto: ${e2.message}`);
      const res2 = r2 as { completa: boolean; pagos_realizados: number; mov_ids: string[] };
      movIds.push(...(res2.mov_ids || []));
      expect(res2.completa).toBe(true);
      expect(Number(res2.pagos_realizados)).toBe(NETO); // 70.000, no 100.000
    } finally {
      // Cleanup: anular movs de pago (revierte saldo + libera adelanto), borrar filas.
      for (const m of movIds) {
        try { await duenoDb.rpc("anular_movimiento", { p_mov_id: m, p_motivo: "E2E cleanup t40" }); } catch { /* */ }
        try { await svc.from("movimientos").delete().eq("id", m); } catch { /* */ }
      }
      if (novId) {
        const { data: liqs } = await svc.from("rrhh_liquidaciones").select("id").eq("novedad_id", novId);
        for (const l of liqs || []) await svc.from("rrhh_liquidaciones").delete().eq("id", l.id as string);
        await svc.from("rrhh_novedades").delete().eq("id", novId);
      }
      if (adelId) await svc.from("rrhh_adelantos").delete().eq("id", adelId);
      await duenoDb.auth.signOut();
    }
  });
});
