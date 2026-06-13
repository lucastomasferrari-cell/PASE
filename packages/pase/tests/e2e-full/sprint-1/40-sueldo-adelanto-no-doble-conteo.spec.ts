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
// Escenario: sueldo del empleado mensual (seed) + adelanto 30.000.
//   NETO = total canónico − adelanto.
//   - Pago PARCIAL de la mitad del neto en efectivo + tildo el adelanto.
//   - Esperado (post-fix): pagos_realizados = SOLO el efectivo del parcial,
//     pendiente, adelanto descontado=true.
//   - Pre-fix (bug): pagos_realizados = parcial + adelanto (doble conteo).
// Luego pago el resto → completa, pagos = NETO.
//
// Alineación 13-jun (migración 202606130400): el servidor RECALCULA el total
// canónico desde la novedad + sueldo vigente + adelantos tildados (NO desde
// números hechos a mano). El test pide a `fn_liquidacion_total_canonico` el
// desglose (con el adelanto incluido) y lo usa como p_calc → el total_a_pagar
// del cliente coincide por construcción con el del server. La INTENCIÓN del
// test (pagos_realizados = solo efectivo, no efectivo+adelanto) se mantiene.
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
    const ADELANTO = 30000;
    let novId: string | undefined, adelId: string | undefined;
    const movIds: string[] = [];

    try {
      // Limpieza preventiva.
      await svc.from("rrhh_novedades").delete()
        .eq("tenant_id", seed.tenantId).eq("empleado_id", empleado.id).eq("mes", mes).eq("anio", anio);

      // Snapshot aguinaldo ANTES (para verificar que acumula sobre el BRUTO).
      const { data: empPre } = await svc.from("rrhh_empleados")
        .select("aguinaldo_acumulado").eq("id", empleado.id).single();
      const aguinaldoPre = Number(empPre?.aguinaldo_acumulado ?? 0);

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

      // Desglose CANÓNICO server-side, con el adelanto tildado incluido. El
      // total canónico YA viene con el adelanto restado (NETO = subtotal2 −
      // adelanto), igual que lo arma el frontend. Lo usamos como p_calc → el
      // total_a_pagar coincide con el recálculo del server por construcción.
      const { data: canonData, error: canonErr } = await duenoDb.rpc("fn_liquidacion_total_canonico", {
        p_nov_id: novId, p_adelantos_ids: [adelId],
      });
      if (canonErr) throw new Error(`canonico: ${canonErr.message}`);
      const canon = canonData as Record<string, number>;
      const NETO = Number(canon.total_a_pagar);     // subtotal2 − adelanto
      const SUBTOTAL2 = Number(canon.subtotal2);     // BRUTO (sueldo + presentismo)
      // El adelanto entró restado en el total canónico.
      expect(Number(canon.adelantos)).toBe(ADELANTO);
      expect(NETO).toBe(SUBTOTAL2 - ADELANTO);
      const calc = { ...canon, efectivo: NETO, transferencia: 0 };

      // 3. PAGO PARCIAL: la mitad del neto en efectivo + adelanto tildado.
      const PARCIAL = Math.round(NETO / 2);
      const { data: r1, error: e1 } = await duenoDb.rpc("pagar_sueldo", {
        p_nov_id: novId, p_formas_pago: [{ cuenta: "Caja Efectivo", monto: PARCIAL }],
        p_adelantos_ids: [adelId], p_fecha: `${anio}-${String(mes).padStart(2, "0")}-10`,
        p_mes: mes, p_anio: anio, p_crear_liq: true, p_calc: calc, p_idempotency_key: null,
      });
      if (e1) throw new Error(`pago parcial: ${e1.message}`);
      const res1 = r1 as { completa: boolean; pagos_realizados: number; liquidacion_id: string; mov_ids: string[] };
      movIds.push(...(res1.mov_ids || []));

      // ★ ASSERT CLAVE: pagos = SOLO el efectivo del parcial, NO parcial + adelanto.
      expect(Number(res1.pagos_realizados)).toBe(PARCIAL);
      expect(res1.completa).toBe(false); // PARCIAL (mitad) < NETO

      const { data: liq1 } = await svc.from("rrhh_liquidaciones")
        .select("pagos_realizados, total_a_pagar, estado").eq("id", res1.liquidacion_id).single();
      expect(Number(liq1!.pagos_realizados)).toBe(PARCIAL);       // ← no inflado por el adelanto
      expect(Number(liq1!.total_a_pagar)).toBe(NETO);
      expect(liq1!.estado).toBe("pendiente");

      // El adelanto quedó consumido.
      const { data: adelAfter } = await svc.from("rrhh_adelantos").select("descontado").eq("id", adelId).single();
      expect(adelAfter!.descontado).toBe(true);

      // 4. PAGO DEL RESTO: el saldo del neto en efectivo → completa (pagos = NETO).
      // p_calc: null → no se re-valida el total (la liq ya existe con su NETO
      // guardado y este pago NO tilda el adelanto, así que el recálculo canónico
      // de esta llamada NO restaría el adelanto y daría el bruto; pasar el calc
      // con-adelanto chocaría con LIQUIDACION_CALCULO_INCONSISTENTE). El frontend
      // hace lo mismo: en el pago del saldo no re-manda el desglose, solo abona
      // contra el total ya fijado al crear la liquidación.
      const { data: r2, error: e2 } = await duenoDb.rpc("pagar_sueldo", {
        p_nov_id: novId, p_formas_pago: [{ cuenta: "Caja Efectivo", monto: NETO - PARCIAL }],
        p_adelantos_ids: null, p_fecha: `${anio}-${String(mes).padStart(2, "0")}-11`,
        p_mes: mes, p_anio: anio, p_crear_liq: false, p_calc: null,
        p_liq_id: res1.liquidacion_id, p_idempotency_key: null,
      });
      if (e2) throw new Error(`pago resto: ${e2.message}`);
      const res2 = r2 as { completa: boolean; pagos_realizados: number; mov_ids: string[] };
      movIds.push(...(res2.mov_ids || []));
      expect(res2.completa).toBe(true);
      expect(Number(res2.pagos_realizados)).toBe(NETO); // = neto, NO neto + adelanto

      // ★ Aguinaldo (07-jun + fix 130410): acumula sobre el BRUTO (subtotal2),
      // NO sobre el neto. delta = subtotal2/12 (no neto/12).
      const { data: empPost } = await svc.from("rrhh_empleados")
        .select("aguinaldo_acumulado").eq("id", empleado.id).single();
      const deltaAguinaldo = Number(empPost!.aguinaldo_acumulado) - aguinaldoPre;
      expect(deltaAguinaldo).toBeCloseTo(SUBTOTAL2 / 12, 1); // sobre el bruto, no el neto
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
