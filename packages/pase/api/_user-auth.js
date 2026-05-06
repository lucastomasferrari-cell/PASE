// Auth de USUARIO para endpoints expuestos a la UI (no cron).
//
// Diferencias con _cron-auth.js:
//   - NO acepta CRON_BEARER (machine-to-machine). Estos endpoints solo se
//     llaman desde el frontend con sesión Supabase.
//   - NO tiene path 3 "sin env vars → pasa". Si SUPABASE_URL o
//     SUPABASE_SERVICE_KEY no están seteados, falla 500 (config error).
//     En producción siempre autentica.
//
// Uso:
//   import { checkUserAuth } from './_user-auth.js';
//   export default async function handler(req, res) {
//     const auth = await checkUserAuth(req, res);
//     if (!auth) return; // helper ya envió 401/500
//     // auth = { user, row } — user de Supabase Auth + row de tabla usuarios
//     ...
//   }

const ALLOWED_ROLES = ['superadmin', 'dueno', 'admin', 'cajero', 'encargado'];

export async function checkUserAuth(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    res.status(500).json({ ok: false, error: 'auth_config_missing' });
    return null;
  }

  const header = req.headers?.authorization || '';
  const m = /^Bearer (.+)$/.exec(header);
  const token = m ? m[1] : null;
  if (!token) {
    res.status(401).json({ ok: false, error: 'missing_authorization_header' });
    return null;
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      res.status(401).json({ ok: false, error: 'invalid_or_expired_token' });
      return null;
    }
    const user = userData.user;
    const { data: row } = await admin
      .from('usuarios')
      .select('id, rol, activo, tenant_id')
      .eq('auth_id', user.id)
      .maybeSingle();
    if (!row) {
      res.status(401).json({ ok: false, error: 'user_not_in_tenant' });
      return null;
    }
    if (row.activo === false) {
      res.status(401).json({ ok: false, error: 'user_inactive' });
      return null;
    }
    if (!ALLOWED_ROLES.includes(row.rol)) {
      res.status(403).json({ ok: false, error: 'role_not_allowed' });
      return null;
    }
    return { user, row };
  } catch (e) {
    console.warn('[user-auth] validation threw:', e?.message);
    res.status(500).json({ ok: false, error: 'auth_threw' });
    return null;
  }
}
