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
  const { error } = await client.auth.signInWithPassword({
    email: SUPERADMIN_EMAIL,
    password: pwd,
  });
  if (error) throw new Error(`Login superadmin falló: ${error.message}`);
  return client;
}
