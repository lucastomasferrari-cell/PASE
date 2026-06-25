// Cliente Supabase de Habitué. MISMA base que PASE/COMANDA/MESA — el CRM lee
// los mismos clientes, reservas, ventas y reseñas del ecosistema.
//
// Env vars (Vercel del proyecto Habitué + .env.local para dev):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigurado = Boolean(url && anonKey);

let _client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!_client) {
    if (!url || !anonKey) {
      throw new Error('Habitué sin configurar: faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
    }
    _client = createClient(url, anonKey);
  }
  return _client;
}
