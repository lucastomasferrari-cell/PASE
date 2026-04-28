import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_KEY) {
  throw new Error(
    "VITE_SUPABASE_ANON_KEY no está configurada. Copiá .env.example a .env.local y pegá la anon key. En Vercel, configurala en Project Settings → Environment Variables."
  );
}

// TASK 0.16: opciones de auth explícitas. Aunque autoRefreshToken,
// persistSession y detectSessionInUrl son TRUE por default en
// @supabase/supabase-js v2, declararlas explícitamente documenta el
// contrato — el JWT se refresca solo, la sesión persiste en localStorage,
// y el callback de OAuth (si llega) se detecta automáticamente.
// El bug "0 locales tras 1h" reportado por Lucas NO era de configuración
// del client (ya estaba bien), sino del listener onAuthStateChange en
// App.tsx que ignoraba TOKEN_REFRESHED.
export const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
