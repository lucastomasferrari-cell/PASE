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
