import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: módulo Cashflow — carga de extracto + clasificación + resumen.
// Spec: docs/superpowers/specs/2026-06-14-cashflow-rene-design.md
//
// Valida el circuito clave de plata:
//   1. cashflow_subir_extracto clasifica cada línea (venta / proveedor /
//      transferencia_interna) por reglas default.
//   2. La transferencia interna queda es_interno=true.
//   3. cashflow_resumen_mes cuenta venta como ingreso, proveedor como egreso, y
//      EXCLUYE la transferencia interna de ingresos/egresos (netea).
//   4. Idempotency: re-subir con la misma key no duplica (idempotent_replay).
//
// DB-only. Usa un período aislado (2030-01) sin datos reales para que el resumen
// sea determinístico. Limpia el extracto (cascade) + la idempotency key.
// ─────────────────────────────────────────────────────────────────────────
const SENT = "ZZMUTCF";
const LOCAL = "Local Prueba 2";
const PERIODO = "2030-01-01";
const IDEM = `${SENT}-idem-key`;

test.describe("Cashflow — mutante (carga + clasificación + resumen)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locs } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locs || locs.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locs[0].id as number;
    tenantId = locs[0].tenant_id as string;
    await limpiar();
  });

  test.afterEach(async () => {
    await limpiar();
    try { await db.auth.signOut(); } catch { /* */ }
  });

  async function limpiar() {
    // Borra el extracto del período de prueba (cascade → líneas) + idempotency.
    await db.from("cashflow_extractos").delete()
      .eq("tenant_id", tenantId).eq("local_id", localId).eq("periodo_mes", PERIODO)
      .then(() => {}, () => {});
    await db.from("idempotency_keys").delete()
      .eq("rpc_name", "cashflow_subir_extracto").eq("key", IDEM)
      .then(() => {}, () => {});
  }

  const LINEAS = [
    { fecha: "2030-01-05", descripcion: `Liquidacion de dinero ${SENT}`, monto_bruto: 50000, comision: 0, retencion: 0 },
    { fecha: "2030-01-06", descripcion: `Transferencia enviada ${SENT} Proveedor`, monto_bruto: -20000, comision: 0, retencion: 0 },
    { fecha: "2030-01-07", descripcion: `Alivio de caja ${SENT}`, monto_bruto: -30000, comision: 0, retencion: 0 },
  ];

  test("subir extracto clasifica, netea la interna, y el resumen cuadra", async () => {
    // 1. Subir el extracto.
    const { data: up, error: upErr } = await db.rpc("cashflow_subir_extracto", {
      p_local_id: localId, p_cuenta: "MercadoPago", p_periodo_mes: PERIODO,
      p_saldo_inicial: 0, p_saldo_final: 0, p_archivo_nombre: `${SENT}.xlsx`,
      p_lineas: LINEAS, p_idempotency_key: IDEM,
    });
    expect(upErr).toBeNull();
    const ext = up as { extracto_id: string; lineas: number };
    expect(ext.lineas).toBe(3);

    // 2. Clasificación de cada línea (DB-only, precisa).
    const { data: lineas } = await db.from("cashflow_lineas")
      .select("descripcion, monto_bruto, categoria, es_interno")
      .eq("extracto_id", ext.extracto_id);
    expect(lineas?.length).toBe(3);
    const venta = lineas!.find((l) => l.descripcion.includes("Liquidacion"))!;
    const prov = lineas!.find((l) => l.descripcion.includes("Proveedor"))!;
    const interna = lineas!.find((l) => l.descripcion.includes("Alivio"))!;
    expect(venta.categoria).toBe("venta");
    expect(venta.es_interno).toBe(false);
    expect(prov.categoria).toBe("proveedor");
    expect(prov.es_interno).toBe(false);
    expect(interna.categoria).toBe("transferencia_interna");
    expect(interna.es_interno).toBe(true);

    // 3. Resumen del mes (período aislado → solo estas 3 líneas).
    const { data: res, error: resErr } = await db.rpc("cashflow_resumen_mes", {
      p_local_id: localId, p_periodo_mes: PERIODO,
    });
    expect(resErr).toBeNull();
    const resumen = res as {
      ingresos: { categoria: string; total: number }[];
      egresos: { categoria: string; total: number }[];
    };
    const ingVenta = resumen.ingresos.find((i) => i.categoria === "venta");
    expect(Number(ingVenta?.total)).toBe(50000);
    const egProv = resumen.egresos.find((e) => e.categoria === "proveedor");
    expect(Number(egProv?.total)).toBe(20000);
    // La transferencia interna NO cuenta como ingreso ni egreso.
    expect(resumen.ingresos.some((i) => i.categoria === "transferencia_interna")).toBe(false);
    expect(resumen.egresos.some((e) => e.categoria === "transferencia_interna")).toBe(false);
    const totalEgresos = resumen.egresos.reduce((s, e) => s + Number(e.total), 0);
    expect(totalEgresos).toBe(20000); // solo proveedor, NO los -30000 de la interna

    // 4. Idempotency: re-subir con la misma key no duplica.
    const { data: up2 } = await db.rpc("cashflow_subir_extracto", {
      p_local_id: localId, p_cuenta: "MercadoPago", p_periodo_mes: PERIODO,
      p_saldo_inicial: 0, p_saldo_final: 0, p_archivo_nombre: `${SENT}.xlsx`,
      p_lineas: LINEAS, p_idempotency_key: IDEM,
    });
    expect((up2 as { idempotent_replay?: boolean }).idempotent_replay).toBe(true);
    const { count } = await db.from("cashflow_lineas")
      .select("id", { count: "exact", head: true }).eq("extracto_id", ext.extracto_id);
    expect(count).toBe(3); // sigue habiendo 3, no 6
  });

  // Regresión (Lucas 12-jul): el aguinaldo (movimiento cat='SUELDOS' con
  // pago_especial_id_ref, liquidacion_id NULL) DEBE contar en Sueldos del P&L,
  // tanto devengado como percibido. Antes quedaba afuera (inflaba la ganancia).
  test("cashflow_pyl_mes cuenta el aguinaldo (pago_especial) en Sueldos — devengado y percibido", async () => {
    const monto = 123456;
    const { data: emps } = await db.from("rrhh_empleados").select("id").eq("tenant_id", tenantId).limit(1);
    if (!emps || emps.length === 0) throw new Error("Falta seed: al menos un empleado en el tenant de prueba");
    const empId = emps[0].id as string;
    const peId = crypto.randomUUID();
    const movId = crypto.randomUUID();
    const detalle = `[test ${SENT}] aguinaldo`;

    // Idempotencia ante corridas previas que hayan dejado basura en el período.
    await db.from("movimientos").delete()
      .eq("local_id", localId).eq("cat", "SUELDOS")
      .gte("fecha", "2030-01-01").lt("fecha", "2030-02-01")
      .ilike("detalle", `%${SENT}%`).then(() => {}, () => {});

    try {
      await db.from("rrhh_pagos_especiales").insert({
        id: peId, empleado_id: empId, tipo: "aguinaldo",
        monto, monto_pagado: monto, pendiente: false, tenant_id: tenantId,
      });
      await db.from("movimientos").insert({
        id: movId, fecha: "2030-01-15", cuenta: "MercadoPago", tipo: "Pago Aguinaldo",
        cat: "SUELDOS", importe: -monto, detalle, local_id: localId,
        pago_especial_id_ref: peId, tenant_id: tenantId, anulado: false,
      });

      const { data, error } = await db.rpc("cashflow_pyl_mes", { p_local_id: localId, p_periodo_mes: PERIODO });
      expect(error).toBeNull();
      const pyl = data as { devengado: { sueldos: number }; percibido: { sueldos: number } };
      // Período aislado → el único sueldo del mes es este aguinaldo.
      expect(Number(pyl.devengado.sueldos)).toBe(monto);
      expect(Number(pyl.percibido.sueldos)).toBe(monto);
    } finally {
      await db.from("movimientos").delete().eq("id", movId).then(() => {}, () => {});
      await db.from("rrhh_pagos_especiales").delete().eq("id", peId).then(() => {}, () => {});
    }
  });
});
