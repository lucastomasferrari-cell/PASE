import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante — Sprint "nunca más huérfanos" (09-jun-2026).
//
// Cubre las 2 piezas de backend del sprint de integridad referencial:
//
//   A) anular_movimiento, al anular UNA pata de una transferencia, anula
//      también la pata hermana (antes quedaba media transferencia viva — fue
//      la causa del fantasma "pauta abril +300k" en Villa Crespo).
//
//   B) El guard fn_guard_no_borrar_con_movimientos BLOQUEA borrar un padre
//      financiero (acá: un adelanto) que tenga movimientos de caja vivos
//      (antes el delete dejaba el movimiento colgado → fantasma).
//
// DB-only (sin UI), vía RPCs con contexto de dueño. Local Prueba 2.
// Migraciones: 202606092000_guard_no_huerfanos_cascada.sql + 202606092001.

const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const SENTINEL_TRANSFER = "MUTANTE guard transfer 09jun";
const ADELANTO_MONTO = 44321; // sentinel raro para no chocar
const HOY = new Date().toISOString().slice(0, 10);

test.describe("Sprint anti-huérfanos — guard + cascada transferencia (mutante)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let empId: string;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locales } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length !== 1) throw new Error(`Seed: local "${LOCAL}" no único`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    const { data: emps } = await db.from("rrhh_empleados")
      .select("id").eq("apellido", APELLIDO).eq("nombre", NOMBRE).eq("local_id", localId);
    if (!emps || emps.length === 0) throw new Error(`Seed: falta empleado ${APELLIDO} ${NOMBRE} en ${LOCAL}`);
    empId = emps[0]!.id as string;
  });

  test.afterEach(async () => {
    // Limpieza: anular cualquier mov sentinel + borrar adelantos sentinel.
    try {
      const { data: movs } = await db.from("movimientos")
        .select("id").eq("tenant_id", tenantId).eq("detalle", SENTINEL_TRANSFER).eq("anulado", false);
      for (const m of movs ?? []) {
        try { await db.rpc("anular_movimiento", { p_mov_id: (m as { id: string }).id, p_motivo: "cleanup mutante" }); } catch { /* */ }
      }
    } catch { /* */ }
    try {
      // Adelantos sentinel: anular su mov primero (si vivo), luego borrar.
      const { data: ads } = await db.from("rrhh_adelantos")
        .select("id").eq("empleado_id", empId).eq("monto", ADELANTO_MONTO);
      for (const a of ads ?? []) {
        const adId = (a as { id: string }).id;
        const { data: mv } = await db.from("movimientos").select("id").eq("adelanto_id_ref", adId).eq("anulado", false);
        for (const m of mv ?? []) {
          try { await db.rpc("anular_movimiento", { p_mov_id: (m as { id: string }).id, p_motivo: "cleanup mutante" }); } catch { /* */ }
        }
        try { await db.from("rrhh_adelantos").delete().eq("id", adId); } catch { /* */ }
      }
    } catch { /* */ }
    try { await db.auth.signOut(); } catch { /* */ }
  });

  test("A) anular una pata de transferencia anula también la hermana", async () => {
    const { error } = await db.rpc("transferencia_cuentas", {
      p_local_id: localId,
      p_cuenta_origen: "Caja Efectivo",
      p_cuenta_destino: "Caja Mayor",
      p_monto: 12345,
      p_fecha: HOY,
      p_detalle: SENTINEL_TRANSFER,
    });
    expect(error).toBeNull();

    const { data: movs } = await db.from("movimientos")
      .select("id, transferencia_id, anulado")
      .eq("tenant_id", tenantId).eq("local_id", localId)
      .eq("detalle", SENTINEL_TRANSFER).eq("anulado", false);
    expect(movs).toHaveLength(2);
    const tid = movs![0]!.transferencia_id;
    expect(movs![1]!.transferencia_id).toBe(tid);

    // Anular SOLO una pata.
    const { error: anuErr } = await db.rpc("anular_movimiento", {
      p_mov_id: movs![0]!.id, p_motivo: "mutante: anular una pata",
    });
    expect(anuErr).toBeNull();

    // MUTANTE: ambas patas deben quedar anuladas (la cascada anula la hermana).
    const { data: despues } = await db.from("movimientos")
      .select("id, anulado").in("id", [movs![0]!.id, movs![1]!.id]);
    expect(despues).toHaveLength(2);
    expect(despues!.every(m => m.anulado === true)).toBe(true);

    // Y no debe quedar ninguna pata viva de esa transferencia.
    const { data: vivas } = await db.from("movimientos")
      .select("id").eq("transferencia_id", tid).eq("anulado", false);
    expect(vivas ?? []).toHaveLength(0);
  });

  test("B) el guard bloquea borrar un adelanto con movimiento vivo", async () => {
    const { error } = await db.rpc("registrar_adelanto", {
      p_empleado_id: empId,
      p_monto: ADELANTO_MONTO,
      p_cuenta: "Caja Efectivo",
      p_fecha: HOY,
      p_detalle: "MUTANTE guard adelanto 09jun",
    });
    expect(error).toBeNull();

    const { data: ads } = await db.from("rrhh_adelantos")
      .select("id").eq("empleado_id", empId).eq("monto", ADELANTO_MONTO).order("created_at", { ascending: false });
    expect(ads && ads.length > 0).toBe(true);
    const adId = ads![0]!.id as string;

    // El adelanto tiene un movimiento de caja vivo.
    const { data: mv } = await db.from("movimientos").select("id").eq("adelanto_id_ref", adId).eq("anulado", false);
    expect(mv && mv.length > 0).toBe(true);

    // MUTANTE: borrar el adelanto debe FALLAR (guard) y el adelanto seguir vivo.
    const { error: delErr } = await db.from("rrhh_adelantos").delete().eq("id", adId);
    expect(delErr).not.toBeNull();
    expect(JSON.stringify(delErr)).toContain("PADRE_CON_MOVIMIENTOS_VIVOS");

    const { data: sigue } = await db.from("rrhh_adelantos").select("id").eq("id", adId);
    expect(sigue).toHaveLength(1);

    // Y si anulo el movimiento primero, AHORA sí deja borrar (no hay huérfano).
    await db.rpc("anular_movimiento", { p_mov_id: (mv![0] as { id: string }).id, p_motivo: "mutante: liberar adelanto" });
    const { error: delOk } = await db.from("rrhh_adelantos").delete().eq("id", adId);
    expect(delOk).toBeNull();
  });
});
