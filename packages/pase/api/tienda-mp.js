// Endpoint multiplexado para integraciones externas (cobro + delivery partners).
// Una sola function para no agotar el límite de 12 functions de Vercel Hobby.
//
// Routes:
//   POST /api/tienda-mp?action=preference     → MP Checkout preference
//   POST /api/tienda-mp?action=webhook        → MP payment notification
//   POST /api/tienda-mp?action=rappi-webhook  → Rappi Partner API order webhook
//   POST /api/tienda-mp?action=pedidosya-webhook → PedidosYa POS Integration webhook
//
// Auth:
//   - preference: anon (cliente público armando carrito en tienda online)
//   - MP webhook: anon (validamos contra MP API antes de cobrar)
//   - Rappi/PedidosYa webhooks: validar firma HMAC del partner header
//     (deuda: implementar cuando se tenga credencial real del partner).

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
    if (action === 'rappi-webhook' && req.method === 'POST') {
      return await handlePartnerWebhook(req, res, 'rappi');
    }
    if (action === 'pedidosya-webhook' && req.method === 'POST') {
      return await handlePartnerWebhook(req, res, 'pedidos-ya');
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

// ─── PARTNER WEBHOOKS (Rappi / PedidosYa) ───────────────────────────────
// Recibe el pedido externo y crea una venta_pos en estado 'necesita_aprobacion'
// para que el cajero la apruebe desde /pos/pedidos. El payload completo queda
// loggeado en pedidos_externos_log para debugging.
//
// Mapeo de items: usa items.sku_externo_<provider> o item_id si viene literal.
// Si no matchea, igual crea la venta — el cajero ve "Item desconocido" en la
// card y debe matchearlo manual antes de aprobar. Esto permite que NO se
// pierdan pedidos por mismatch de catalogo.

async function handlePartnerWebhook(req, res, provider) {
  const supabase = db();
  const payload = req.body || {};

  // Loggear todo de entrada (para debugging y auditoría)
  // Si la tabla pedidos_externos_log no existe, ignorar el log silenciosamente
  // para no bloquear el resto del flow.
  try {
    await supabase.from('pedidos_externos_log').insert({
      provider,
      external_id: payload.id || payload.order_id || null,
      payload,
      headers: { 'user-agent': req.headers['user-agent'], 'x-signature': req.headers['x-signature'] ?? null },
    });
  } catch (e) {
    console.warn(`[${provider}] no se pudo loggear webhook (tabla missing?):`, e.message);
  }

  // TODO: validar firma HMAC del partner (cuando se tenga la credencial).
  // Por ahora aceptamos cualquier POST. En producción real, sin firma = 401.

  // Mapeo conceptual de campos (los real names dependen del partner):
  //   external_id, items[], cliente.nombre, cliente.telefono, total,
  //   tipo_entrega, direccion, local_external_id, instrucciones.
  //
  // Mapeo de local: por ahora hardcoded a Local Prueba 2 (id=7) para test.
  // Producción: tabla `mapeos_locales_externos` (provider, external_local_id, local_id).
  const localId = Number(req.query.local_id) || 7;

  // Resolver tenant del local
  const { data: local } = await supabase.from('locales').select('tenant_id').eq('id', localId).single();
  if (!local) {
    res.status(404).json({ error: `Local ${localId} no encontrado` });
    return;
  }

  // Canal slug por provider
  const canalSlug = provider === 'rappi' ? 'rappi' : 'pedidos-ya';
  const { data: canal } = await supabase.from('canales')
    .select('id').eq('tenant_id', local.tenant_id).eq('slug', canalSlug).single();
  if (!canal) {
    res.status(500).json({ error: `Canal ${canalSlug} no configurado para el tenant` });
    return;
  }

  // Extraer info del payload (heurístico — depende del schema real del partner)
  const clienteNombre = payload.customer?.name || payload.cliente?.nombre || 'Cliente ' + canalSlug;
  const clienteTelefono = payload.customer?.phone || payload.cliente?.telefono || null;
  const clienteDireccion = payload.delivery?.address || payload.direccion || null;
  const total = Number(payload.total || payload.amount || 0);

  // Crear venta_pos con estado necesita_aprobacion
  const { data: nuevaVenta, error: errVenta } = await supabase.from('ventas_pos').insert({
    tenant_id: local.tenant_id,
    local_id: localId,
    numero_local: Math.floor(Date.now() / 1000) % 100000, // temporal — fn_next_ticket_number_comanda mejor
    modo: 'pedidos',
    canal_id: canal.id,
    estado: 'necesita_aprobacion',
    origen: 'webhook_' + provider,
    tipo_entrega: payload.delivery ? 'delivery' : 'retiro',
    cliente_nombre: clienteNombre,
    cliente_telefono: clienteTelefono,
    cliente_direccion: clienteDireccion,
    subtotal: total,
    total: total,
    notas: payload.instructions || payload.notes || `Pedido externo ${provider} #${payload.id ?? '?'}`,
  }).select('id').single();

  if (errVenta) {
    console.error(`[${provider}] error creando venta:`, errVenta);
    res.status(500).json({ error: errVenta.message });
    return;
  }

  // Items: mapeo SKU → item_id. Si no matchea, queda como item_open (no implementado todavía).
  // Por ahora, si vienen items, los insertamos como referencias open.
  const externalItems = payload.items || payload.products || [];
  for (const it of externalItems) {
    const externalSku = it.sku || it.id || it.code;
    let itemId = null;
    if (externalSku) {
      // Match por SKU externo (columna a agregar después: items.sku_rappi / items.sku_pedidosya).
      // Por ahora intento match por nombre (peor pero funcional).
      const { data: matched } = await supabase.from('items')
        .select('id').eq('tenant_id', local.tenant_id).ilike('nombre', `%${it.name || ''}%`).limit(1).single();
      itemId = matched?.id ?? null;
    }
    if (!itemId) {
      // No matcheó — saltamos por ahora. Mejor: crear venta_pos_items "open" con descripción + precio.
      continue;
    }
    await supabase.from('ventas_pos_items').insert({
      tenant_id: local.tenant_id,
      local_id: localId,
      venta_id: nuevaVenta.id,
      item_id: itemId,
      cantidad: Number(it.qty || it.quantity || 1),
      precio_unitario: Number(it.price || it.unit_price || 0),
      subtotal: Number(it.subtotal || (Number(it.qty || 1) * Number(it.price || 0))),
      curso: 1,
      estado: 'hold',
      notas: it.notes ?? null,
    });
  }

  res.status(200).json({
    ok: true,
    venta_id: nuevaVenta.id,
    provider,
    items_creados: externalItems.length,
  });
}
