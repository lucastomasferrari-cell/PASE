// Cliente de Supabase con service_role.
//
// El bot opera con privilegios elevados (bypassa RLS) porque el webhook
// no tiene un usuario logueado — es un servicio. Filtramos manualmente
// por tenant_id en cada query.
//
// IMPORTANTE: nunca exponer este cliente al frontend. Solo desde dentro
// de los serverless functions de este paquete.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
}

export const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
