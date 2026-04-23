import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_KEY) {
  throw new Error(
    "VITE_SUPABASE_ANON_KEY no está configurada. Copiá .env.example a .env.local y pegá la anon key. En Vercel, configurala en Project Settings → Environment Variables."
  );
}

export const db = createClient(SUPABASE_URL, SUPABASE_KEY);
