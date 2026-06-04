import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: editar_movimiento_caja SINCRONIZA el registro origen — Lucas 04-jun
//
// Bug (caso Ciro): editar el importe de un movimiento que viene de un gasto/
// adelanto dejaba el gasto/adelanto con el monto viejo (caja corregida, reporte
// stale). Migración 202606042200 agrega la cascada.
//
// Flujo DB-only:
//   1. crear_gasto monto=SENTINEL1 → gasto + movimiento.
//   2. editar_movimiento_caja del mov a -SENTINEL2.
//   3. Assert: movimiento.importe=-SENTINEL2 Y gasto.monto=SENTINEL2 (cascada).
//      Antes del fix, gasto.monto se quedaba en SENTINEL1.
// ─────────────────────────────────────────────────────────────────────────
const SENTINEL1 = 345678;   // monto inicial
const SENTINEL2 = 333111;   // monto corregido vía editar
const LOCAL = "Local Prueba 2";
const CUENTA = "Caja Efectivo";
const CATEGORIA = "OTROS FIJOS";

test.describe("editar_movimiento_caja — sincroniza origen (mutante)", () => {
  let db: SupabaseClient;
  let localId: number;
  let gastoId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error locales: ${locErr.message}`);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locales[0].id as number;
    gastoId = null;
    movId = null;
  });

  test.afterEach(async () => {
    if (movId) {
      try {
        const { error } = await db.rpc("anular_movimiento", { p_mov_id: movId, p_motivo: "e2e mutante cleanup" });
        if (error && !error.message.includes("YA_ANULADO")) console.error(`[cleanup] anular: ${error.message}`);
      } catch (e) { console.error(`[cleanup] anular threw:`, e); }
    }
    if (movId) { try { await db.from("movimientos").delete().eq("id", movId); } catch (e) { console.error(e); } }
    if (gastoId) { try { await db.from("gastos").delete().eq("id", gastoId); } catch (e) { console.error(e); } }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("editar importe del mov de un gasto → gasto.monto se sincroniza", async () => {
    // 1. Crear gasto
    const { data: r, error: e } = await db.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_local_id: localId,
      p_categoria: CATEGORIA,
      p_tipo: "fijo",
      p_monto: SENTINEL1,
      p_detalle: "e2e cascade editar",
      p_cuenta: CUENTA,
      p_plantilla_id: null,
    });
    expect(e).toBeNull();
    gastoId = (r as { gasto_id: string }).gasto_id;
    movId = (r as { mov_id: string }).mov_id;

    // sanity: gasto y mov arrancan en SENTINEL1
    const { data: g0 } = await db.from("gastos").select("monto").eq("id", gastoId).single();
    expect(Number(g0!.monto)).toBe(SENTINEL1);

    // 2. Editar el movimiento a -SENTINEL2
    const { error: edErr } = await db.rpc("editar_movimiento_caja", {
      p_mov_id: movId,
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "e2e cascade editado",
      p_cat: CATEGORIA,
      p_importe: -SENTINEL2,
      p_cuenta: CUENTA,
      p_tipo: "Gasto fijo",
      p_justificativo: "corrección monto (test cascade)",
    });
    expect(edErr).toBeNull();

    // 3. El movimiento quedó en -SENTINEL2
    const { data: mov } = await db.from("movimientos").select("importe, editado").eq("id", movId).single();
    expect(Number(mov!.importe)).toBe(-SENTINEL2);
    expect(mov!.editado).toBe(true);

    // ★ CLAVE: el gasto origen se sincronizó a SENTINEL2 (antes del fix se
    // quedaba en SENTINEL1 — ese era el bug).
    const { data: g1 } = await db.from("gastos").select("monto").eq("id", gastoId).single();
    expect(Number(g1!.monto)).toBe(SENTINEL2);
  });
});
