import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSuperadminClient, createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: crear tenant nuevo end-to-end via endpoint /api/crear-tenant
// y verificar (a) las 4 tablas se poblaron correctamente, (b) el auth.user
// se creó, (c) el dueño nuevo puede loguear y NO ve data de Neko (aislamiento).
//
// Setup: requiere SUPERADMIN_PASSWORD en packages/pase/.env.local (gateado
// por createSuperadminClient — si falta, skip con mensaje accionable).
//
// Sentinel: slug `e2e-mutante-<timestamp>` para unicidad y trazabilidad.
// Cleanup: cada paso en su propio try/catch independiente (anular auth.user,
// borrar tenant_admins/usuarios/locales/tenants en orden inverso a FK).

const TIMESTAMP = Date.now();
const SENTINEL_SLUG = `e2e-mutante-${TIMESTAMP}`;
const SENTINEL_DUENO_EMAIL = `dueno-${TIMESTAMP}@e2e-mutante.local`;
const SENTINEL_DUENO_NOMBRE = `Dueño E2E ${TIMESTAMP}`;
const SENTINEL_LOCAL = `Local E2E ${TIMESTAMP}`;
const SENTINEL_PASSWORD = `e2e-pwd-${TIMESTAMP}-X9!`;

test.describe("Onboarding tenant — mutante", () => {
  let superdb: SupabaseClient | null = null;
  let duenoDb: SupabaseClient | null = null;
  let tenantId: string | null = null;
  let usuarioId: number | null = null;
  let localId: number | null = null;
  let authId: string | null = null;
  let superadminToken: string | null = null;

  test.beforeEach(async () => {
    superdb = await createSuperadminClient();
    if (!superdb) {
      test.skip(true, "SUPERADMIN_PASSWORD no seteado en packages/pase/.env.local. Agregar la línea SUPERADMIN_PASSWORD=<tu_password> al archivo (ya está en gitignore).");
      return;
    }
    const { data: sess } = await superdb.auth.getSession();
    superadminToken = sess?.session?.access_token || null;
    if (!superadminToken) throw new Error("No se obtuvo token superadmin");

    tenantId = null;
    usuarioId = null;
    localId = null;
    authId = null;
    duenoDb = null;
  });

  test.afterEach(async () => {
    // Cleanup en orden inverso a FK. Cada paso en su try/catch.
    // El auth.user se borra con supabaseAdmin pero desde el cliente normal
    // no podemos. La forma de revertir es vía endpoint dedicado o vía
    // las RPCs/DELETEs. Como mejor approach: el FK ON DELETE CASCADE de
    // tenant_admins → tenants debería limpiar tenant_admins al borrar tenant.
    // Las filas en usuarios y locales necesitan DELETE explícito porque
    // FK no es CASCADE (cada uno tiene su tenant_id pero rompería integrity
    // si borramos antes el tenant — orden correcto: locales/usuarios primero,
    // tenant_admins por cascade al borrar tenant, tenant al final).
    //
    // El auth.user queda huérfano. Sin endpoint admin desde el client, se
    // limpia con el rollback del endpoint si fallaba ahí — pero acá pasó
    // OK. Lucas tendría que limpiarlo manualmente desde Supabase Dashboard
    // si quedara orfano. Como mitigación, marcamos el email como sentinel
    // único (incluye timestamp) — fácil de filtrar después.
    if (duenoDb) {
      try { await duenoDb.auth.signOut(); } catch { /* idempotente */ }
    }
    if (!superdb) return;
    if (localId != null) {
      try {
        const { error } = await superdb.from("locales").delete().eq("id", localId);
        if (error) console.error(`[cleanup] delete locales(${localId}): ${error.message}`);
      } catch (e) { console.error("[cleanup] delete locales threw:", e); }
    }
    if (usuarioId != null) {
      try {
        const { error } = await superdb.from("usuarios").delete().eq("id", usuarioId);
        if (error) console.error(`[cleanup] delete usuarios(${usuarioId}): ${error.message}`);
      } catch (e) { console.error("[cleanup] delete usuarios threw:", e); }
    }
    if (tenantId) {
      try {
        // tenant_admins ON DELETE CASCADE — se borra automáticamente.
        const { error } = await superdb.from("tenants").delete().eq("id", tenantId);
        if (error) console.error(`[cleanup] delete tenants(${tenantId}): ${error.message}`);
      } catch (e) { console.error("[cleanup] delete tenants threw:", e); }
    }
    try { await superdb.auth.signOut(); } catch { /* idempotente */ }
  });

  test("crear tenant via endpoint: tenant + usuario + local + tenant_admin + login del dueño + aislamiento contra Neko", async ({ request }) => {
    // ── Act: POST al endpoint con datos sentinel ────────────────────────
    const resp = await request.post("/api/crear-tenant", {
      data: {
        nombre: `E2E Mutante ${TIMESTAMP}`,
        slug: SENTINEL_SLUG,
        plan: "trial",
        dueno_email: SENTINEL_DUENO_EMAIL,
        dueno_nombre: SENTINEL_DUENO_NOMBRE,
        dueno_password: SENTINEL_PASSWORD,
        local_nombre: SENTINEL_LOCAL,
        local_direccion: "Sentinel St 123",
        trial_dias: 7,
      },
      headers: {
        "Authorization": `Bearer ${superadminToken}`,
      },
    });

    const body = await resp.json();
    expect(resp.status()).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.slug).toBe(SENTINEL_SLUG);

    tenantId = body.tenant_id;
    usuarioId = body.usuario_id;
    localId = body.local_id;
    expect(tenantId).toBeTruthy();
    expect(usuarioId).toBeTruthy();
    expect(localId).toBeTruthy();

    // ── Assert 1: tenants ───────────────────────────────────────────────
    const { data: tenants } = await superdb!.from("tenants")
      .select("id, slug, plan, activo, trial_ends_at").eq("id", tenantId);
    expect(tenants?.length).toBe(1);
    expect(tenants?.[0]?.slug).toBe(SENTINEL_SLUG);
    expect(tenants?.[0]?.plan).toBe("trial");
    expect(tenants?.[0]?.activo).toBe(true);
    expect(tenants?.[0]?.trial_ends_at).toBeTruthy();

    // ── Assert 2: usuarios (dueño linkeado a auth.users) ────────────────
    const { data: usuarios } = await superdb!.from("usuarios")
      .select("id, email, rol, tenant_id, activo, password_temporal, auth_id")
      .eq("id", usuarioId);
    expect(usuarios?.length).toBe(1);
    expect(usuarios?.[0]?.email).toBe(SENTINEL_DUENO_EMAIL);
    expect(usuarios?.[0]?.rol).toBe("dueno");
    expect(usuarios?.[0]?.tenant_id).toBe(tenantId);
    expect(usuarios?.[0]?.activo).toBe(true);
    expect(usuarios?.[0]?.password_temporal).toBe(true);
    expect(usuarios?.[0]?.auth_id).toBeTruthy();
    authId = usuarios![0]!.auth_id as string;

    // ── Assert 3: locales ───────────────────────────────────────────────
    const { data: locales } = await superdb!.from("locales")
      .select("id, nombre, tenant_id").eq("id", localId);
    expect(locales?.length).toBe(1);
    expect(locales?.[0]?.nombre).toBe(SENTINEL_LOCAL);
    expect(locales?.[0]?.tenant_id).toBe(tenantId);

    // ── Assert 4: tenant_admins ─────────────────────────────────────────
    const { data: admins } = await superdb!.from("tenant_admins")
      .select("tenant_id, usuario_id, rol").eq("tenant_id", tenantId);
    expect(admins?.length).toBe(1);
    expect(admins?.[0]?.usuario_id).toBe(usuarioId);
    expect(admins?.[0]?.rol).toBe("dueno");

    // ── Assert 5: el dueño nuevo puede loguear con el password seteado ──
    // Importa: signIn con el email que va a Supabase Auth (que es el
    // SENTINEL_DUENO_EMAIL porque ya tiene @, no se le agrega @pase.local).
    const tmpClient = (await createDuenoClient()).auth; // solo para crear instance
    void tmpClient; // type-only, lo descarto

    // Crear cliente fresh para el dueño nuevo. createDuenoClient usa el
    // password fijo del dueño Neko, así que NO sirve acá. Hago el client
    // a mano con el helper de loadAnonKey indirectamente vía SuperadminClient
    // (reutilizo el mismo SUPABASE_URL + anon key).
    // Forma más simple: usar superdb (anon key) y signInWithPassword.
    const { createClient } = await import("@supabase/supabase-js");
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve: pathResolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = pathResolve(here, "..", ".env.local");
    const envRaw = readFileSync(envPath, "utf-8");
    const anonKey = envRaw.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m)?.[1].trim() || "";

    duenoDb = createClient("https://pduxydviqiaxfqnshhdc.supabase.co", anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: loginErr, data: loginData } = await duenoDb.auth.signInWithPassword({
      email: SENTINEL_DUENO_EMAIL,
      password: SENTINEL_PASSWORD,
    });
    expect(loginErr).toBeNull();
    expect(loginData?.user?.id).toBe(authId);

    // ── Assert 6: aislamiento — el dueño nuevo NO ve data de Neko ───────
    // Sus queries con RLS deben devolver 0 filas para los datos de Neko.
    const { data: ventasVistas } = await duenoDb.from("ventas").select("id", { count: "exact", head: false }).limit(10);
    // El dueño nuevo solo debería ver ventas de su propio tenant — que es 0
    // (recién creado, sin data).
    expect(ventasVistas?.length || 0).toBe(0);

    const { data: facturasVistas } = await duenoDb.from("facturas").select("id").limit(10);
    expect(facturasVistas?.length || 0).toBe(0);

    const { data: localesVistos } = await duenoDb.from("locales").select("id, tenant_id").limit(10);
    // Debería ver solo su propio local (el que creamos en el wizard).
    expect(localesVistos?.length).toBe(1);
    expect(localesVistos?.[0]?.id).toBe(localId);
    expect(localesVistos?.[0]?.tenant_id).toBe(tenantId);
  });
});
