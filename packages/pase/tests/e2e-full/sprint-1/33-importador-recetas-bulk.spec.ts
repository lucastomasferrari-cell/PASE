// ─────────────────────────────────────────────────────────────────────────
// E2E Test 33 — Importador bulk de recetas (CSV)
//
// Cubre la RPC `fn_importar_recetas_bulk` (migration 202605241000):
//   A) Dry-run con CSV válido → reporte correcto + NO toca DB
//   B) Dry-run con errores → array `errores` estructurado + NO toca DB
//   C) Commit con CSV válido → crea items + insumos + recetas + receta_insumos
//   D) Re-import (idempotency) → desactiva versión vieja, crea nueva
//   E) Match case-insensitive con items existentes → no duplica
//   F) Auth: usuario sin dueno/admin → PERMISO_DENEGADO
//
// Por qué este test existe: el importador es la herramienta de onboarding
// más usada al crear un local nuevo. Si se rompe (ej: por column ambiguous
// como pasó con el marketplace), el operador no puede arrancar. Asserts
// DB-strict para evitar falsamente verde.
// ─────────────────────────────────────────────────────────────────────────

import {
  test,
  expect,
} from "@playwright/test";
import {
  cleanupE2ETenant,
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";

const SENTINEL = `T33_${Date.now()}`;

test.describe.serial("E2E Test 33 — importador recetas bulk", () => {
  let seed: E2ETenantSeedResult | null = null;

   
  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => {
    // Cleanup específico del test (lo que el sentinel haya dejado)
    if (seed) {
      const svc = createServiceClient();
      const { data: recetas } = await svc.from("recetas")
        .select("id").eq("tenant_id", seed.tenantId).like("nombre", `Receta ${SENTINEL}%`);
      for (const r of recetas ?? []) {
        await svc.from("receta_insumos").delete().eq("receta_id", r.id);
      }
      await svc.from("recetas").delete().eq("tenant_id", seed.tenantId).like("nombre", `Receta ${SENTINEL}%`);
      await svc.from("items").delete().eq("tenant_id", seed.tenantId).like("nombre", `${SENTINEL}%`);
      await svc.from("insumos").delete().eq("tenant_id", seed.tenantId).like("nombre", `${SENTINEL}%`);
      await svc.from("idempotency_keys").delete().like("key", `${SENTINEL}%`);
    }
    try { await cleanupE2ETenant(); } catch (e) { console.error(e); }
  });

  const CSV_VALIDO = [
    { plato: `${SENTINEL} Sushi`,  ingrediente: `${SENTINEL}_Salmón`, cantidad: 0.05, unidad: "kg", merma_pct: 30, precio_plato: 4500 },
    { plato: `${SENTINEL} Sushi`,  ingrediente: `${SENTINEL}_Arroz`,  cantidad: 0.1,  unidad: "kg", merma_pct: 0,  precio_plato: null },
    { plato: `${SENTINEL} Sushi`,  ingrediente: `${SENTINEL}_Nori`,   cantidad: 1,    unidad: "un", merma_pct: 0,  precio_plato: null },
    { plato: `${SENTINEL} Ramen`,  ingrediente: `${SENTINEL}_Caldo`,  cantidad: 0.4,  unidad: "L",  merma_pct: 0,  precio_plato: 6200 },
    { plato: `${SENTINEL} Ramen`,  ingrediente: `${SENTINEL}_Fideos`, cantidad: 0.15, unidad: "kg", merma_pct: 0,  precio_plato: null },
  ];

  test("A) Dry-run con CSV válido → reporte correcto y NO toca DB", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const db = await createE2EDuenoClient();
    const svc = createServiceClient();

    const { data, error } = await db.rpc("fn_importar_recetas_bulk", {
      p_recetas: CSV_VALIDO,
      p_dry_run: true,
    });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(data.dry_run).toBe(true);
    expect(data.recetas_a_crear).toBe(2);
    expect(data.items_a_crear).toBe(2);
    expect(data.insumos_a_crear).toBe(5);
    expect(data.errores).toEqual([]);

    // Crítico: dry-run NO debe tocar DB
    const { count: itemsCount } = await svc.from("items")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", seed.tenantId).like("nombre", `${SENTINEL}%`);
    expect(itemsCount).toBe(0);

    await db.auth.signOut();
  });

  test("B) Dry-run con errores → 4 errores estructurados", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const db = await createE2EDuenoClient();
    const CSV_MALO = [
      { plato: `${SENTINEL} OK`, ingrediente: `${SENTINEL}_x`, cantidad: 1, unidad: "kg", merma_pct: 0, precio_plato: 100 },
      { plato: "",                ingrediente: `${SENTINEL}_y`, cantidad: 1, unidad: "kg", merma_pct: 0, precio_plato: null },  // plato_vacio
      { plato: `${SENTINEL} OK`, ingrediente: `${SENTINEL}_z`, cantidad: 1, unidad: "Kilos", merma_pct: 0, precio_plato: null }, // unidad_invalida
      { plato: `${SENTINEL} OK`, ingrediente: `${SENTINEL}_w`, cantidad: 0, unidad: "kg", merma_pct: 0, precio_plato: null },   // cantidad_invalida
      { plato: `${SENTINEL} OK`, ingrediente: `${SENTINEL}_q`, cantidad: 1, unidad: "kg", merma_pct: 150, precio_plato: null }, // merma_pct_fuera_rango
    ];
    const { data } = await db.rpc("fn_importar_recetas_bulk", {
      p_recetas: CSV_MALO, p_dry_run: true,
    });
    expect(data.ok).toBe(false);
    expect(data.errores.length).toBe(4);
    const tipos = data.errores.map((e: { error: string }) => e.error).sort();
    expect(tipos).toEqual(["cantidad_invalida","merma_pct_fuera_rango","plato_vacio","unidad_invalida"]);
    await db.auth.signOut();
  });

  test("C) Commit con CSV válido → crea entidades + receta_insumos correctos", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const db = await createE2EDuenoClient();
    const svc = createServiceClient();

    const { data, error } = await db.rpc("fn_importar_recetas_bulk", {
      p_recetas: CSV_VALIDO,
      p_dry_run: false,
      p_idempotency_key: `${SENTINEL}-commit-1`,
    });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(data.recetas_creadas).toBe(2);
    expect(data.items_creados).toBe(2);
    expect(data.insumos_creados).toBe(5);

    // Verificar items en DB
    const { data: items } = await svc.from("items")
      .select("id, nombre, precio_madre").eq("tenant_id", seed.tenantId).like("nombre", `${SENTINEL}%`);
    expect(items?.length).toBe(2);
    const sushi = items?.find(i => i.nombre.includes("Sushi"));
    expect(Number(sushi?.precio_madre)).toBe(4500);

    // Verificar insumos en DB
    const { data: insumos } = await svc.from("insumos")
      .select("id, nombre, unidad, costo_actual").eq("tenant_id", seed.tenantId).like("nombre", `${SENTINEL}%`);
    expect(insumos?.length).toBe(5);
    const salmon = insumos?.find(i => i.nombre.includes("Salmón"));
    expect(salmon?.unidad).toBe("kg");
    expect(Number(salmon?.costo_actual)).toBe(0);

    // Verificar recetas activas
    const { data: recetas } = await svc.from("recetas")
      .select("id, item_id, activa").eq("tenant_id", seed.tenantId).like("nombre", `Receta ${SENTINEL}%`);
    expect(recetas?.length).toBe(2);
    expect(recetas?.every(r => r.activa === true)).toBe(true);

    // Verificar receta_insumos del Sushi (3 ingredientes + cantidades + merma)
    const recetaSushi = recetas?.find(r => items?.find(i => i.id === r.item_id && i.nombre.includes("Sushi")));
    expect(recetaSushi).toBeDefined();
    const { data: ri } = await svc.from("receta_insumos")
      .select("cantidad, merma_pct").eq("receta_id", recetaSushi!.id);
    expect(ri?.length).toBe(3);
    const cantTotal = (ri ?? []).reduce((s, r) => s + Number(r.cantidad), 0);
    expect(cantTotal).toBeCloseTo(1.15, 3);
    const conMerma = (ri ?? []).find(r => Number(r.merma_pct) === 30);
    expect(conMerma).toBeDefined();

    await db.auth.signOut();
  });

  test("D) Re-import (idempotency) → desactiva vieja, crea nueva con cantidad actualizada", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const db = await createE2EDuenoClient();
    const svc = createServiceClient();

    // Cambio cantidad del salmón (era 0.05, ahora 0.07)
    const CSV_V2 = CSV_VALIDO.map((l, i) => i === 0 ? { ...l, cantidad: 0.07 } : l);
    const { data, error } = await db.rpc("fn_importar_recetas_bulk", {
      p_recetas: CSV_V2,
      p_dry_run: false,
      p_idempotency_key: `${SENTINEL}-commit-2`,
    });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(data.recetas_creadas).toBe(2);

    // 2 versiones de la receta Sushi: la vieja inactiva, la nueva activa
    const { data: versions } = await svc.from("recetas")
      .select("id, activa, created_at").eq("tenant_id", seed.tenantId)
      .like("nombre", `Receta ${SENTINEL} Sushi%`).order("created_at");
    expect(versions?.length).toBe(2);
    expect(versions?.[0]?.activa).toBe(false);
    expect(versions?.[1]?.activa).toBe(true);

    // La cantidad del salmón en la nueva versión debe ser 0.07
    const { data: insumos } = await svc.from("insumos")
      .select("id").eq("tenant_id", seed.tenantId).like("nombre", `${SENTINEL}_Salmón`);
    const salmonId = insumos?.[0]?.id;
    const { data: riNew } = await svc.from("receta_insumos")
      .select("cantidad").eq("receta_id", versions![1]!.id).eq("insumo_id", salmonId!);
    expect(Number(riNew?.[0]?.cantidad)).toBe(0.07);

    await db.auth.signOut();
  });

  test("E) Match case-insensitive → no duplica items/insumos existentes", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const db = await createE2EDuenoClient();
    const CSV_CASE = [
      // Nombres con case distinto a los ya creados — deben matchear
      { plato: `${SENTINEL} SUSHI`, ingrediente: `${SENTINEL}_salmón`,
        cantidad: 0.06, unidad: "kg", merma_pct: 25, precio_plato: 4600 },
    ];
    const { data } = await db.rpc("fn_importar_recetas_bulk", {
      p_recetas: CSV_CASE, p_dry_run: true,
    });
    expect(data.ok).toBe(true);
    expect(data.items_a_crear).toBe(0);
    expect(data.insumos_a_crear).toBe(0);
    await db.auth.signOut();
  });

  test("F) Auth — user sin sesión → PERMISO_DENEGADO", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const { createClient } = await import("@supabase/supabase-js");
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = resolve(here, "..", "..", "..", ".env.local");
    const raw = readFileSync(envPath, "utf-8");
    const anonKey = raw.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m)?.[1]?.trim() ?? "";

    // Cliente sin auth — debe fallar con AUTH_REQUIRED o PERMISO_DENEGADO
    const anon = createClient("https://pduxydviqiaxfqnshhdc.supabase.co", anonKey, {
      auth: { persistSession: false },
    });
    const { error } = await anon.rpc("fn_importar_recetas_bulk", {
      p_recetas: CSV_VALIDO, p_dry_run: true,
    });
    expect(error).not.toBeNull();
    // Aceptamos cualquiera de los 2 mensajes (depende de qué chequee primero)
    expect(error?.message ?? "").toMatch(/AUTH_REQUIRED|PERMISO_DENEGADO/i);
  });
});
