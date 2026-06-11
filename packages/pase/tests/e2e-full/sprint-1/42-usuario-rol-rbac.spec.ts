// ─────────────────────────────────────────────────────────────────────────
// E2E Test 42 — Usuario PASE con rol RBAC (caso Socio, fix 11-jun)
//
// Cubre el flujo que estaba roto cuando Lucas intentó crear "SOCIOS DEVOTO":
//   1. Crear usuario PASE via /api/auth-admin CON Authorization header
//      (el fix: Usuarios.tsx/Config.tsx llamaban sin header → 401).
//   2. Asignarle el rol sistema "Socio" via sincronizar_permisos_usuario
//      con p_rol_id y CERO permisos sueltos (exactamente lo que hace la UI).
//   3. Loguear como el socio y verificar:
//      a. La query de hidratación del frontend (rol_permisos por rol_id)
//         le devuelve los permisos del rol — incluye 'rentabilidad'
//         (migración 202606111000) y 'eerr' (pantalla Reportes).
//      b. auth_tiene_permiso server-side: 'rentabilidad'/'finanzas' → true,
//         'rrhh'/'usuarios' → false.
//   4. Sumarle un permiso suelto ('gastos') y verificar la semántica OR:
//      rol + suelto conviven (auth_tiene_permiso true para ambos orígenes).
//
// Sin este test, el gap "frontend nunca lee rol_permisos" hubiera vuelto
// a escaparse: el backend funcionaba, la UI mostraba sidebar vacío.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";

test.describe.serial("E2E Test 42 — Usuario PASE con rol RBAC (Socio)", () => {
  let seed: E2ETenantSeedResult | null = null;
  const baseUrl = "https://pase-yndx.vercel.app";
  const socioEmail = `socio-t42-${Date.now()}@e2e-test-suite.local`;
  const socioPassword = "SocioT42-2026-Test!";
  let socioUsuarioId: number | null = null;
  let socioRolId: string | null = null;

  test.beforeAll(async () => {
    seed = loadSharedSeed();
  });

  test("1) Crear usuario via auth-admin con JWT + asignar rol Socio sin permisos sueltos", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const svc = createServiceClient();

    // Crear el usuario PASE (rol legacy 'encargado' — igual que la UI para
    // cualquier rol no-dueño).
    const { data: sessData } = await duenoDb.auth.getSession();
    const jwt = sessData.session?.access_token;
    const resp = await fetch(`${baseUrl}/api/auth-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        action: "create",
        nombre: "Socio T42",
        usuario: socioEmail,
        password: socioPassword,
        rol: "encargado",
        locales: [seed.local1Id],
      }),
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(`create socio: ${json.error}`);

    const { data: uRow } = await svc.from("usuarios")
      .select("id, rol_id").eq("email", socioEmail).single();
    expect(uRow).not.toBeNull();
    socioUsuarioId = uRow!.id as number;

    // Buscar el rol sistema Socio (tenant_id NULL, seed global 202605201900).
    const { data: rolRow } = await svc.from("roles")
      .select("id").eq("slug", "socio").is("tenant_id", null).single();
    expect(rolRow).not.toBeNull();
    socioRolId = rolRow!.id as string;

    // Asignar el rol vía la MISMA RPC que usa Usuarios.tsx, con CERO
    // permisos sueltos: el rol tiene que alcanzar por sí solo.
    const { error: rpcErr } = await duenoDb.rpc("sincronizar_permisos_usuario", {
      p_usuario_id: socioUsuarioId,
      p_rol: "encargado",
      p_modulos: [],
      p_locales: [seed.local1Id],
      p_cuentas_visibles: null,
      p_cuentas_operables: null,
      p_cuentas_all: true,
      p_rol_id: socioRolId,
    });
    if (rpcErr) throw new Error(`sincronizar_permisos_usuario: ${rpcErr.message}`);

    const { data: uAfter } = await svc.from("usuarios")
      .select("rol_id").eq("id", socioUsuarioId).single();
    expect(uAfter?.rol_id).toBe(socioRolId);

    await duenoDb.auth.signOut();
  });

  test("2) Login socio: hidratación frontend lee rol_permisos (incluye rentabilidad)", async () => {
    if (!seed || !socioUsuarioId || !socioRolId) { test.skip(true, "Paso 1 falló"); return; }
    const anonKey = await getAnonKey();
    const socioDb = createClient(SUPABASE_URL, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await signInReliable(socioDb, socioEmail, socioPassword);

    // Misma query que applyLogin (App.tsx) usa para hidratar _permisos.
    // Valida: (a) RLS de rol_permisos deja leer al usuario raso, (b) el rol
    // socio incluye los módulos de Dirección + rentabilidad (migración
    // 202606111000), (c) usuario_permisos está vacío (cero sueltos).
    const { data: rolPerms, error: rpErr } = await socioDb
      .from("rol_permisos").select("modulo_slug").eq("rol_id", socioRolId);
    expect(rpErr).toBeNull();
    const slugs = (rolPerms ?? []).map(p => p.modulo_slug).sort();
    expect(slugs).toContain("rentabilidad");
    expect(slugs).toContain("eerr");       // pantalla "Reportes"
    expect(slugs).toContain("finanzas");
    expect(slugs).toContain("negocio");
    expect(slugs).not.toContain("rrhh");
    expect(slugs).not.toContain("usuarios");

    const { data: sueltos } = await socioDb
      .from("usuario_permisos").select("modulo_slug").eq("usuario_id", socioUsuarioId);
    expect((sueltos ?? []).length).toBe(0);

    // Server-side: auth_tiene_permiso debe responder por el ROL (sin sueltos).
    const { data: tieneRent } = await socioDb.rpc("auth_tiene_permiso", { p_slug: "rentabilidad" });
    expect(tieneRent).toBe(true);
    const { data: tieneFin } = await socioDb.rpc("auth_tiene_permiso", { p_slug: "finanzas" });
    expect(tieneFin).toBe(true);
    const { data: tieneRrhh } = await socioDb.rpc("auth_tiene_permiso", { p_slug: "rrhh" });
    expect(tieneRrhh).toBe(false);
    const { data: tieneUsuarios } = await socioDb.rpc("auth_tiene_permiso", { p_slug: "usuarios" });
    expect(tieneUsuarios).toBe(false);

    await socioDb.auth.signOut();
  });

  test("3) Permiso suelto extra suma al rol (semántica OR)", async () => {
    if (!seed || !socioUsuarioId || !socioRolId) { test.skip(true, "Paso 1 falló"); return; }
    const duenoDb = await createE2EDuenoClient();

    // El dueño le suma 'gastos' como permiso suelto, manteniendo el rol.
    const { error: rpcErr } = await duenoDb.rpc("sincronizar_permisos_usuario", {
      p_usuario_id: socioUsuarioId,
      p_rol: "encargado",
      p_modulos: ["gastos"],
      p_locales: [seed.local1Id],
      p_cuentas_visibles: null,
      p_cuentas_operables: null,
      p_cuentas_all: true,
      p_rol_id: socioRolId,
    });
    if (rpcErr) throw new Error(`sincronizar (extra): ${rpcErr.message}`);
    await duenoDb.auth.signOut();

    const anonKey = await getAnonKey();
    const socioDb = createClient(SUPABASE_URL, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await signInReliable(socioDb, socioEmail, socioPassword);

    // Del rol (sigue): rentabilidad. Del suelto (nuevo): gastos.
    const { data: tieneRent } = await socioDb.rpc("auth_tiene_permiso", { p_slug: "rentabilidad" });
    expect(tieneRent).toBe(true);
    const { data: tieneGastos } = await socioDb.rpc("auth_tiene_permiso", { p_slug: "gastos" });
    expect(tieneGastos).toBe(true);
    // Lo que no está en ninguno de los dos: sigue negado.
    const { data: tieneRrhh } = await socioDb.rpc("auth_tiene_permiso", { p_slug: "rrhh" });
    expect(tieneRrhh).toBe(false);

    await socioDb.auth.signOut();
  });
});

// Mismos helpers que el test 32 (login con reintento + anon key del .env.local).
async function signInReliable(db: SupabaseClient, email: string, password: string): Promise<void> {
  let lastErr = "desconocido";
  for (let intento = 0; intento < 4; intento++) {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (!error && data.session?.access_token) {
      const { data: s } = await db.auth.getSession();
      if (s.session?.access_token) return;
      lastErr = "sesión no persistió tras login OK";
    } else {
      lastErr = error?.message ?? "login sin sesión";
    }
    await new Promise(r => setTimeout(r, 400 * (intento + 1)));
  }
  throw new Error(`login falló tras 4 intentos (${email}): ${lastErr}`);
}

async function getAnonKey(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", "..", "..", ".env.local");
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m);
  if (!m || !m[1]) throw new Error("VITE_SUPABASE_ANON_KEY no encontrada en .env.local");
  return m[1].trim();
}
