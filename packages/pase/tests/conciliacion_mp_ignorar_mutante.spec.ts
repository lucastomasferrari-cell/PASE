import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: marcar un egreso MP como "ignorado" y verificar que sale
// del KPI sin-justificar, después des-ignorar y verificar reversión.
//
// DB-only (mismo motivo que conciliacion_mp_multifactura_mutante): la lógica
// crítica está en las RPCs fn_ignorar_mp / fn_designorar_mp. El UI es solo
// un botón con input, cubierto por typecheck + lint + build.
const SENTINEL = 12345.67;
const LOCAL = "Local Prueba 2";
const MOTIVO = "duplicado de banco (e2e test)";

test.describe("Conciliación MP — ignorar mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let mpMovId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    // Insertar mp_movimiento sandbox (egreso, sin justificativo, no ignorado).
    mpMovId = `mock-e2e-ign-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { error: insErr } = await db.from("mp_movimientos").insert([{
      id: mpMovId, local_id: localId, tenant_id: tenantId,
      fecha: new Date().toISOString(),
      tipo: "bank_transfer",
      descripcion: `E2E ignorar ${Date.now()}`,
      monto: -SENTINEL,
      estado: "approved",
      conciliado: false,
      anulado: false,
    }]);
    if (insErr) throw new Error(`Insert mp_movimiento: ${insErr.message}`);
  });

  test.afterEach(async () => {
    if (mpMovId) {
      try { const { error } = await db.from("mp_movimientos").delete().eq("id", mpMovId);
        if (error) console.error(`[cleanup] delete mp_mov: ${error.message}`);
      } catch (e) { console.error(`[cleanup] delete mp_mov threw:`, e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("ignorar + des-ignorar: flags, motivo, timestamp, reversibilidad", async () => {
    // ── Estado inicial ────────────────────────────────────────────────────
    const { data: pre } = await db
      .from("mp_movimientos").select("ignorado, ignorado_motivo, ignorado_at, ignorado_por, justificativo_tipo")
      .eq("id", mpMovId).maybeSingle();
    expect(pre?.ignorado).toBe(false);
    expect(pre?.ignorado_motivo).toBeNull();
    expect(pre?.justificativo_tipo).toBeNull();

    // ── Ignorar ──────────────────────────────────────────────────────────
    const { data: ignRes, error: ignErr } = await db.rpc("fn_ignorar_mp", {
      p_mp_mov_id: mpMovId,
      p_motivo: MOTIVO,
    });
    expect(ignErr).toBeNull();
    expect((ignRes as { ignorado: boolean }).ignorado).toBe(true);

    const { data: postIgn } = await db
      .from("mp_movimientos").select("ignorado, ignorado_motivo, ignorado_at, ignorado_por")
      .eq("id", mpMovId).maybeSingle();
    expect(postIgn?.ignorado).toBe(true);
    expect(postIgn?.ignorado_motivo).toBe(MOTIVO);
    expect(postIgn?.ignorado_at).not.toBeNull();
    expect(postIgn?.ignorado_por).not.toBeNull();   // usuario dueño autenticado

    // ── No se puede ignorar dos veces ────────────────────────────────────
    const { error: dobleErr } = await db.rpc("fn_ignorar_mp", {
      p_mp_mov_id: mpMovId, p_motivo: "intento duplicado",
    });
    expect(dobleErr?.message || "").toContain("MP_MOV_YA_IGNORADO");

    // ── Tampoco se puede conciliar mientras esté ignorado ────────────────
    const { error: conErr } = await db.rpc("fn_conciliar_mp_con_facturas", {
      p_mp_mov_id: mpMovId,
      p_lineas: [{ factura_id: "fake-id", monto_aplicado: 1 }],
    });
    // MP_MOV_IGNORADO o FACTURA_NO_ENCONTRADA — depende del orden de checks.
    // Lo importante: la RPC NO completó la conciliación (ignorado se mantiene).
    expect(conErr).not.toBeNull();
    const stillIgnorado = await db.from("mp_movimientos").select("ignorado").eq("id", mpMovId).maybeSingle();
    expect(stillIgnorado.data?.ignorado).toBe(true);

    // ── Des-ignorar ──────────────────────────────────────────────────────
    const { data: desRes, error: desErr } = await db.rpc("fn_designorar_mp", {
      p_mp_mov_id: mpMovId,
    });
    expect(desErr).toBeNull();
    expect((desRes as { ignorado: boolean }).ignorado).toBe(false);

    const { data: postDes } = await db
      .from("mp_movimientos").select("ignorado, ignorado_motivo, ignorado_at, ignorado_por")
      .eq("id", mpMovId).maybeSingle();
    expect(postDes?.ignorado).toBe(false);
    expect(postDes?.ignorado_motivo).toBeNull();
    expect(postDes?.ignorado_at).toBeNull();
    expect(postDes?.ignorado_por).toBeNull();

    // ── No se puede des-ignorar dos veces ────────────────────────────────
    const { error: desDobleErr } = await db.rpc("fn_designorar_mp", {
      p_mp_mov_id: mpMovId,
    });
    expect(desDobleErr?.message || "").toContain("MP_MOV_NO_IGNORADO");
  });
});
