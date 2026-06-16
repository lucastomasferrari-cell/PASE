// ─────────────────────────────────────────────────────────────────────────
// E2E Test 45 — CASHFLOW: carga de extracto + clasificación + resumen + cuadre
//
// Migraciones 202606141200–1600. Contra el tenant E2E compartido (DB-only):
//
//   [1] cashflow_subir_extracto (MercadoPago) con 3 líneas: venta / proveedor /
//       transferencia interna → clasifica por reglas default.
//   [2] La transferencia interna queda es_interno=true.
//   [3] cashflow_resumen_mes: venta=ingreso, proveedor=egreso, la interna NO
//       cuenta (netea). Total egresos = solo el proveedor.
//   [4] INVARIANTE: saldo_inicial + Σ monto_bruto = saldo_final declarado
//       (las líneas suman 0 → el extracto cuadra → resumen.extractos[].cuadra).
//
// Período aislado (2031-01) para no chocar con otros specs. El tenant E2E se
// destruye en global-teardown; igual se limpia el extracto en afterAll.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createE2EDuenoClient } from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

const SENT = "ZZE2ECASHFLOW45";
const PERIODO = "2031-01-01";
const IDEM = `${SENT}-idem`;

const LINEAS = [
  { fecha: "2031-01-05", descripcion: `Liquidacion de dinero ${SENT}`, monto_bruto: 50000, comision: 0, retencion: 0 },
  { fecha: "2031-01-06", descripcion: `Transferencia enviada ${SENT} Proveedor`, monto_bruto: -20000, comision: 0, retencion: 0 },
  { fecha: "2031-01-07", descripcion: `Alivio de caja ${SENT}`, monto_bruto: -30000, comision: 0, retencion: 0 },
];

test.describe.serial("E2E Test 45 — CASHFLOW: extracto → clasificación → resumen → cuadre", () => {
  let duenoDb: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let extractoId: string;

  test.beforeAll(async () => {
    const seed = loadSharedSeed();
    localId = seed.local1Id;
    tenantId = seed.tenantId;
    duenoDb = await createE2EDuenoClient();
  });

  test.afterAll(async () => {
    if (extractoId) {
      await duenoDb.from("cashflow_extractos").delete().eq("id", extractoId).then(() => {}, () => {});
    }
    await duenoDb.from("idempotency_keys").delete()
      .eq("rpc_name", "cashflow_subir_extracto").eq("key", IDEM).then(() => {}, () => {});
    try { await duenoDb.auth.signOut(); } catch { /* */ }
  });

  test("subir extracto MP clasifica, netea la interna, y el resumen cuadra", async () => {
    // [1] Subir.
    const { data: up, error: upErr } = await duenoDb.rpc("cashflow_subir_extracto", {
      p_local_id: localId, p_cuenta: "MercadoPago", p_periodo_mes: PERIODO,
      p_saldo_inicial: 0, p_saldo_final: 0, p_archivo_nombre: `${SENT}.xlsx`,
      p_lineas: LINEAS, p_idempotency_key: IDEM,
    });
    expect(upErr).toBeNull();
    const ext = up as { extracto_id: string; lineas: number };
    extractoId = ext.extracto_id;
    expect(ext.lineas).toBe(3);

    // [2] Clasificación.
    const { data: lineas } = await duenoDb.from("cashflow_lineas")
      .select("descripcion, categoria, es_interno").eq("extracto_id", extractoId);
    expect(lineas?.length).toBe(3);
    const interna = lineas!.find((l) => l.descripcion.includes("Alivio"))!;
    expect(interna.categoria).toBe("transferencia_interna");
    expect(interna.es_interno).toBe(true);
    expect(lineas!.find((l) => l.descripcion.includes("Liquidacion"))!.categoria).toBe("venta");
    expect(lineas!.find((l) => l.descripcion.includes("Proveedor"))!.categoria).toBe("proveedor");

    // [3] Resumen: venta ingreso, proveedor egreso, interna excluida.
    const { data: res, error: resErr } = await duenoDb.rpc("cashflow_resumen_mes", {
      p_local_id: localId, p_periodo_mes: PERIODO,
    });
    expect(resErr).toBeNull();
    const resumen = res as {
      ingresos: { categoria: string; total: number }[];
      egresos: { categoria: string; total: number }[];
      extractos: { cuenta: string; cuadra: boolean }[];
    };
    expect(Number(resumen.ingresos.find((i) => i.categoria === "venta")?.total)).toBe(50000);
    expect(Number(resumen.egresos.find((e) => e.categoria === "proveedor")?.total)).toBe(20000);
    expect(resumen.egresos.reduce((s, e) => s + Number(e.total), 0)).toBe(20000); // sin la interna

    // [4] INVARIANTE: el extracto cuadra (0 + (50000-20000-30000) = 0 = saldo_final).
    const mp = resumen.extractos.find((e) => e.cuenta === "MercadoPago");
    expect(mp?.cuadra).toBe(true);
  });
});
