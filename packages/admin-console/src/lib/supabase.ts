import { createClient } from '@supabase/supabase-js';

// Admin Console comparte la DB con PASE/COMANDA. Solo el rol "superadmin"
// puede operar acá — el gate de auth está en src/lib/auth.ts.
//
// URL hardcodeado (es público — sale en cualquier request al browser) para
// que el deploy en Vercel solo necesite configurar una env var (la anon).
// Mismo pattern que packages/pase/src/lib/supabase.ts.
const SUPABASE_URL = 'https://pduxydviqiaxfqnshhdc.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_ANON_KEY) {
  throw new Error(
    'VITE_SUPABASE_ANON_KEY no está configurada. En Vercel: Settings → Environment Variables. Localmente: poné el valor en packages/admin-console/.env.local.',
  );
}

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
