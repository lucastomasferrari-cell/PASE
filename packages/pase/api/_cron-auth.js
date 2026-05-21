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
//   usuarios.rol. Solo dueno/admin/superadmin pueden disparar (cajero NO
//   — fix auditoría 2026-05-21 ALTO-1: cajero podía disparar mp-sync con
//   reset cross-tenant).
//
// Path 3 — Solo dev local (sin CRON_BEARER seteado):
//   En desarrollo (sin VERCEL=1 ni CRON_BEARER) pasa todo, para que el
//   localhost no requiera setup. En producción/preview de Vercel, exigir
//   CRON_BEARER o JWT válido (fix auditoría 2026-05-21 ALTO-2: si la env
//   var se borraba accidentalmente, todos los endpoints quedaban abiertos
//   al mundo).
//
// Uso:
//   import { checkCronAuth } from './_cron-auth.js';
//   export default async function handler(req, res) {
//     if (!(await checkCronAuth(req, res))) return;
//     ... resto del handler
//   }

// ALTO-1 fix: 'cajero' removido — un cajero no debería poder disparar
// crons que afectan otros locales del tenant. Solo dueño/admin operacional
// + superadmin para Lucas. Si alguna pantalla específica necesita que un
// cajero dispare algo, expone ese endpoint específico con checkUserAuth.
const ALLOWED_ROLES = ['superadmin', 'dueno', 'admin'];

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

  // Path 3: Solo dev local sin CRON_BEARER. En producción (Vercel) o
  // preview (VERCEL=1), nunca dejamos pasar sin token válido.
  // ALTO-2 fix: antes pasaba todo si se borraba la env var por accidente.
  const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV;
  if (!cronExpected && !isVercel) {
    // Dev local sin secret seteado: pasa, pero log warning.
    console.warn('[cron-auth] DEV MODE: CRON_BEARER no seteado, request pasa sin auth');
    return true;
  }

  res.status(401).json({ ok: false, error: 'unauthorized' });
  return false;
}
