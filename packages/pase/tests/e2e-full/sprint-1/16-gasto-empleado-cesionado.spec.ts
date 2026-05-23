// ─────────────────────────────────────────────────────────────────────────
// E2E Test 16: gasto a empleado (cesionado/no cesionado) — protege bug Anto
//
// Bug reportado por Anto el 22-may noche: en Gastos → empleados, seleccionar
// un empleado cesionado y tocar Guardar → pantalla congelada sin pasar nada.
//
// Causa: validación de form en línea 261 de Gastos.tsx hacía
//   `if (saving || !form.monto || !form.categoria) return;`
// Para tipo='empleado' el form usa `concepto` (no `categoria`) →
// `form.categoria` queda vacío → return silencioso sin alert.
//
// Fix: validar concepto+empleado_id para tipo=empleado, categoria para resto.
// Este test verifica que la RPC `crear_gasto_empleado` funciona end-to-end
// para ambos: empleado del local actual + empleado cesionado a este local.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import {
  seedE2ETenant, cleanupE2ETenant, createServiceClient, createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";

test.describe.serial("E2E Test 16 — Gasto empleado cesionado", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: sess?.session?.access_token!, baseUrl });
    const svc = createServiceClient();
    // Saldo en Caja Efectivo de ambos locales
    await svc.from("saldos_caja").update({ saldo: 100000 })
      .eq("tenant_id", seed.tenantId).eq("cuenta", "Caja Efectivo");
    await superdb.auth.signOut();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("pagar adelanto a empleado del LOCAL PRINCIPAL", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // El empleado mensual del seed ya tiene local_id = local1
    const empleado = seed.empleados.mensual;

    const { data: result, error } = await duenoDb.rpc("crear_gasto_empleado", {
      p_local_id: seed.local1Id,
      p_empleado_id: empleado.id,
      p_concepto: "adelanto",
      p_monto: 15000,
      p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E test adelanto local principal",
    });
    if (error) throw new Error(`crear_gasto_empleado local principal: ${error.message}`);
    expect(result).toBeTruthy();

    // Verificar gasto creado
    const { data: gastos } = await svc.from("gastos")
      .select("monto, tipo, categoria").eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id);
    expect(gastos!.some(g => g.tipo === "empleado" && Number(g.monto) === 15000)).toBe(true);

    // Verificar adelanto en rrhh_adelantos
    const { data: adels } = await svc.from("rrhh_adelantos")
      .select("monto, concepto, empleado_id")
      .eq("tenant_id", seed.tenantId).eq("empleado_id", empleado.id);
    expect(adels!.some(a => Number(a.monto) === 15000 && a.concepto === "adelanto")).toBe(true);

    await duenoDb.auth.signOut();
  });

  test("pagar adelanto a empleado CESIONADO a otro local", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Crear cesión: el empleado mensual (local1) se cede a local2
    const empleado = seed.empleados.mensual;
    const { error: cedErr } = await duenoDb.rpc("fn_ceder_empleado_a_local", {
      p_empleado_id: empleado.id,
      p_local_destino_id: seed.local2Id,
      p_tipo: "cesion_temporal",
      p_fecha_desde: new Date().toISOString().slice(0, 10),
      p_fecha_hasta: null,
      p_notas: "E2E test cesion",
    });
    if (cedErr) throw new Error(`fn_ceder_empleado_a_local: ${cedErr.message}`);

    // Verificar que aparece en local2 (cesión). El "local principal" del
    // empleado vive en rrhh_empleados.local_id, no en rrhh_empleado_locales
    // (esa tabla solo guarda las cesiones).
    const { data: cesiones } = await svc.from("rrhh_empleado_locales")
      .select("local_id, es_principal, tipo").eq("empleado_id", empleado.id).is("deleted_at", null);
    const enLocal2 = cesiones!.find(c => c.local_id === seed!.local2Id);
    expect(enLocal2).toBeDefined();
    expect(enLocal2!.tipo).toBe("cesion_temporal");

    // Pagar adelanto desde LOCAL 2 (no su principal) — el cesionado
    const { data: result, error } = await duenoDb.rpc("crear_gasto_empleado", {
      p_local_id: seed.local2Id,
      p_empleado_id: empleado.id,
      p_concepto: "dia_doble",
      p_monto: 12000,
      p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E adelanto cubriendo en Local 2",
    });
    if (error) throw new Error(`crear_gasto_empleado cesionado: ${error.message}`);
    expect(result).toBeTruthy();

    // Verificar gasto en local2
    const { data: gastosL2 } = await svc.from("gastos")
      .select("monto, local_id").eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local2Id).eq("tipo", "empleado");
    expect(gastosL2!.some(g => Number(g.monto) === 12000)).toBe(true);

    // El adelanto se graba en rrhh_adelantos sin filtro por local —
    // queda asociado al EMPLEADO. El legajo lo muestra para descontar
    // del próximo sueldo. Verificamos ambos (local1 y local2) suman.
    const { data: adels } = await svc.from("rrhh_adelantos")
      .select("monto, cuenta").eq("tenant_id", seed.tenantId).eq("empleado_id", empleado.id);
    const totalAdel = adels!.reduce((s, a) => s + Number(a.monto), 0);
    // Tenemos al menos el del test anterior ($15K) + este ($12K) = $27K
    expect(totalAdel).toBeGreaterThanOrEqual(27000);

    await duenoDb.auth.signOut();
  });
});
