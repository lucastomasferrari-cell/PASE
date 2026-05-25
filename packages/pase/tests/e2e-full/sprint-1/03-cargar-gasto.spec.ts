// ─────────────────────────────────────────────────────────────────────────
// E2E Sprint 2 — Test 03: cargar gasto desde Caja (DB-only)
//
// Flujo testeado:
//   1. Setup tenant E2E (sin COMANDA — gasto es flow PASE puro).
//   2. Snapshot saldo Caja Efectivo del local.
//   3. RPC crear_gasto: gasto de $5000 categoría INSUMOS COCINA, paga
//      desde Caja Efectivo.
//   4. Verificar:
//      - Fila en `gastos` con monto correcto + linked al tenant.
//      - Fila en `movimientos` tipo "Gasto variable" con importe NEGATIVO.
//      - Saldo Caja Efectivo bajó en 5000.
//   5. Cleanup tenant E2E.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import {
  seedE2ETenant,
  cleanupE2ETenant,
  createServiceClient,
  createE2EDuenoClient,
  seedSaldoInicial,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";

test.describe.serial("E2E Sprint 2 — Cargar gasto desde Caja (DB-only)", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const superToken = sess?.session?.access_token!;
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: superToken, baseUrl });
    await superdb.auth.signOut();
  });

  test.afterAll(async () => {
    try { await cleanupE2ETenant(); } catch (e) {

      console.error("[afterAll]", e);
    }
  });

  test("cargar gasto $5000 desde Caja Efectivo → mov negativo + saldo baja", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }

    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Setear saldo inicial $50.000 vía opening balance (cache derivado del
    // ledger desde 23-may → UPDATE directo no funciona).
    await seedSaldoInicial(svc, seed.tenantId, seed.local1Id, "Caja Efectivo", 50000);

    const saldoInicial = 50000;
    const monto = 5000;

    // Act: cargar gasto
    const { data: gastoRes, error: gastoErr } = await duenoDb.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_local_id: seed.local1Id,
      p_categoria: "INSUMOS COCINA",
      p_tipo: "variable", // CHECK acepta fijo/variable/publicidad/comision/impuesto/retiro_socio
      p_monto: monto,
      p_detalle: "E2E test — bolsa harina",
      p_cuenta: "Caja Efectivo",
    });
    if (gastoErr) throw new Error(`crear_gasto: ${gastoErr.message}`);
    expect(gastoRes).toBeTruthy();

    // Assert: fila en gastos
    const { data: gastos } = await svc.from("gastos")
      .select("id, monto, categoria, detalle")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id);
    expect(gastos).toHaveLength(1);
    expect(Number(gastos![0]!.monto)).toBe(monto);
    expect(gastos![0]!.categoria).toBe("INSUMOS COCINA");

    // Assert: movimiento negativo en Caja Efectivo
    // Filtramos ajuste_inicial porque el opening balance del seed también es un mov.
    const { data: movs } = await svc.from("movimientos")
      .select("tipo, importe, cuenta, gasto_id_ref")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo")
      .eq("anulado", false)
      .neq("tipo", "ajuste_inicial");
    expect(movs).toHaveLength(1);
    expect(Number(movs![0]!.importe)).toBe(-monto);
    expect(movs![0]!.gasto_id_ref).toBe(gastos![0]!.id);

    // Assert: saldo bajó
    const { data: saldo } = await svc.from("saldos_caja")
      .select("saldo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo")
      .single();
    expect(Number(saldo!.saldo)).toBe(saldoInicial - monto);

    await duenoDb.auth.signOut();
  });

  test("cargar gasto JUICIOS Y DEMANDAS (grupo independiente, sin empleado)", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }

    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // El tenant E2E no trae las categorías de juicios en el seed básico
    // (se crearon en migration 223700 para tenants existentes pero el seed
    // E2E es nuevo). Las inserto manualmente para este test.
    await svc.from("config_categorias").insert({
      tenant_id: seed.tenantId,
      nombre: "JUICIOS Y DEMANDAS",
      tipo: "gasto_juicios_demandas",
      orden: 10,
      activo: true,
    });

    // Resetear saldo a $50.000 (reemplaza opening balance anterior + el gasto
    // del test previo bajó el saldo a $45k → re-seedear lo deja en $50k limpio).
    await seedSaldoInicial(svc, seed.tenantId, seed.local1Id, "Caja Efectivo", 50000);
    // Borrar mov del gasto del test 1 para que no contamine
    await svc.from("movimientos")
      .delete()
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo")
      .neq("tipo", "ajuste_inicial");

    const monto = 8500;
    // Act: cargar gasto tipo 'juicios_demandas' (NO requiere empleado).
    // Esto valida que:
    //   - CHECK constraint gastos_tipo_check acepta 'juicios_demandas'
    //   - RPC crear_gasto funciona con el tipo nuevo
    //   - Se puede cargar sin tener que asociar a empleado puntual
    const { data: gastoRes, error: gastoErr } = await duenoDb.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_local_id: seed.local1Id,
      p_categoria: "JUICIOS Y DEMANDAS",
      p_tipo: "juicios_demandas",
      p_monto: monto,
      p_detalle: "E2E — Honorarios abogado juicio laboral",
      p_cuenta: "Caja Efectivo",
    });
    if (gastoErr) throw new Error(`crear_gasto juicios: ${gastoErr.message}`);
    expect(gastoRes).toBeTruthy();

    // Assert: gasto guardado con tipo correcto
    const { data: gastos } = await svc.from("gastos")
      .select("monto, categoria, tipo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("tipo", "juicios_demandas");
    expect(gastos).toHaveLength(1);
    expect(Number(gastos![0]!.monto)).toBe(monto);
    expect(gastos![0]!.categoria).toBe("JUICIOS Y DEMANDAS");
    expect(gastos![0]!.tipo).toBe("juicios_demandas");

    // Assert: saldo bajó
    const { data: saldo } = await svc.from("saldos_caja")
      .select("saldo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo")
      .single();
    expect(Number(saldo!.saldo)).toBe(50000 - monto);

    await duenoDb.auth.signOut();
  });
});
