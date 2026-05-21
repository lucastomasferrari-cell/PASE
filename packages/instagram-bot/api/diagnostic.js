// Endpoint diagnóstico — verifica configuración del bot sin exponer secrets.
//
// Devuelve metadata útil de cada env var:
//   - longitud del valor
//   - primeros 4 chars + últimos 4 chars (para comparar visualmente con Meta)
//   - status (set / missing)
//
// Auth: requiere JWT de un user dueño/admin de PASE en Authorization header.
// Eso garantiza que solo el dueño puede llamar este endpoint.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ─── Auth ───────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'NO_TOKEN' });
  }
  const token = authHeader.slice(7);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: authUser } = await db.auth.getUser(token);
  if (!authUser?.user?.id) {
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }

  const { data: usuario } = await db.from('usuarios')
    .select('id, rol, activo')
    .eq('auth_id', authUser.user.id)
    .single();

  if (!usuario || !usuario.activo) {
    return res.status(403).json({ ok: false, error: 'USER_NOT_AUTHORIZED' });
  }
  if (!['dueno', 'admin', 'superadmin'].includes(usuario.rol)) {
    return res.status(403).json({ ok: false, error: 'NOT_DUENO_OR_ADMIN' });
  }

  // ─── Helper para enmascarar valores ─────────────────────────────────
  function preview(v) {
    if (!v) return { set: false };
    return {
      set: true,
      length: v.length,
      first4: v.substring(0, 4),
      last4: v.substring(v.length - 4),
    };
  }

  // ─── Reporte ────────────────────────────────────────────────────────
  const report = {
    // Públicos (los muestro completos)
    IG_APP_ID: process.env.IG_APP_ID || '(missing)',
    OAUTH_REDIRECT_URI: process.env.OAUTH_REDIRECT_URI || '(missing — uses default)',
    PASE_BASE_URL: process.env.PASE_BASE_URL || '(missing — uses default)',
    // Secretos (preview enmascarado)
    IG_APP_SECRET: preview(process.env.IG_APP_SECRET),
    SUPABASE_SERVICE_KEY: preview(process.env.SUPABASE_SERVICE_KEY),
    ANTHROPIC_API_KEY: preview(process.env.ANTHROPIC_API_KEY),
    META_VERIFY_TOKEN: preview(process.env.META_VERIFY_TOKEN),
    META_APP_SECRET: preview(process.env.META_APP_SECRET),
    REFRESH_SECRET: preview(process.env.REFRESH_SECRET),
    SUPABASE_URL: process.env.SUPABASE_URL ? 'set' : '(missing)',
    // Metadata
    node_env: process.env.NODE_ENV,
    vercel_env: process.env.VERCEL_ENV,
    timestamp: new Date().toISOString(),
  };

  return res.status(200).json({ ok: true, report });
}
