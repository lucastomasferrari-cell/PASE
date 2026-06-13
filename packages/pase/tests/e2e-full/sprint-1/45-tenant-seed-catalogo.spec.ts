// ─────────────────────────────────────────────────────────────────────────
// E2E Test 45 — Tier 3: tenant nuevo trae catálogo genérico sembrado
//
// Migración 202606130800_seed_catalogo_tenant.sql. crear_tenant_v2 ahora
// siembra (vía fn_seed_catalogo_tenant) un catálogo genérico AR al crear cada
// tenant. El tenant E2E se crea fresco en cada corrida vía ese mismo RPC, así
// que verificamos el seed contra él (DB-only, read-only — NO muta nada).
//
// Asserta:
//   [1] config_categorias del tenant: ≥15 filas tipo gasto* + ≥1 cat_compra
//       + ≥1 cat_ingreso (catálogo de gastos/compras/ingresos sembrado)
//   [2] ≥1 medio de cobro con cuenta_destino='Caja Chica' (efectivo del template)
//   [3] ≥1 puesto
//   [4] ANTI-LEAK: NINGUNA categoría con nombre de Neko (EDESUR / SUSHIMAN PM /
//       WOKI / BARRIO CHINO) — el tenant nuevo NO debe ver datos de Neko.
//
// Read-only: no hay cleanup (no inserta nada). El seed-tenant.ts agrega además
// 'INSUMOS COCINA'/'ALQUILER'/'SUELDOS' a mano (los necesitan otros specs);
// este test no depende de esos, valida el template genérico del auto-seed.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { createServiceClient, type E2ETenantSeedResult } from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

// Nombres específicos de Neko que NO deben aparecer en un tenant nuevo.
const NEKO_LEAK = ["EDESUR", "SUSHIMAN PM", "WOKI", "BARRIO CHINO", "METROGAS"];

test.describe("E2E Test 45 — Tenant nuevo: catálogo genérico sembrado (sin leak de Neko)", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(() => {
    seed = loadSharedSeed();
  });

  test("crear_tenant_v2 sembró el catálogo genérico AR en el tenant E2E", async () => {
    if (!seed) { test.skip(true, "Seed no disponible"); return; }
    const svc = createServiceClient();
    const T = seed.tenantId;

    // [1] Categorías sembradas
    const { data: cats, error: cErr } = await svc
      .from("config_categorias")
      .select("nombre, tipo")
      .eq("tenant_id", T);
    if (cErr) throw new Error(`Leer config_categorias: ${cErr.message}`);
    const filas = cats ?? [];
    const gastos = filas.filter((c) => String(c.tipo).startsWith("gasto")).length;
    const compras = filas.filter((c) => c.tipo === "cat_compra").length;
    const ingresos = filas.filter((c) => c.tipo === "cat_ingreso").length;

    expect(gastos, `categorías de gasto sembradas (fue ${gastos})`).toBeGreaterThanOrEqual(15);
    expect(compras, "al menos 1 categoría de compra (CMV)").toBeGreaterThanOrEqual(1);
    expect(ingresos, "al menos 1 categoría de ingreso").toBeGreaterThanOrEqual(1);

    // [2] Medio de cobro efectivo con cuenta_destino del template
    const { data: medios, error: mErr } = await svc
      .from("medios_cobro")
      .select("nombre, cuenta_destino")
      .eq("tenant_id", T)
      .eq("cuenta_destino", "Caja Chica")
      .is("deleted_at", null);
    if (mErr) throw new Error(`Leer medios_cobro: ${mErr.message}`);
    expect((medios ?? []).length, "al menos 1 medio con cuenta_destino='Caja Chica'").toBeGreaterThanOrEqual(1);

    // [3] Puestos sembrados
    const { data: puestos, error: pErr } = await svc
      .from("rrhh_puestos")
      .select("nombre")
      .eq("tenant_id", T);
    if (pErr) throw new Error(`Leer rrhh_puestos: ${pErr.message}`);
    expect((puestos ?? []).length, "al menos 1 puesto sembrado").toBeGreaterThanOrEqual(1);

    // [4] ANTI-LEAK: ninguna categoría con nombre de Neko
    const nombresUpper = filas.map((c) => String(c.nombre).toUpperCase());
    for (const leak of NEKO_LEAK) {
      expect(
        nombresUpper.includes(leak),
        `el tenant nuevo NO debe tener la categoría de Neko "${leak}" (leak de datos cross-tenant)`,
      ).toBe(false);
    }
  });
});
