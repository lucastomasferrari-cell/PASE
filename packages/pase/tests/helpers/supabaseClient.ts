import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
  return m[1].trim();
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
  const { error } = await client.auth.signInWithPassword({
    email: DUENO_EMAIL,
    password: DUENO_PASSWORD,
  });
  if (error) throw new Error(`Login dueño falló: ${error.message}`);
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
  // Retry con backoff exponencial — Supabase rate-limita logins agresivamente
  // (~30/min/IP). En la suite E2E full hay 34 tests, cada uno hace login
  // superadmin en su beforeAll → garantizado golpear el límite. Sin retry,
  // los últimos ~5 tests fallaban con "Request rate limit reached".
  // Fix proper: globalSetup (1 solo login compartido) — anotado como deuda.
  const backoffs = [0, 2000, 5000, 10000, 20000];
  let lastError: Error | null = null;
  for (const wait of backoffs) {
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const { error } = await client.auth.signInWithPassword({
      email: SUPERADMIN_EMAIL,
      password: pwd,
    });
    if (!error) return client;
    lastError = new Error(error.message);
    // Si NO es rate limit, no tiene sentido retry — falla inmediato
    if (!/rate.?limit/i.test(error.message)) break;
  }
  throw new Error(`Login superadmin falló (tras retry): ${lastError?.message ?? "desconocido"}`);
}
