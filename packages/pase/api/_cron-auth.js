// Auth dual-path para endpoints disparables tanto por cron (GitHub Actions)
// como manualmente desde el frontend (botón "Sincronizar ahora", "Reset
// datos", etc).
//
// Path 1 — Cron Bearer (machine-to-machine):
//   Authorization: Bearer ${CRON_BEARER}
//   El secret se setea en GH Actions Secrets + Vercel Env Vars (mismo valor).
//
// Path 2 — User JWT (frontend manual trigger):
//   Authorization: Bearer ${supabase_access_token}
//   Se valida con supabase admin client → auth.getUser(jwt) → lookup en
//   usuarios.rol. Solo dueno/admin/cajero/superadmin pueden disparar.
//
// Path 3 — Legacy (sin CRON_BEARER seteado):
//   Pasa todo. Backwards compat para dev local o setup intermedio.
//
// Uso:
//   import { checkCronAuth } from './_cron-auth.js';
//   export default async function handler(req, res) {
//     if (!(await checkCronAuth(req, res))) return;
//     ... resto del handler
//   }

const ALLOWED_ROLES = ['superadmin', 'dueno', 'admin', 'cajero'];

export async function checkCronAuth(req, res) {
  const header = req.headers?.authorization || '';
  const m = /^Bearer (.+)$/.exec(header);
  const token = m ? m[1] : null;

  // Path 1: Cron Bearer
  const cronExpected = process.env.CRON_BEARER;
  if (token && cronExpected && token === cronExpected) {
    return true;
  }

  // Path 2: Supabase user JWT — validamos contra Auth + tabla usuarios
  if (token && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: userData, error: userErr } = await admin.auth.getUser(token);
      const user = userData?.user;
      if (!userErr && user) {
        const { data: row } = await admin
          .from('usuarios')
          .select('rol, activo')
          .eq('auth_id', user.id)
          .maybeSingle();
        if (row && row.activo !== false && ALLOWED_ROLES.includes(row.rol)) {
          return true;
        }
      }
    } catch (e) {
      console.warn('[cron-auth] user-jwt validation threw:', e?.message);
    }
  }

  // Path 3: Backwards compat — sin CRON_BEARER en env, no validamos.
  // Solo aplica cuando la env var no está configurada (dev local).
  if (!cronExpected) {
    return true;
  }

  res.status(401).json({ ok: false, error: 'unauthorized' });
  return false;
}
