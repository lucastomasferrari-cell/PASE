// ─────────────────────────────────────────────────────────────────────────
// E2E Test 31 — Sprint COMANDA Autónomo (Fases 1-3, 24-may)
//
// Cubre que COMANDA y PASE son sistemas autónomos complementarios:
//  - Auth compartido (auth.users único)
//  - Perfiles separados (`comanda_usuarios` vs `usuarios`)
//  - Permisos separados (`comanda_usuario_permisos` con slugs comanda.*)
//  - Multi-tenant (RLS dual igual que PASE)
//
// Casos cubiertos:
//  A) Crear comanda_usuario via API /api/auth-admin action='create_comanda'
//     → reusa auth_id si email ya existe en usuarios PASE
//  B) Permisos asignados se guardan correctamente
//  C) RPC comanda_auth_tiene_permiso retorna correcto según rol_pos + slugs
//  D) rol_pos='admin' bypassa TODOS los chequeos (acceso total)
//  E) RLS: user del tenant E2E NO ve comanda_usuarios de otros tenants
//  F) Crear user solo-COMANDA (email no existe en PASE) → crea auth.user nuevo
//  G) Cleanup permite borrar comanda_usuario + cascada en permisos
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
  E2E_DUENO_EMAIL,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Test 31 — Sprint COMANDA Autónomo", () => {
  let seed: E2ETenantSeedResult | null = null;
  const baseUrl = "https://pase-yndx.vercel.app";

   
  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("A+B) crear comanda_usuario para user PASE existente → reusa auth_id + permisos OK", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Obtener auth_id del dueño E2E (creado en seedE2ETenant via signUp PASE)
    const { data: pasaDueno } = await svc.from("usuarios")
      .select("auth_id, email").eq("email", E2E_DUENO_EMAIL).single();
    expect(pasaDueno?.auth_id).toBeTruthy();

    // Crear comanda_usuario para él via API
    const { data: sessData } = await duenoDb.auth.getSession();
    const jwt = sessData.session?.access_token;
    const resp = await fetch(`${baseUrl}/api/auth-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        action: "create_comanda",
        nombre: "Dueño E2E COMANDA",
        email: E2E_DUENO_EMAIL,
        rol_pos: "manager",
        locales: [seed.local1Id],
        permisos: [
          "comanda.ventas.abrir",
          "comanda.ventas.cobrar",
          "comanda.ventas.anular",
          "comanda.ventas.descuento",
        ],
      }),
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(`create_comanda: ${json.error}`);

    // Verificar fila comanda_usuario creada
    const { data: cuRow } = await svc.from("comanda_usuarios")
      .select("id, auth_id, rol_pos, locales, activo")
      .eq("email", E2E_DUENO_EMAIL).eq("tenant_id", seed.tenantId).single();
    expect(cuRow).toBeTruthy();
    expect(cuRow!.auth_id).toBe(pasaDueno!.auth_id);   // REUSA auth_id
    expect(cuRow!.rol_pos).toBe("manager");
    expect(cuRow!.locales).toEqual([seed.local1Id]);
    expect(cuRow!.activo).toBe(true);

    // Verificar permisos creados
    const { data: perms } = await svc.from("comanda_usuario_permisos")
      .select("modulo_slug").eq("comanda_usuario_id", cuRow!.id);
    const slugs = (perms || []).map(p => p.modulo_slug).sort();
    expect(slugs).toEqual([
      "comanda.ventas.abrir",
      "comanda.ventas.anular",
      "comanda.ventas.cobrar",
      "comanda.ventas.descuento",
    ]);

    await duenoDb.auth.signOut();
  });

  test("C) comanda_auth_tiene_permiso retorna correcto según slugs asignados", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();

    // Dueño E2E ya tiene rol_pos='manager' con 4 permisos del test anterior
    const { data: tieneCobrar } = await duenoDb.rpc("comanda_auth_tiene_permiso", { p_slug: "comanda.ventas.cobrar" });
    const { data: tieneCortesia } = await duenoDb.rpc("comanda_auth_tiene_permiso", { p_slug: "comanda.items.cortesia" });
    const { data: tieneMermaSlug } = await duenoDb.rpc("comanda_auth_tiene_permiso", { p_slug: "comanda.inventario.merma" });
    expect(tieneCobrar).toBe(true);          // sí está asignado
    expect(tieneCortesia).toBe(false);       // NO está asignado
    expect(tieneMermaSlug).toBe(false);      // NO está asignado

    await duenoDb.auth.signOut();
  });

  test("D) rol_pos='admin' bypassa TODOS los permisos", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Promover el dueño E2E a admin POS
    await svc.from("comanda_usuarios").update({ rol_pos: "admin" })
      .eq("email", E2E_DUENO_EMAIL).eq("tenant_id", seed.tenantId);
    // BORRAR todos sus permisos individuales (admin no los necesita)
    const { data: cuRow } = await svc.from("comanda_usuarios")
      .select("id").eq("email", E2E_DUENO_EMAIL).eq("tenant_id", seed.tenantId).single();
    await svc.from("comanda_usuario_permisos").delete().eq("comanda_usuario_id", cuRow!.id);

    // Slugs que NO tiene → debe retornar true porque es admin
    const { data: r1 } = await duenoDb.rpc("comanda_auth_tiene_permiso", { p_slug: "comanda.items.cortesia" });
    const { data: r2 } = await duenoDb.rpc("comanda_auth_tiene_permiso", { p_slug: "comanda.inventario.merma" });
    const { data: r3 } = await duenoDb.rpc("comanda_auth_tiene_permiso", { p_slug: "slug.que.no.existe" });
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);  // admin bypassa incluso slugs inexistentes

    await duenoDb.auth.signOut();
  });

  test("E) RLS: dueño E2E NO ve comanda_usuarios de otros tenants", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();

    // SELECT desde el dueño E2E → solo debe ver users de SU tenant
    const { data: visibles } = await duenoDb.from("comanda_usuarios")
      .select("id, tenant_id, email");

    expect(visibles).toBeTruthy();
    expect(visibles!.length).toBeGreaterThanOrEqual(1);
    // Todos los visibles deben ser del tenant E2E
    for (const u of visibles!) {
      expect(u.tenant_id).toBe(seed.tenantId);
    }

    await duenoDb.auth.signOut();
  });

  test("F) Crear comanda_usuario con email nuevo (no en PASE) → crea auth.user", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const emailNuevo = `mozo-t31-${Date.now()}@e2e-test-suite.local`;
    const passwordNuevo = "MozoT31-2026-Test";

    const { data: sessData } = await duenoDb.auth.getSession();
    const jwt = sessData.session?.access_token;
    const resp = await fetch(`${baseUrl}/api/auth-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        action: "create_comanda",
        nombre: "Mozo Solo COMANDA",
        email: emailNuevo,
        password: passwordNuevo,
        rol_pos: "mozo",
        locales: [seed.local1Id],
        permisos: ["comanda.ventas.abrir"],
      }),
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(`create_comanda mozo: ${json.error}`);
    expect(json.auth_id).toBeTruthy();

    // Verificar que se creó la fila
    const { data: cuRow } = await svc.from("comanda_usuarios")
      .select("id, auth_id, rol_pos, email").eq("email", emailNuevo).single();
    expect(cuRow).toBeTruthy();
    expect(cuRow!.auth_id).toBe(json.auth_id);
    expect(cuRow!.rol_pos).toBe("mozo");

    // El mozo NO debe tener fila en `usuarios` de PASE (solo es POS)
    const { data: pasaRow } = await svc.from("usuarios")
      .select("id").eq("email", emailNuevo).maybeSingle();
    expect(pasaRow).toBeNull();

    await duenoDb.auth.signOut();
  });

  test("G) Eliminar comanda_usuario cascada en permisos", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Crear un user temp para borrarlo
    const emailTemp = `temp-t31-${Date.now()}@e2e-test-suite.local`;
    const { data: temp } = await svc.from("comanda_usuarios").insert({
      tenant_id: seed.tenantId,
      nombre: "Temp para borrar",
      email: emailTemp,
      rol_pos: "cajero",
    }).select("id").single();
    await svc.from("comanda_usuario_permisos").insert([
      { comanda_usuario_id: temp!.id, tenant_id: seed.tenantId, modulo_slug: "comanda.ventas.abrir" },
      { comanda_usuario_id: temp!.id, tenant_id: seed.tenantId, modulo_slug: "comanda.ventas.cobrar" },
    ]);

    // DELETE desde el dueño → debe pasar por RLS modify (es dueno)
    const { error: delErr } = await duenoDb.from("comanda_usuarios").delete().eq("id", temp!.id);
    expect(delErr).toBeNull();

    // Permisos cascadeados (ON DELETE CASCADE en FK)
    const { data: permsOrfanos } = await svc.from("comanda_usuario_permisos")
      .select("id").eq("comanda_usuario_id", temp!.id);
    expect(permsOrfanos).toHaveLength(0);

    await duenoDb.auth.signOut();
  });
});
