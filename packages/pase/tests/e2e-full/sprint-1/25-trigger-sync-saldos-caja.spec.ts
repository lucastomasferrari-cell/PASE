// ─────────────────────────────────────────────────────────────────────────
// E2E Test 25 — Trigger sync saldos_caja ↔ movimientos (C4-F16)
//
// Migration 202605234500 introdujo trigger AFTER INSERT/UPDATE/DELETE en
// movimientos que mantiene saldos_caja sincronizado como vista materializada
// del ledger (cache = SUM(importe FILTER WHERE NOT anulado)).
//
// Este test verifica los 4 escenarios donde el sistema viejo fallaba:
//
//   A) INSERT directo a movimientos (sin pasar por RPC) sincroniza cache.
//      Antes: el cache no se actualizaba porque _actualizar_saldo_caja no
//      se llamaba. Ahora: trigger lo recalcula automáticamente.
//
//   B) UPDATE del importe sincroniza cache.
//      Antes: el cache quedaba con el importe viejo. Ahora: trigger ajusta.
//
//   C) UPDATE de cuenta (cambia de Caja Chica a Caja Mayor) sincroniza
//      AMBAS cuentas (OLD y NEW).
//      Antes: las 2 cuentas quedaban con drift. Ahora: trigger sincroniza
//      las 2 patas.
//
//   D) DELETE sincroniza cache (cache vuelve al valor sin el mov borrado).
//      Antes: el cache no se ajustaba. Ahora: trigger lo refleja.
//
// Caso bonus: simula bug de signo invertido (lo que pasó con
// crear_gasto_empleado del 22-may): inserta mov con signo positivo cuando
// debería ser negativo → cache lo refleja inmediatamente (no oculto).
// ─────────────────────────────────────────────────────────────────────────

import {
  test,
  expect,
} from "@playwright/test";
import {
  createServiceClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Test 25 — Trigger sync saldos_caja", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("A) INSERT directo a movimientos sincroniza cache", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    // Snapshot del cache antes
    const { data: antes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    const saldoAntes = Number(antes?.saldo ?? 0);

    // INSERT directo (bypaseando crear_movimiento_caja RPC) — esto antes
    // NO actualizaba el cache porque _actualizar_saldo_caja no se llamaba.
    const movId = `MOV-E2E-T25A-${Date.now()}`;
    await svc.from("movimientos").insert({
      id: movId,
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      fecha: new Date().toISOString().slice(0, 10),
      cuenta: "Caja Efectivo",
      tipo: "Ingreso Manual",
      importe: 100000,
      detalle: "T25-A insert directo",
      anulado: false,
    });

    // El trigger debe haber sincronizado el cache automáticamente
    const { data: despues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    expect(Number(despues!.saldo)).toBe(saldoAntes + 100000);
  });

  test("B) UPDATE del importe sincroniza cache", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    // Buscar el mov del test A
    const { data: mov } = await svc.from("movimientos")
      .select("id, importe").like("id", "MOV-E2E-T25A-%").single();
    expect(mov).not.toBeNull();

    // Cambiar importe de 100000 → 250000 (delta +150000)
    await svc.from("movimientos").update({ importe: 250000 }).eq("id", mov!.id);

    // Cache debe reflejar el nuevo importe (no el viejo)
    const { data: despues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    expect(Number(despues!.saldo)).toBe(250000);
  });

  test("C) UPDATE de cuenta sincroniza AMBAS (Caja Efectivo → Caja Chica)", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    // Cache antes de mover
    const { data: efAntes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    const { data: chAntes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Chica").maybeSingle();

    expect(Number(efAntes!.saldo)).toBe(250000);

    // Mover el mov a Caja Chica
    const { data: mov } = await svc.from("movimientos")
      .select("id").like("id", "MOV-E2E-T25A-%").single();
    await svc.from("movimientos").update({ cuenta: "Caja Chica" }).eq("id", mov!.id);

    // Caja Efectivo debe haber bajado (el mov salió de ahí)
    // Caja Chica debe haber subido en +250000
    const { data: efDespues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    const { data: chDespues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Chica").single();

    expect(Number(efDespues!.saldo)).toBe(Number(efAntes!.saldo) - 250000);
    expect(Number(chDespues!.saldo)).toBe(Number(chAntes?.saldo ?? 0) + 250000);
  });

  test("D) DELETE sincroniza cache", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    const { data: chAntes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Chica").single();

    const { data: mov } = await svc.from("movimientos")
      .select("id, importe").like("id", "MOV-E2E-T25A-%").single();
    const importeMov = Number(mov!.importe);

    await svc.from("movimientos").delete().eq("id", mov!.id);

    const { data: chDespues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Chica").single();
    expect(Number(chDespues!.saldo)).toBe(Number(chAntes!.saldo) - importeMov);
  });

  test("E) Bug signo invertido se refleja inmediatamente (no oculto)", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    const { data: antes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Mayor").single();
    const saldoAntes = Number(antes?.saldo ?? 0);

    // Simulamos el bug de signo invertido (lo que hacía crear_gasto_empleado
    // antes del fix del 23-may): insertamos un mov con importe POSITIVO
    // cuando contablemente debería ser NEGATIVO (es un egreso).
    const movId = `MOV-E2E-T25E-${Date.now()}`;
    await svc.from("movimientos").insert({
      id: movId,
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      fecha: new Date().toISOString().slice(0, 10),
      cuenta: "Caja Mayor",
      tipo: "Gasto empleado",
      importe: 50000, // BUG: positivo en lugar de -50000
      detalle: "T25-E simulando bug de signo invertido",
      anulado: false,
    });

    // Cache REFLEJA inmediatamente el bug (saldo subió 50K en lugar de bajar).
    // Antes del trigger: el cache podía quedar correcto (porque otro código
    // hacía -50000) mientras el ledger tenía +50000 → drift silencioso.
    // Ahora: cache = ledger, el bug es VISIBLE en pantalla.
    const { data: despues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Mayor").single();
    expect(Number(despues!.saldo)).toBe(saldoAntes + 50000);

    // Verificación adicional: la SUMA de movs no anulados de esa cuenta
    // EXACTAMENTE iguala el cache (invariante fuerte).
    const { data: movs } = await svc.from("movimientos")
      .select("importe")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Mayor")
      .eq("anulado", false);
    const sumaLedger = (movs || []).reduce((s, m) => s + Number(m.importe), 0);
    expect(Number(despues!.saldo)).toBe(sumaLedger);
  });

  test("F) Anular mov restituye saldo (cache se ajusta automático)", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    const { data: mov } = await svc.from("movimientos")
      .select("id, importe").like("id", "MOV-E2E-T25E-%").single();

    const { data: antes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Mayor").single();

    // UPDATE anulado=true (lo que hace un anular_movimiento). Esto NO se ve
    // como un DELETE pero el trigger lo trata equivalente porque el FILTER
    // WHERE NOT anulado lo excluye de la SUM.
    await svc.from("movimientos").update({ anulado: true, anulado_motivo: "T25-F" })
      .eq("id", mov!.id);

    const { data: despues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Mayor").single();
    expect(Number(despues!.saldo)).toBe(Number(antes!.saldo) - Number(mov!.importe));
  });
});
