// ─────────────────────────────────────────────────────────────────────────
// E2E Test 30 — marcar_tarea_completada (TareasPineadasWidget)
//
// RPC del 17-may (commit 7946795) que destraba un bug RLS silencioso:
// el widget mostraba el botón "Marcar como completada" a CUALQUIER user
// pero la policy `pinned_modify` solo permitía UPDATE a dueño/admin →
// encargados clickeaban y nada pasaba (0 rows, sin error).
//
// La RPC es SECURITY DEFINER, valida que el caller sea target_usuario o
// tenga target_rol (o sea dueño/admin), y hace UPDATE bypaseando RLS.
// Idempotente: si ya está completada, retorna sin error.
//
// Verifica:
//  A) Dueño marca su propia tarea como completada → OK
//  B) Re-llamar es idempotente → no error
//  C) Marcar nota que NO es tarea (es_tarea=false) → error NO_ES_TAREA
//  D) Marcar nota que no existe → error NOTA_INEXISTENTE
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

test.describe.serial("E2E Test 30 — marcar_tarea_completada", () => {
  let seed: E2ETenantSeedResult | null = null;

   
  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("marcar tarea → completada + idempotente + casos error", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // ── A) Crear tarea pineada para el dueño + marcar completada ──────
    const { data: tarea, error: insErr } = await svc.from("dashboard_pinned_notes").insert({
      tenant_id: seed.tenantId,
      contenido: "E2E test tarea para marcar",
      es_tarea: true,
      target_usuario_id: seed.duenoUsuarioId,
      target_rol: null,
      autor_id: seed.duenoUsuarioId,
    }).select("id").single();
    if (insErr) throw new Error(`insert tarea: ${insErr.message}`);

    const { error: marcErr } = await duenoDb.rpc("marcar_tarea_completada", { p_nota_id: tarea!.id });
    if (marcErr) throw new Error(`marcar_tarea_completada: ${marcErr.message}`);

    const { data: completada } = await svc.from("dashboard_pinned_notes")
      .select("completada_at, completada_por").eq("id", tarea!.id).single();
    expect(completada!.completada_at).not.toBeNull();
    expect(completada!.completada_por).toBe(seed.duenoUsuarioId);

    // ── B) Idempotente: re-llamar no falla ────────────────────────────
    const { error: idemErr } = await duenoDb.rpc("marcar_tarea_completada", { p_nota_id: tarea!.id });
    expect(idemErr).toBeNull();

    // ── C) Marcar NOTA que no es tarea → error NO_ES_TAREA ────────────
    const { data: nota } = await svc.from("dashboard_pinned_notes").insert({
      tenant_id: seed.tenantId,
      contenido: "E2E nota informativa, no es tarea",
      es_tarea: false,
      target_usuario_id: seed.duenoUsuarioId,
      target_rol: null,
      autor_id: seed.duenoUsuarioId,
    }).select("id").single();

    const { error: notErr } = await duenoDb.rpc("marcar_tarea_completada", { p_nota_id: nota!.id });
    expect(notErr).not.toBeNull();
    expect(notErr!.message).toContain("NO_ES_TAREA");

    // ── D) Marcar tarea inexistente → error NOTA_INEXISTENTE ──────────
    const { error: noEx } = await duenoDb.rpc("marcar_tarea_completada", { p_nota_id: 99999999 });
    expect(noEx).not.toBeNull();
    expect(noEx!.message).toContain("NOTA_INEXISTENTE");

    await duenoDb.auth.signOut();
  });
});
