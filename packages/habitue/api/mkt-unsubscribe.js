// Endpoint público de baja (unsubscribe). Sin login: el link del mail lleva un
// token firmado (email+tenant+HMAC) que verificamos acá.
//
//   GET  /api/mkt-unsubscribe?token=...  → da de baja + página de confirmación
//   POST (List-Unsubscribe-Post one-click, lo llaman Gmail/Yahoo solos) → baja + 200
//
// Da de baja vía fn_mkt_baja: supresión (do-not-send) + clientes.marketing_opt_in=false.

import { createClient } from '@supabase/supabase-js';
import { verificarBajaToken } from './_mkt.js';

function secretBaja() {
  return process.env.MKT_UNSUB_SECRET || process.env.CRON_SECRET || 'mkt-dev-secret';
}

function paginaHtml(ok, email) {
  const msg = ok
    ? `<h2>Listo, te diste de baja</h2><p>No vas a recibir más correos de marketing en <b>${email || ''}</b>.</p>`
    : `<h2>No pudimos procesar la baja</h2><p>El enlace no es válido o expiró. Escribinos y lo resolvemos.</p>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baja de correos</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:64px auto;padding:0 20px;color:#1a1a1a;text-align:center">
${msg}</body></html>`;
}

async function darDeBaja(token) {
  const parsed = verificarBajaToken(token, secretBaja());
  if (!parsed) return { ok: false, email: null };
  const db = createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } },
  );
  const { error } = await db.rpc('fn_mkt_baja', {
    p_tenant_id: parsed.tenantId,
    p_email: parsed.email,
    p_campana_id: null,
  });
  return { ok: !error, email: parsed.email, error: error?.message };
}

export default async function handler(req, res) {
  const token = (req.query?.token || req.body?.token || '').toString();

  // One-click (POST desde el cliente de mail): baja inmediata, respuesta mínima.
  if (req.method === 'POST') {
    const r = await darDeBaja(token);
    return res.status(r.ok ? 200 : 400).json({ ok: r.ok });
  }

  if (req.method === 'GET') {
    const r = await darDeBaja(token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(r.ok ? 200 : 400).send(paginaHtml(r.ok, r.email));
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
