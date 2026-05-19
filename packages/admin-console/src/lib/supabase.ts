import { createClient } from '@supabase/supabase-js';

// Admin Console comparte la DB con PASE/COMANDA. Solo el rol "superadmin"
// puede operar acá — el gate de auth está en src/lib/auth.ts.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY. Pegalas en .env.local antes de arrancar.',
  );
}

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
