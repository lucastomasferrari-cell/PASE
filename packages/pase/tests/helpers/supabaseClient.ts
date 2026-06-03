import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getCachedAuth, setCachedAuth } from "../e2e-full/setup/auth-cache";

// URL hardcodeada igual que src/lib/supabase.ts — el proyecto Supabase es uno solo.
const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";

// Email Auth del dueño: convención de la app es usuario + "@pase.local"
// cuando el username no contiene "@" (ver CLAUDE.md sección Auth).
const DUENO_EMAIL = "dueno@pase.local";
const DUENO_PASSWORD = "Renata2020";

function loadAnonKey(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", "..", ".env.local");
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m);
  if (!m || !m[1]) throw new Error(`VITE_SUPABASE_ANON_KEY no encontrada en ${envPath}`);
  // Vercel CLI desde v54 envuelve los valores en comillas dobles. Stripping
  // defensivo para retro-compat con .env.local viejos sin comillas.
  return m[1].trim().replace(/^"(.*)"$/, "$1");
}

/**
 * Cliente Supabase autenticado como dueño, para queries y RPCs en tests E2E
 * que necesitan inspeccionar/limpiar estado en la DB. La sesión usa Auth real
 * → respeta RLS igual que un dueño en el browser. No persistimos sesión: cada
 * llamada crea un cliente nuevo y hace login.
 */
export async function createDuenoClient(): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, loadAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Fast path: si hay token cacheado vigente (50min TTL), lo aplicamos
  // sin tocar Supabase Auth → evita rate limit.
  const cached = getCachedAuth(DUENO_EMAIL);
  if (cached) {
    const { error } = await client.auth.setSession({
      access_token: cached.access_token,
      refresh_token: cached.refresh_token,
    });
    if (!error) return client;
    // Si setSession falla (token revocado, etc.), fallback a login real.
  }

  const { data, error } = await client.auth.signInWithPassword({
    email: DUENO_EMAIL,
    password: DUENO_PASSWORD,
  });
  if (error) throw new Error(`Login dueño falló: ${error.message}`);
  if (data.session) {
    setCachedAuth(DUENO_EMAIL, data.session.access_token, data.session.refresh_token);
  }
  return client;
}

// Email Auth del superadmin (creado 2026-05-10 con flow manual: row en
// `usuarios` via pg + auth.user creado por Lucas en Supabase Dashboard).
const SUPERADMIN_EMAIL = "superadmin@pase.local";

function loadSuperadminPassword(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", "..", ".env.local");
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(/^SUPERADMIN_PASSWORD=(.+)$/m);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Cliente Supabase autenticado como superadmin, para tests E2E de operaciones
 * que requieren ese rol (crear/eliminar tenants, ver data cross-tenant).
 * Gateado por env var `SUPERADMIN_PASSWORD` en `packages/pase/.env.local` —
 * si no está seteada, el llamador debería skipar el test. Esto evita
 * commitear el password y no asume su existencia en CI.
 *
 * Retorna null si la env var no está disponible — el test debe manejar el
 * caso con `test.skip()` y mensaje accionable.
 */
export async function createSuperadminClient(): Promise<SupabaseClient | null> {
  const pwd = loadSuperadminPassword();
  if (!pwd) return null;
  const client = createClient(SUPABASE_URL, loadAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Fast path: token cacheado vigente → setSession sin tocar Auth.
  // Resuelve el rate limit definitivamente: 1 login real por sesión CI
  // en lugar de 85 logins.
  const cached = getCachedAuth(SUPERADMIN_EMAIL);
  if (cached) {
    const { error } = await client.auth.setSession({
      access_token: cached.access_token,
      refresh_token: cached.refresh_token,
    });
    if (!error) return client;
    // Fallback a login real si el token cacheado está revocado.
  }

  // Login real con retry exponencial — defensive fallback en caso de que el
  // cache no exista aún (primer test) y el primer login coincida con un
  // burst de logins de otro proceso (raro, pero pasa en CI con paralelismo).
  const backoffs = [0, 2000, 5000, 10000, 20000];
  let lastError: Error | null = null;
  for (const wait of backoffs) {
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const { data, error } = await client.auth.signInWithPassword({
      email: SUPERADMIN_EMAIL,
      password: pwd,
    });
    if (!error) {
      if (data.session) {
        setCachedAuth(SUPERADMIN_EMAIL, data.session.access_token, data.session.refresh_token);
      }
      return client;
    }
    lastError = new Error(error.message);
    if (!/rate.?limit/i.test(error.message)) break;
  }
  throw new Error(`Login superadmin falló (tras retry): ${lastError?.message ?? "desconocido"}`);
}
