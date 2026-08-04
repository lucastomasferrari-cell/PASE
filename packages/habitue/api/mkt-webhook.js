// Webhook público de Resend → ingesta de eventos de email marketing.
//
// Resend postea acá cada evento (email.delivered/opened/clicked/bounced/
// complained). Verificamos la firma (Svix) con RESEND_WEBHOOK_SECRET y
// registramos vía fn_mkt_registrar_evento (atómica). Configurar la URL de este
// endpoint + el secret en resend.com/webhooks.
//
// Nota: necesita el body CRUDO para verificar la firma → bodyParser off.

import { createClient } from '@supabase/supabase-js';
import { verificarFirmaWebhook, leerRawBody } from './_mkt.js';

export const config = { api: { bodyParser: false } };

// Mapea el tipo de evento de Resend a nuestro código interno.
const MAPA = {
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const raw = await leerRawBody(req);
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  // Si hay secret configurado, exigimos firma válida (fail-closed).
  if (secret) {
    const ok = verificarFirmaWebhook(secret, req.headers, raw);
    if (!ok) return res.status(401).json({ ok: false, error: 'firma_invalida' });
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { return res.status(400).json({ ok: false, error: 'json_invalido' }); }

  const tipo = MAPA[evt?.type];
  const emailId = evt?.data?.email_id;
  // Eventos que no trackeamos (sent, delivery_delayed) → 200 sin hacer nada.
  if (!tipo || !emailId) return res.status(200).json({ ok: true, ignorado: true });

  try {
    const db = createClient(
      process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } },
    );
    const url = evt?.data?.click?.link || null;
    const { data, error } = await db.rpc('fn_mkt_registrar_evento', {
      p_resend_email_id: emailId,
      p_tipo: tipo,
      p_url: url,
      p_metadata: evt?.data ? { to: evt.data.to, created_at: evt.created_at } : null,
    });
    if (error) return res.status(200).json({ ok: false, error: error.message }); // 200 para que Resend no reintente en loop
    return res.status(200).json({ ok: true, registrado: data === true });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
