import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Mismo patrón que packages/pase/tests/helpers/supabaseClient.ts.
// El proyecto Supabase es compartido entre PASE y COMANDA, asi que las
// credenciales viven en packages/pase/.env.local. Las leemos desde ahí.
const SUPABASE_URL = 'https://pduxydviqiaxfqnshhdc.supabase.co';
const DUENO_EMAIL = 'dueno@pase.local';
const DUENO_PASSWORD = 'Renata2020';

function loadAnonKey(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/comanda/tests/helpers/ → ../../../pase/.env.local
  const envPath = resolve(here, '..', '..', '..', 'pase', '.env.local');
  const raw = readFileSync(envPath, 'utf-8');
  const m = raw.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m);
  if (!m || !m[1]) throw new Error(`VITE_SUPABASE_ANON_KEY no encontrada en ${envPath}`);
  return m[1].trim();
}

/**
 * Cliente Supabase autenticado como dueño Neko, para tests E2E mutantes
 * en COMANDA. La sesión usa Auth real → respeta RLS igual que un dueño
 * en el browser.
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
