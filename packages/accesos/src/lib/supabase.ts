// Cliente Supabase de Accesos. MISMA base que PASE/COMANDA/MESA/Habitué.
// Env vars (Vercel del proyecto Accesos + .env.local para dev):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigurado = Boolean(url && anonKey);

let _client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!_client) {
    if (!url || !anonKey) throw new Error('Accesos sin configurar: faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
    _client = createClient(url, anonKey);
  }
  return _client;
}
