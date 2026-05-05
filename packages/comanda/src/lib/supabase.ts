import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pduxydviqiaxfqnshhdc.supabase.co';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_KEY) {
  throw new Error(
    'VITE_SUPABASE_ANON_KEY no configurada. Pegala en .env.local (copiá .env.example).',
  );
}

// Sin generic Database: postgrest-js v12 strict types chocan con Partial<Row>.
// Los services proveen types al borde (signatures); las queries internas son
// loose-typed. Cuando estabilicemos el schema, regenerar con
// `supabase gen types typescript` y volver a aplicar el generic.
export const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
