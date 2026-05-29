// ─────────────────────────────────────────────────────────────────────────
// E2E Test 26 — editar_movimiento_caja
//
// RPC del 12-may (deuda C4-F11). Permite editar un mov + ajustar saldos
// atómicamente. Crítico porque se usa todos los días desde Caja → "Editar".
//
// Cubre:
//  A) Editar importe → cache se ajusta (revertir viejo + aplicar nuevo)
//  B) Editar cuenta → AMBAS cuentas se sincronizan (vieja - importe, nueva + importe)
//  C) Editar SOLO fecha/detalle (sin cambio de saldo) → cache no cambia
//  D) Editar mov anulado → falla con MOVIMIENTO_YA_ANULADO
//  E) Justificativo vacío → falla con MOTIVO_REQUERIDO
//  F) Idempotency: mismo key → no duplica el ajuste
//  G) Auditoría: queda registro con antes/despues + justificativo
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

test.describe.serial("E2E Test 26 — editar_movimiento_caja", () => {
  let seed: E2ETenantSeedResult | null = null;
  let movId: string;

   
  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("A) editar importe → cache ajusta diferencia", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Cache antes = 100000
    const { data: antes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    expect(Number(antes!.saldo)).toBe(100000);

    // Editar importe a 250000 (delta +150000)
    const { error } = await duenoDb.rpc("editar_movimiento_caja", {
      p_mov_id: movId,
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "T26 editado a 250K",
      p_cat: null,
      p_importe: 250000,
      p_cuenta: "Caja Efectivo",
      p_tipo: "Ingreso Manual",
      p_justificativo: "ajuste para test",
    });
    if (error) throw new Error(`editar_movimiento_caja A: ${error.message}`);

    const { data: despues } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    expect(Number(despues!.saldo)).toBe(250000);

    // Mov queda con editado=true + motivo
    const { data: mov } = await svc.from("movimientos")
      .select("editado, editado_motivo, importe").eq("id", movId).single();
    expect(mov!.editado).toBe(true);
    expect(mov!.editado_motivo).toBe("ajuste para test");
    expect(Number(mov!.importe)).toBe(250000);

    await duenoDb.auth.signOut();
  });

  test("B) editar cuenta → AMBAS cuentas se sincronizan", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Mover el mov a Caja Mayor (saldo Mayor antes = 0, Efectivo = 250K)
    const { error } = await duenoDb.rpc("editar_movimiento_caja", {
      p_mov_id: movId,
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "T26 movido a Caja Mayor",
      p_cat: null,
      p_importe: 250000,
      p_cuenta: "Caja Mayor",
      p_tipo: "Ingreso Manual",
      p_justificativo: "mover de cuenta",
    });
    if (error) throw new Error(`editar_movimiento_caja B: ${error.message}`);

    const { data: ef } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    const { data: mayor } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Mayor").single();
    expect(Number(ef!.saldo)).toBe(0);       // Efectivo vacío
    expect(Number(mayor!.saldo)).toBe(250000); // Mayor con todo

    await duenoDb.auth.signOut();
  });

  test("C) editar SOLO fecha/detalle → cache NO cambia", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const { error } = await duenoDb.rpc("editar_movimiento_caja", {
      p_mov_id: movId,
      p_fecha: "2026-01-15", // fecha vieja
      p_detalle: "T26 solo detalle nuevo",
      p_cat: null,
      p_importe: 250000,        // SIN cambio
      p_cuenta: "Caja Mayor",   // SIN cambio
      p_tipo: "Ingreso Manual",
      p_justificativo: "corrección de fecha",
    });
    if (error) throw new Error(`editar_movimiento_caja C: ${error.message}`);

    const { data: mayor } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Mayor").single();
    expect(Number(mayor!.saldo)).toBe(250000); // sin cambio

    await duenoDb.auth.signOut();
  });

  test("D) Editar mov ANULADO → falla con MOVIMIENTO_YA_ANULADO", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();

    // Anular primero
    const { error: anuErr } = await duenoDb.rpc("anular_movimiento", {
      p_mov_id: movId,
      p_motivo: "para test editar bloqueado",
    });
    if (anuErr) throw new Error(`anular: ${anuErr.message}`);

    // Ahora intentar editar
    const { error: editErr } = await duenoDb.rpc("editar_movimiento_caja", {
      p_mov_id: movId,
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "no debería pasar",
      p_cat: null,
      p_importe: 999,
      p_cuenta: "Caja Mayor",
      p_tipo: "Ingreso Manual",
      p_justificativo: "intentar editar anulado",
    });
    expect(editErr).not.toBeNull();
    expect(editErr!.message).toContain("MOVIMIENTO_YA_ANULADO");

    await duenoDb.auth.signOut();
  });

  test("E) Justificativo vacío → MOTIVO_REQUERIDO", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();

    // Crear nuevo mov no anulado
    const { data: nuevo } = await duenoDb.rpc("crear_movimiento_caja", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_cuenta: "Caja Efectivo",
      p_tipo: "Ingreso Manual",
      p_cat: null,
      p_importe: 5000,
      p_detalle: "T26-E mov para editar sin motivo",
      p_local_id: seed.local1Id,
    });
    const nuevoId = (nuevo as { mov_id: string }).mov_id;

    const { error } = await duenoDb.rpc("editar_movimiento_caja", {
      p_mov_id: nuevoId,
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "sin motivo",
      p_cat: null,
      p_importe: 5000,
      p_cuenta: "Caja Efectivo",
      p_tipo: "Ingreso Manual",
      p_justificativo: "",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("MOTIVO_REQUERIDO");

    await duenoDb.auth.signOut();
  });

  test("F) Idempotency: mismo key → no duplica ajuste", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const { data: nuevo } = await duenoDb.rpc("crear_movimiento_caja", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_cuenta: "Caja Efectivo",
      p_tipo: "Ingreso Manual",
      p_cat: null,
      p_importe: 10000,
      p_detalle: "T26-F idempotency",
      p_local_id: seed.local1Id,
    });
    const idMov = (nuevo as { mov_id: string }).mov_id;

    const { data: sAntes } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    const saldoPreEdit = Number(sAntes!.saldo);

    const idemKey = `t26-f-${Date.now()}`;
    // Llamada 1: editar a +50000 (delta +40000)
    const { data: r1 } = await duenoDb.rpc("editar_movimiento_caja", {
      p_mov_id: idMov, p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "T26-F primera", p_cat: null, p_importe: 50000,
      p_cuenta: "Caja Efectivo", p_tipo: "Ingreso Manual",
      p_justificativo: "idempotency 1", p_idempotency_key: idemKey,
    });
    const { data: s1 } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    expect(Number(s1!.saldo)).toBe(saldoPreEdit + 40000);

    // Llamada 2: mismo key → debe retornar resultado cacheado SIN re-aplicar
    const { data: r2 } = await duenoDb.rpc("editar_movimiento_caja", {
      p_mov_id: idMov, p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "T26-F SEGUNDA (no debería re-aplicarse)", p_cat: null, p_importe: 999999,
      p_cuenta: "Caja Efectivo", p_tipo: "Ingreso Manual",
      p_justificativo: "idempotency 2", p_idempotency_key: idemKey,
    });
    const { data: s2 } = await svc.from("saldos_caja").select("saldo")
      .eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo").single();
    // Saldo idéntico — la 2da llamada se cortó por idempotency cache
    expect(Number(s2!.saldo)).toBe(Number(s1!.saldo));
    expect((r2 as { ok: boolean }).ok).toBe(true);
    expect(r1).toEqual(r2); // mismo result jsonb

    await duenoDb.auth.signOut();
  });

  test("G) Auditoría queda registrada con antes/después/justificativo", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    const { data: audits } = await svc.from("auditoria")
      .select("detalle").eq("tabla", "movimientos").eq("accion", "EDICION")
      .eq("tenant_id", seed.tenantId)
      .order("fecha", { ascending: false }).limit(10);
    expect(audits!.length).toBeGreaterThan(0);
    // Al menos una auditoría tiene los campos antes + despues + justificativo
    const algunaConTodo = audits!.some(a => {
      try {
        const d = JSON.parse(a.detalle);
        return d.antes && d.despues && d.justificativo;
      } catch { return false; }
    });
    expect(algunaConTodo).toBe(true);
  });
});
