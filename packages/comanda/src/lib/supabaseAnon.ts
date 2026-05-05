import { createClient } from '@supabase/supabase-js';

// Cliente Supabase para flujos públicos (tienda online, KDS, menú QR).
// Usa la misma URL y la misma ANON_KEY que el cliente principal, pero
// con persistSession=false y un storageKey distinto para no pisar la
// sesión del usuario que pudiera estar logueado en otra pestaña.
//
// Las RPCs públicas (fn_kds_*, fn_menu_qr_*, fn_get_pedido_publico_*) son
// SECURITY DEFINER y validan vía token. Las vistas públicas (v_locales_
// publicos, v_catalogo_publico) tienen GRANT a anon.

const SUPABASE_URL = 'https://pduxydviqiaxfqnshhdc.supabase.co';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_KEY) {
  throw new Error('VITE_SUPABASE_ANON_KEY no configurada para el cliente público.');
}

export const dbAnon = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
    storageKey: 'comanda-anon-noop',
  },
});
