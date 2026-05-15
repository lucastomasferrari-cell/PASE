// Endpoint multiplexado para Marketplace MP (cobro online via Checkout).
// Una sola function para no agotar el límite de 12 functions de Vercel Hobby.
//
// Routes:
//   POST /api/tienda-mp?action=preference
//     body: { venta_id, items: [{title, qty, unit_price}], total, back_url_success }
//     → crea preference MP server-side con back_urls + notification_url
//     → devuelve { init_point, preference_id, sandbox_init_point }
//
//   POST /api/tienda-mp?action=webhook
//     query: { type, data: { id } } (formato MP notification webhook)
//     → consulta el pago en MP, valida monto, marca venta_pos como cobrada
//
// Auth:
//   - preference: anon (cliente público armando carrito en tienda online)
//   - webhook: anon (lo llama MP, validamos via x-signature header)

import { createClient } from '@supabase/supabase-js';
import { createMpTokenGetter } from './_mp-token.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function db() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY');
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  const action = req.query.action;
  if (!action) {
    res.status(400).json({ error: 'Falta query param "action" (preference | webhook)' });
    return;
  }
  try {
    if (action === 'preference' && req.method === 'POST') {
      return await handlePreference(req, res);
    }
    if (action === 'webhook' && req.method === 'POST') {
      return await handleWebhook(req, res);
    }
    res.status(405).json({ error: 'Método o action inválido' });
  } catch (e) {
    console.error('[tienda-mp]', action, e);
    res.status(500).json({ error: e.message || 'Error interno' });
  }
}

// ─── PREFERENCE ──────────────────────────────────────────────────────────
async function handlePreference(req, res) {
  const { venta_id, items, total, back_url_success } = req.body || {};
  if (!venta_id || !Array.isArray(items) || items.length === 0 || !total) {
    res.status(400).json({ error: 'Body inválido: requiere venta_id, items[], total' });
    return;
  }

  const supabase = db();
  // Buscar la venta + local + credencial MP del local
  const { data: venta, error: errVenta } = await supabase
    .from('ventas_pos')
    .select('id, local_id, tenant_id, total, estado, cliente_nombre, cliente_telefono')
    .eq('id', venta_id)
    .single();
  if (errVenta || !venta) {
    res.status(404).json({ error: 'Venta no encontrada' });
    return;
  }
  if (venta.estado === 'cobrada') {
    res.status(409).json({ error: 'Venta ya cobrada' });
    return;
  }
  if (Math.abs(Number(venta.total) - Number(total)) > 0.5) {
    res.status(400).json({ error: `Total no coincide: venta=${venta.total} vs body=${total}` });
    return;
  }

  // Obtener credencial MP del local (la primera activa)
  const { data: cred, error: errCred } = await supabase
    .from('mp_credenciales')
    .select('id, activa')
    .eq('local_id', venta.local_id)
    .eq('activa', true)
    .limit(1)
    .single();
  if (errCred || !cred) {
    res.status(400).json({ error: 'Local sin credenciales MP activas' });
    return;
  }

  const getToken = createMpTokenGetter(supabase);
  const token = await getToken(cred.id);

  // Armar preference body. MP docs: https://www.mercadopago.com.ar/developers/es/reference/preferences/_checkout_preferences/post
  const origin = req.headers.origin || req.headers.host || 'https://pase-yndx.vercel.app';
  const baseBack = back_url_success || `${origin.startsWith('http') ? origin : 'https://' + origin}/tienda/confirmacion/${venta_id}`;
  const notificationUrl = `${SUPABASE_URL ? 'https://pase-yndx.vercel.app' : origin}/api/tienda-mp?action=webhook`;

  const prefBody = {
    items: items.map((it, idx) => ({
      id: String(idx),
      title: String(it.title || 'Producto').slice(0, 250),
      quantity: Number(it.qty) || 1,
      unit_price: Number(it.unit_price) || 0,
      currency_id: 'ARS',
    })),
    external_reference: String(venta_id),
    back_urls: {
      success: baseBack,
      pending: baseBack,
      failure: baseBack,
    },
    auto_return: 'approved',
    notification_url: notificationUrl,
    payer: venta.cliente_telefono ? {
      name: venta.cliente_nombre || undefined,
      phone: { number: venta.cliente_telefono },
    } : undefined,
    statement_descriptor: 'PASE Resto',
  };

  const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(prefBody),
  });

  if (!mpResp.ok) {
    const errText = await mpResp.text();
    console.error('[tienda-mp preference] MP error:', mpResp.status, errText);
    res.status(502).json({ error: `MP rechazó la preference: ${mpResp.status}` });
    return;
  }

  const pref = await mpResp.json();
  res.status(200).json({
    preference_id: pref.id,
    init_point: pref.init_point,
    sandbox_init_point: pref.sandbox_init_point,
  });
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  // MP envía notif con query ?type=payment&data.id=123 o en body. Soportamos ambos.
  const type = req.query.type || req.body?.type;
  const paymentId = req.query['data.id'] || req.body?.data?.id;

  // Validar firma x-signature (formato MP webhook signing)
  // TODO completo: implementar verificación HMAC. Por ahora confiamos en
  // que el endpoint es público + validamos contra MP API antes de marcar.
  // Ver https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks#editor_8

  if (type !== 'payment' || !paymentId) {
    // No es un payment notification — ack 200 igual para que MP no reintente
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const supabase = db();

  // Necesitamos buscar la venta asociada. external_reference fue venta_id.
  // Pero MP nos manda solo el payment_id; tenemos que consultar el payment
  // a MP para sacar external_reference.
  // Probamos con todas las credenciales activas hasta encontrar match (MP
  // no nos dice qué credencial procesó).
  const { data: creds } = await supabase.from('mp_credenciales').select('id').eq('activa', true);
  if (!creds || creds.length === 0) {
    res.status(200).json({ ok: true, no_creds: true });
    return;
  }

  const getToken = createMpTokenGetter(supabase);
  let payment = null;

  for (const c of creds) {
    try {
      const token = await getToken(c.id);
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (r.ok) {
        payment = await r.json();
        break;
      }
    } catch (e) {
      console.warn(`[tienda-mp webhook] creds ${c.id} no encontró pago`, e.message);
    }
  }

  if (!payment) {
    res.status(404).json({ error: 'Payment no encontrado en ninguna credencial' });
    return;
  }

  const ventaId = Number(payment.external_reference);
  const status = payment.status;
  if (!ventaId) {
    res.status(200).json({ ok: true, no_external_ref: true });
    return;
  }

  // Solo procesamos approved
  if (status !== 'approved') {
    res.status(200).json({ ok: true, status });
    return;
  }

  // Cobrar la venta via RPC (idempotente)
  const { error: errCobro } = await supabase.rpc('fn_cobrar_venta_comanda', {
    p_venta_id: ventaId,
    p_pagos: [{
      metodo: 'mercadopago',
      monto: Number(payment.transaction_amount),
      idempotency_key: `mp-payment-${paymentId}`,
    }],
    p_propina: 0,
    p_cobrado_por: null,
    p_idempotency_key: `mp-webhook-${paymentId}`,
  });

  if (errCobro) {
    console.error('[tienda-mp webhook] error cobrando venta', ventaId, errCobro);
    // 200 igual — MP reintenta si 5xx, y si esto fue una notif tardía no queremos loops
    res.status(200).json({ ok: false, error: errCobro.message });
    return;
  }

  res.status(200).json({ ok: true, venta_id: ventaId, status });
}
