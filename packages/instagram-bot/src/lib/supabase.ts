// Cliente Supabase de la web del bot de Instagram. MISMA base que
// PASE/COMANDA/MESA/Habitué — lee/escribe las tablas ig_* del ecosistema.
//
// Convención del repo (igual que packages/pase/src/lib/supabase.ts): la URL va
// hardcodeada; la anon key va por env (VITE_SUPABASE_ANON_KEY) para poder
// rotarla sin tocar código — ver ROTATE_ANON_KEY.md.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pduxydviqiaxfqnshhdc.supabase.co';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigurado = Boolean(anonKey);

let _client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!_client) {
    if (!anonKey) {
      throw new Error('Bot sin configurar: falta VITE_SUPABASE_ANON_KEY');
    }
    _client = createClient(SUPABASE_URL, anonKey, {
      auth: {
        // Mantener la sesión abierta: guardarla en localStorage y refrescar el
        // token solo automáticamente. storageKey propio del bot para no pisarse
        // con otras apps del ecosistema (misma project ref) abiertas en el navegador.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'cocina-ig-bot-auth',
      },
    });
  }
  return _client;
}
