import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante F1.1 (CMV — auditoría estructural 2026-05-15):
//
// Verifica las invariantes de las nuevas tablas + RPC `fn_snapshot_receta_a_version`.
// DB-only — la UI no existe todavía (F1.1b). El test pega contra Supabase real
// con sesión de dueño Neko, crea sentinels en "Local Prueba 2", verifica
// comportamiento, y limpia todo en afterEach.
//
// Invariantes que valida:
//   1. CREATE insumo → fila con tenant + local + nombre + unidad + activo.
//   2. CREATE 2do insumo con MISMO nombre y local → UNIQUE violation.
//   3. CREATE receta + receta_insumos → composición correcta.
//   4. RPC fn_snapshot_receta_a_version → crea entry en recetas_versiones con
//      JSON correcto + version_numero=1.
//   5. 2do call de snapshot con misma receta → IDEMPOTENT (devuelve mismo id).
//   6. Modificar receta_insumos (ej. cantidad) → 3er snapshot crea version_numero=2.
//   7. CHECK: cantidad <= 0 rechazado.
//   8. CHECK: merma_pct > 100 rechazado.

const LOCAL = "Local Prueba 2";
const SENTINEL_INSUMO = `Test-CMV-${Date.now()}`;
const SENTINEL_INSUMO_DUP = `${SENTINEL_INSUMO}-DUP`;
const SENTINEL_RECETA = `Receta E2E ${Date.now()}`;

test.describe("CMV — insumos + recetas + snapshot mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let itemId: number;
  let insumoIdA: number | null = null;
  let insumoIdB: number | null = null;
  const insumoIdDup: number | null = null;
  let recetaId: number | null = null;
  const recetaInsumosIds: number[] = [];
  const snapshotIds: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    // Necesitamos un item existente del tenant para crear la receta.
    // No creamos uno nuevo — usamos cualquier item de Neko (mejor: el primero por id).
    const { data: items, error: itemsErr } = await db
      .from("items").select("id").eq("tenant_id", tenantId).limit(1);
    if (itemsErr) throw new Error(`Error consultando items: ${itemsErr.message}`);
    if (!items || items.length === 0) throw new Error("Sin items para usar — crear uno en Neko antes.");
    itemId = items[0].id as number;
  });

  test.afterEach(async () => {
    // Cleanup en orden topológico inverso. Cada paso en try/catch para no
    // bloquear los siguientes (CLAUDE.md mutante pattern).
    for (const sid of snapshotIds) {
      try {
        const { error } = await db.from("recetas_versiones").delete().eq("id", sid);
        if (error) console.error(`[cleanup] delete recetas_versiones ${sid}: ${error.message}`);
      } catch (e) { console.error(`[cleanup] threw:`, e); }
    }
    for (const riId of recetaInsumosIds) {
      try {
        // Soft delete primero para que UNIQUE parcial libere el slot.
        const { error } = await db.from("receta_insumos").update({ deleted_at: new Date().toISOString() }).eq("id", riId);
        if (error) console.error(`[cleanup] soft-delete receta_insumos ${riId}: ${error.message}`);
      } catch (e) { console.error(`[cleanup] threw:`, e); }
    }
    if (recetaId) {
      try {
        const { error } = await db.from("recetas").update({ deleted_at: new Date().toISOString(), activa: false }).eq("id", recetaId);
        if (error) console.error(`[cleanup] soft-delete receta: ${error.message}`);
      } catch (e) { console.error(`[cleanup] threw:`, e); }
    }
    // Volver items.receta_id_vigente a NULL para no dejar referencias.
    try { await db.from("items").update({ receta_id_vigente: null }).eq("id", itemId); }
    catch (e) { console.error(`[cleanup] reset items.receta_id_vigente:`, e); }

    for (const iid of [insumoIdA, insumoIdB, insumoIdDup].filter(Boolean) as number[]) {
      try {
        const { error } = await db.from("insumos").update({ deleted_at: new Date().toISOString() }).eq("id", iid);
        if (error) console.error(`[cleanup] soft-delete insumo ${iid}: ${error.message}`);
      } catch (e) { console.error(`[cleanup] threw:`, e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("crear insumos, receta, receta_insumos + snapshot inmutable + idempotency + versionado", async () => {
    // ── 1. Crear 2 insumos en Local Prueba 2 ──────────────────────────────
    const { data: insA, error: errA } = await db.from("insumos").insert({
      tenant_id: tenantId, local_id: localId,
      nombre: `${SENTINEL_INSUMO}-A`,
      unidad: "kg", costo_actual: 1500.00, es_comprado: true,
    }).select("id").single();
    expect(errA).toBeNull();
    insumoIdA = insA?.id as number;
    expect(insumoIdA).toBeTruthy();

    const { data: insB, error: errB } = await db.from("insumos").insert({
      tenant_id: tenantId, local_id: localId,
      nombre: `${SENTINEL_INSUMO}-B`,
      unidad: "g", costo_actual: 50.0, es_comprado: true,
    }).select("id").single();
    expect(errB).toBeNull();
    insumoIdB = insB?.id as number;
    expect(insumoIdB).toBeTruthy();

    // ── 2. UNIQUE: insumo con mismo nombre y local → falla ───────────────
    const { error: errDup } = await db.from("insumos").insert({
      tenant_id: tenantId, local_id: localId,
      nombre: `${SENTINEL_INSUMO}-A`,
      unidad: "kg", es_comprado: true,
    });
    expect(errDup).not.toBeNull();
    expect(errDup?.message || "").toMatch(/duplicate|unique|uniq_insumo/i);

    // ── 3. CHECK: costo_actual negativo → falla ──────────────────────────
    const { error: errNeg } = await db.from("insumos").insert({
      tenant_id: tenantId, local_id: localId,
      nombre: SENTINEL_INSUMO_DUP,
      unidad: "kg", costo_actual: -1.0, es_comprado: true,
    });
    expect(errNeg).not.toBeNull();
    expect(errNeg?.message || "").toMatch(/chk_insumo_costo_no_negativo|check/i);

    // ── 4. CHECK: nombre vacío → falla ───────────────────────────────────
    const { error: errEmpty } = await db.from("insumos").insert({
      tenant_id: tenantId, local_id: localId,
      nombre: "   ",
      unidad: "kg", es_comprado: true,
    });
    expect(errEmpty).not.toBeNull();
    expect(errEmpty?.message || "").toMatch(/chk_insumo_nombre_no_vacio|check/i);

    // ── 5. Crear receta para el item ──────────────────────────────────────
    const { data: rec, error: errRec } = await db.from("recetas").insert({
      tenant_id: tenantId, local_id: localId,
      item_id: itemId, nombre: SENTINEL_RECETA,
      rendimiento: 1, activa: true,
    }).select("id").single();
    expect(errRec).toBeNull();
    recetaId = rec?.id as number;

    // Pegar items.receta_id_vigente a esta receta nueva.
    const { error: errVig } = await db.from("items").update({ receta_id_vigente: recetaId }).eq("id", itemId);
    expect(errVig).toBeNull();

    // ── 6. Crear receta_insumos (2 filas) ─────────────────────────────────
    const { data: ri1, error: errRi1 } = await db.from("receta_insumos").insert({
      tenant_id: tenantId,
      receta_id: recetaId, insumo_id: insumoIdA,
      cantidad: 0.5, merma_pct: 10, orden: 1,
    }).select("id").single();
    expect(errRi1).toBeNull();
    recetaInsumosIds.push(ri1?.id as number);

    const { data: ri2, error: errRi2 } = await db.from("receta_insumos").insert({
      tenant_id: tenantId,
      receta_id: recetaId, insumo_id: insumoIdB,
      cantidad: 100, merma_pct: 0, orden: 2,
    }).select("id").single();
    expect(errRi2).toBeNull();
    recetaInsumosIds.push(ri2?.id as number);

    // ── 7. CHECK: cantidad <= 0 → falla ──────────────────────────────────
    const { error: errZero } = await db.from("receta_insumos").insert({
      tenant_id: tenantId,
      receta_id: recetaId, insumo_id: insumoIdA,
      cantidad: 0, merma_pct: 0, notas: "test-zero",
    });
    expect(errZero).not.toBeNull();

    // ── 8. CHECK: merma_pct > 100 → falla ────────────────────────────────
    const { error: errMerma } = await db.from("receta_insumos").insert({
      tenant_id: tenantId,
      receta_id: recetaId, insumo_id: insumoIdA,
      cantidad: 1, merma_pct: 150, notas: "test-merma",
    });
    expect(errMerma).not.toBeNull();

    // ── 9. Snapshot inmutable de receta viva → version 1 ─────────────────
    const { data: snap1, error: errSnap1 } = await db.rpc("fn_snapshot_receta_a_version", {
      p_item_id: itemId,
    });
    expect(errSnap1).toBeNull();
    const snapId1 = snap1 as number;
    expect(snapId1).toBeTruthy();
    snapshotIds.push(snapId1);

    // Verificar contenido del snapshot.
    const { data: rv1 } = await db.from("recetas_versiones")
      .select("version_numero, item_id, receta_data")
      .eq("id", snapId1).maybeSingle();
    expect(rv1?.item_id).toBe(itemId);
    expect(rv1?.version_numero).toBeGreaterThanOrEqual(1);
    const data1 = rv1?.receta_data as { receta_id: number; rendimiento: number; insumos: Array<{ insumo_id: number; cantidad: number; merma_pct: number }> };
    expect(data1.receta_id).toBe(recetaId);
    expect(data1.rendimiento).toBe(1);
    expect(data1.insumos.length).toBe(2);
    expect(data1.insumos.map(x => x.insumo_id).sort()).toEqual([insumoIdA, insumoIdB].sort());

    // ── 10. IDEMPOTENCY: snapshot con receta sin cambios → mismo id ──────
    const { data: snap2, error: errSnap2 } = await db.rpc("fn_snapshot_receta_a_version", {
      p_item_id: itemId,
    });
    expect(errSnap2).toBeNull();
    expect(snap2 as number).toBe(snapId1);

    // ── 11. Cambiar receta_insumos → snapshot crea version nueva ─────────
    const { error: errUpd } = await db.from("receta_insumos")
      .update({ cantidad: 0.75 }).eq("id", recetaInsumosIds[0]!);
    expect(errUpd).toBeNull();

    const { data: snap3, error: errSnap3 } = await db.rpc("fn_snapshot_receta_a_version", {
      p_item_id: itemId,
    });
    expect(errSnap3).toBeNull();
    const snapId3 = snap3 as number;
    expect(snapId3).not.toBe(snapId1);
    snapshotIds.push(snapId3);

    const { data: rv3 } = await db.from("recetas_versiones")
      .select("version_numero, receta_data").eq("id", snapId3).maybeSingle();
    expect(rv3?.version_numero).toBeGreaterThan(rv1?.version_numero ?? 0);
    const data3 = rv3?.receta_data as { insumos: Array<{ insumo_id: number; cantidad: number }> };
    const insumoA_v3 = data3.insumos.find(x => x.insumo_id === insumoIdA);
    expect(Number(insumoA_v3?.cantidad)).toBe(0.75);

    // ── 12. Snapshot de item SIN receta → devuelve NULL ──────────────────
    // Probamos con un item distinto que no tenga receta.
    const { data: otroItem } = await db.from("items")
      .select("id").eq("tenant_id", tenantId).neq("id", itemId).limit(1).maybeSingle();
    if (otroItem) {
      const { data: snapNull, error: errSnapNull } = await db.rpc("fn_snapshot_receta_a_version", {
        p_item_id: otroItem.id,
      });
      expect(errSnapNull).toBeNull();
      expect(snapNull).toBeNull();
    }
  });
});
