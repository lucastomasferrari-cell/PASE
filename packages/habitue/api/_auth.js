// Auth helpers para los endpoints serverless de Habitué.
//
// SEGURIDAD (fix audit 26-jun CRIT-3):
//   Antes los endpoints (email-send, whatsapp-send, google-reviews, etc.) NO
//   validaban auth. Cualquiera podía mandar 100k emails/WAs gratis usando los
//   tokens de Resend/Meta del tenant, o leakear gasto Meta Ads.
//
// Uso (auth de usuario):
//   import { checkUserAuth } from './_auth.js';
//   export default async function handler(req, res) {
//     const auth = await checkUserAuth(req, res);
//     if (!auth) return; // ya respondió 401
//     // auth = { user, row, db }
//   }
//
// Uso (auth de cron):
//   import { checkCronAuth } from './_auth.js';
//   if (!checkCronAuth(req, res)) return;

import { createClient } from '@supabase/supabase-js';

const ALLOWED_ROLES = ['superadmin', 'dueno', 'admin', 'cajero', 'encargado'];

/**
 * Valida el JWT del usuario contra Supabase Auth y trae su row de `usuarios`.
 * Responde 401/403/500 al cliente si falla. Retorna null en ese caso.
 */
export async function checkUserAuth(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SVC = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SVC) {
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
    const db = createClient(SUPA_URL, SVC, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userErr } = await db.auth.getUser(token);
    if (userErr || !userData?.user) {
      res.status(401).json({ ok: false, error: 'invalid_or_expired_token' });
      return null;
    }
    const user = userData.user;
    const { data: row } = await db
      .from('usuarios')
      .select('id, rol, activo, tenant_id, apps_permitidas')
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
    // Defense-in-depth: si el user no tiene 'habitue' en apps_permitidas,
    // rechazar. (RLS de las tablas ya protege a nivel datos, pero gating de
    // app debería ser server-side también.)
    const apps = Array.isArray(row.apps_permitidas) ? row.apps_permitidas : ['pase'];
    if (!apps.includes('habitue')) {
      res.status(403).json({ ok: false, error: 'app_not_enabled', app: 'habitue' });
      return null;
    }
    return { user, row, db };
  } catch (e) {
    console.warn('[habitue-auth] validation threw:', e?.message);
    res.status(500).json({ ok: false, error: 'auth_threw' });
    return null;
  }
}

/**
 * Valida el CRON_SECRET (header Authorization Bearer <secret>).
 * Si la env var no está configurada, falla 500 (no deja pasar "porque sí").
 * Retorna true si OK, false si ya respondió error.
 */
export function checkCronAuth(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[habitue-cron] CRON_SECRET no configurado');
    res.status(500).json({ ok: false, error: 'CRON_SECRET_NOT_CONFIGURED' });
    return false;
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}
