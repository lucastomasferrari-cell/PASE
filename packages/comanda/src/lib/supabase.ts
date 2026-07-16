import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pduxydviqiaxfqnshhdc.supabase.co';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_KEY) {
  throw new Error(
    'VITE_SUPABASE_ANON_KEY no configurada. Pegala en .env.local (copiá .env.example).',
  );
}

// Sesión aislada por pestaña (16-jul): una pestaña abierta con `?sesion=nueva`
// (los botones Admin↔POS) usa sessionStorage en vez de localStorage → tiene su
// PROPIA sesión, independiente de las otras pestañas. Así se puede tener el POS
// (cuenta del local) y el Admin (cuenta personal) abiertos a la vez sin que uno
// pise al otro. El marcador vive en sessionStorage (persiste en la pestaña).
function tabAislada(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get('sesion') === 'nueva') sessionStorage.setItem('comanda_tab_aislada', '1');
    return sessionStorage.getItem('comanda_tab_aislada') === '1';
  } catch { return false; }
}
const AISLADA = tabAislada();

// Sin generic Database: postgrest-js v12 strict types chocan con Partial<Row>.
// Los services proveen types al borde (signatures); las queries internas son
// loose-typed. Cuando estabilicemos el schema, regenerar con
// `supabase gen types typescript` y volver a aplicar el generic.
export const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    ...(AISLADA ? { storage: window.sessionStorage, storageKey: 'sb-comanda-aislada-auth' } : {}),
  },
});
