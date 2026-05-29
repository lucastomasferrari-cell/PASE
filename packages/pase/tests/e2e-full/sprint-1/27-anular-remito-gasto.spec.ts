// ─────────────────────────────────────────────────────────────────────────
// E2E Test 27 — anular_remito + anular_gasto
//
// Ambas RPCs viven en `202605212400_anular_for_update.sql` (el `for_update`
// en el nombre alude al FOR UPDATE lock que agarra la fila para evitar
// race conditions en doble click). Ambas usan `auth_tiene_permiso_o_override`
// → dueño/admin pasa derecho; encargado necesita TOTP del dueño.
//
// Cubre:
//  A) anular_remito → estado='anulado' + mov ligado anulado + saldo revierte
//  B) anular_remito ya anulado → REMITO_YA_ANULADO
//  C) anular_gasto → estado='anulado' + mov ligado anulado + saldo revierte
//  D) anular_gasto ya anulado → GASTO_YA_ANULADO
//  E) anular_gasto con motivo vacío → MOTIVO_REQUERIDO
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
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Test 27 — anular_remito + anular_gasto", () => {
  let seed: E2ETenantSeedResult | null = null;

   
  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("A+B) anular_remito → estado anulado + ya anulado falla", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Crear remito pendiente via service_role (más simple que armar el flow
    // de crear_remito + items con todos sus params).
    // 29-may fix: el schema real tiene prov_id (no proveedor_id) + monto
    // (no total). El insert anterior silenciosamente fallaba → remito
    // inexistente → REMITO_NO_ENCONTRADO en anular_remito.
    const remitoId = `REM-T27-${Date.now()}`;
    const { error: insErr } = await svc.from("remitos").insert({
      id: remitoId,
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      prov_id: seed.proveedorId,
      fecha: new Date().toISOString().slice(0, 10),
      monto: 25000,
      estado: "sin_factura",  // estados válidos: sin_factura | pagado | facturado | anulado
    });
    if (insErr) throw new Error(`Insert remito: ${insErr.message}`);

    // Pagar el remito para que tenga un mov ligado
    await duenoDb.rpc("pagar_remito", {
      p_remito_id: remitoId,
      p_cuenta: "Caja Efectivo",
      p_local_id: seed.local1Id,
    });

    const { data: saldoAntesAnular } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    const saldoPreAnu = Number(saldoAntesAnular!.saldo);

    // ANULAR (A)
    const { error: anuErr } = await duenoDb.rpc("anular_remito", {
      p_remito_id: remitoId,
      p_motivo: "T27 anular remito",
    });
    if (anuErr) throw new Error(`anular_remito: ${anuErr.message}`);

    // (a) estado anulado
    const { data: rem } = await svc.from("remitos").select("estado, anulado_motivo")
      .eq("id", remitoId).single();
    expect(rem!.estado).toBe("anulado");
    expect(rem!.anulado_motivo).toContain("T27");

    // (b) mov ligado anulado
    const { data: movs } = await svc.from("movimientos").select("anulado")
      .eq("remito_id_ref", remitoId);
    expect(movs!.length).toBeGreaterThan(0);
    expect(movs!.every(m => m.anulado === true)).toBe(true);

    // (c) saldo revirtió (saldo subió porque el egreso se anuló)
    const { data: saldoDespuesAnular } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    expect(Number(saldoDespuesAnular!.saldo)).toBe(saldoPreAnu + 25000);

    // ANULAR DE NUEVO (B) → REMITO_YA_ANULADO
    const { error: dobleErr } = await duenoDb.rpc("anular_remito", {
      p_remito_id: remitoId, p_motivo: "duplicado",
    });
    expect(dobleErr).not.toBeNull();
    expect(dobleErr!.message).toContain("REMITO_YA_ANULADO");

    await duenoDb.auth.signOut();
  });

  test("C+D+E) anular_gasto → anulado + saldo revierte + casos error", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Crear gasto via RPC crear_gasto
    const { data: gasto } = await duenoDb.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_categoria: "Limpieza",
      p_monto: 18000,
      p_cuenta: "Caja Efectivo",
      p_local_id: seed.local1Id,
      p_detalle: "T27 gasto para anular",
    });
    const gastoId = (gasto as { gasto_id: string }).gasto_id;

    const { data: sAntes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    const saldoPre = Number(sAntes!.saldo);

    // ANULAR (C)
    const { error: anuErr } = await duenoDb.rpc("anular_gasto", {
      p_gasto_id: gastoId, p_motivo: "T27 anular gasto",
    });
    if (anuErr) throw new Error(`anular_gasto: ${anuErr.message}`);

    // (a) estado anulado
    const { data: g } = await svc.from("gastos").select("estado, anulado_motivo")
      .eq("id", gastoId).single();
    expect(g!.estado).toBe("anulado");
    expect(g!.anulado_motivo).toContain("T27");

    // (b) mov ligado anulado
    const { data: movs } = await svc.from("movimientos").select("anulado")
      .eq("gasto_id_ref", gastoId);
    expect(movs!.length).toBeGreaterThan(0);
    expect(movs!.every(m => m.anulado === true)).toBe(true);

    // (c) saldo revirtió (subió +18000 porque egreso anulado)
    const { data: sDespues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    expect(Number(sDespues!.saldo)).toBe(saldoPre + 18000);

    // (D) Anular ya anulado → GASTO_YA_ANULADO
    const { error: dobleErr } = await duenoDb.rpc("anular_gasto", {
      p_gasto_id: gastoId, p_motivo: "duplicado",
    });
    expect(dobleErr).not.toBeNull();
    expect(dobleErr!.message).toContain("GASTO_YA_ANULADO");

    // (E) Motivo vacío → MOTIVO_REQUERIDO
    // Creamos un gasto nuevo no anulado para probar el error.
    const { data: g2 } = await duenoDb.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_categoria: "Limpieza",
      p_monto: 1000,
      p_cuenta: "Caja Efectivo",
      p_local_id: seed.local1Id,
      p_detalle: "T27 gasto para test motivo vacío",
    });
    const { error: motErr } = await duenoDb.rpc("anular_gasto", {
      p_gasto_id: (g2 as { gasto_id: string }).gasto_id, p_motivo: "",
    });
    expect(motErr).not.toBeNull();
    expect(motErr!.message).toContain("MOTIVO_REQUERIDO");

    await duenoDb.auth.signOut();
  });
});
