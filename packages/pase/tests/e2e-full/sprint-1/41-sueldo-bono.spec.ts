// ─────────────────────────────────────────────────────────────────────────
// E2E full — Test 41: Bonos (novedad que SUMA al sueldo) — 07-jun
// Migración 202606072200. Mirror de "Otros desc." pero para arriba.
//
// Escenario: bruto 100.000 + bono 50.000 → total 150.000. Se paga 150.000 en
// efectivo. Esperado: liq.bono = 50.000, total_a_pagar = 150.000, completa.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Test 41 — Bono suma al sueldo", () => {
  let seed: E2ETenantSeedResult | null = null;
  test.beforeAll(() => { seed = loadSharedSeed(); });

  test("pagar sueldo con bono: se guarda en la liq y suma al total", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const empleado = seed.empleados.mensual;
    const mes = 10, anio = 2099;
    const BRUTO = 100000, BONO = 50000, TOTAL = BRUTO + BONO; // 150.000
    let novId: string | undefined;
    const movIds: string[] = [];

    try {
      await svc.from("rrhh_novedades").delete()
        .eq("tenant_id", seed.tenantId).eq("empleado_id", empleado.id).eq("mes", mes).eq("anio", anio);

      const { data: nov, error: novErr } = await svc.from("rrhh_novedades").insert({
        tenant_id: seed.tenantId, empleado_id: empleado.id, mes, anio,
        inasistencias: 0, presentismo: "MANTIENE", dias_trabajados: 30,
        horas_extras: 0, dobles: 0, feriados: 0, adelantos: 0, vacaciones_dias: 0,
        bono: BONO, bono_motivo: "E2E productividad",
        estado: "confirmado", fecha_inicio_mes: `${anio}-${String(mes).padStart(2, "0")}-01`,
        cuota_num: 1, cuotas_total: 1,
      }).select("id, bono").single();
      if (novErr) throw new Error(`novedad: ${novErr.message}`);
      novId = nov!.id as string;
      expect(Number(nov!.bono)).toBe(BONO); // columna persiste

      const calc = {
        sueldo_base: BRUTO, descuento_ausencias: 0, total_horas_extras: 0, total_dobles: 0,
        total_feriados: 0, total_vacaciones: 0, subtotal1: BRUTO, monto_presentismo: 0,
        subtotal2: BRUTO, adelantos: 0, bono: BONO, total_a_pagar: TOTAL, efectivo: TOTAL, transferencia: 0,
      };

      const { data: r, error: e } = await duenoDb.rpc("pagar_sueldo", {
        p_nov_id: novId, p_formas_pago: [{ cuenta: "Caja Efectivo", monto: TOTAL }],
        p_adelantos_ids: null, p_fecha: `${anio}-${String(mes).padStart(2, "0")}-10`,
        p_mes: mes, p_anio: anio, p_crear_liq: true, p_calc: calc, p_idempotency_key: null,
      });
      if (e) throw new Error(`pagar: ${e.message}`);
      const res = r as { completa: boolean; liquidacion_id: string; mov_ids: string[]; pagos_realizados: number };
      movIds.push(...(res.mov_ids || []));
      expect(res.completa).toBe(true);
      expect(Number(res.pagos_realizados)).toBe(TOTAL);

      // La liquidación guardó el bono + el total con el bono incluido.
      const { data: liq } = await svc.from("rrhh_liquidaciones")
        .select("bono, total_a_pagar").eq("id", res.liquidacion_id).single();
      expect(Number(liq!.bono)).toBe(BONO);
      expect(Number(liq!.total_a_pagar)).toBe(TOTAL); // 150.000 (incluye el bono)
    } finally {
      for (const m of movIds) {
        try { await duenoDb.rpc("anular_movimiento", { p_mov_id: m, p_motivo: "E2E cleanup t41" }); } catch { /* */ }
        try { await svc.from("movimientos").delete().eq("id", m); } catch { /* */ }
      }
      if (novId) {
        const { data: liqs } = await svc.from("rrhh_liquidaciones").select("id").eq("novedad_id", novId);
        for (const l of liqs || []) await svc.from("rrhh_liquidaciones").delete().eq("id", l.id as string);
        await svc.from("rrhh_novedades").delete().eq("id", novId);
      }
      await duenoDb.auth.signOut();
    }
  });
});
