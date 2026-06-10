// Cliente Supabase de MESA. MISMA base que PASE/COMANDA (por eso los tres
// productos se inter-relacionan: MESA lee mesas/ventas del POS, COMANDA ve
// las reservas, PASE ve la plata de eventos/giftcards).
//
// Env vars (Vercel del proyecto MESA + .env.local para dev):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigurado = Boolean(url && anonKey);

// Lazy para que la app pueda montar una pantalla de "falta config" en vez de
// explotar en el import si las env vars no están.
let _client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!_client) {
    if (!url || !anonKey) {
      throw new Error('MESA sin configurar: faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
    }
    _client = createClient(url, anonKey);
  }
  return _client;
}
