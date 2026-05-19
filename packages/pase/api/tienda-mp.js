// Endpoint multiplexado para integraciones externas (cobro + delivery partners).
// Una sola function para no agotar el límite de 12 functions de Vercel Hobby.
//
// Routes:
//   POST /api/tienda-mp?action=preference        → MP Checkout preference
//   POST /api/tienda-mp?action=webhook           → MP payment notification
//   POST /api/tienda-mp?action=rappi-webhook     → Rappi Partner API order webhook
//   POST /api/tienda-mp?action=pedidosya-webhook → PedidosYa POS Integration webhook
//   POST /api/tienda-mp?action=notify-pedido     → Email "Recibimos tu pedido"
//   POST /api/tienda-mp?action=notify-listo      → Email "Tu pedido está listo"
//
// Auth:
//   - preference: anon (cliente público armando carrito en tienda online)
//   - MP webhook: anon (validamos contra MP API antes de cobrar)
//   - notify-*: anon (idempotent — chequea notif_email_*_at antes de mandar)
//   - Rappi/PedidosYa webhooks: validar firma HMAC del partner header
//     (deuda: implementar cuando se tenga credencial real del partner).

import { createClient } from '@supabase/supabase-js';
import { createMpTokenGetter } from './_mp-token.js';
import { sendEmail, htmlPedidoConfirmado, htmlPedidoListo } from './_email.js';
import { createRappiClient, getRappiCredentials, verifyRappiWebhookSignature } from './_rappi.js';
import { checkUserAuth } from './_user-auth.js';

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
    if (action === 'deliverect-webhook' && req.method === 'POST') {
      return await handlePartnerWebhook(req, res, 'deliverect');
    }
    if (action === 'notify-pedido' && req.method === 'POST') {
      return await handleNotifyPedido(req, res);
    }
    if (action === 'notify-listo' && req.method === 'POST') {
      return await handleNotifyListo(req, res);
    }
    // ── Rappi: operaciones contra Rappi Restaurant Integration API v3 ──
    if (action === 'rappi-test' && req.method === 'POST') {
      return await handleRappiTest(req, res);
    }
    if (action === 'rappi-sync-menu' && req.method === 'POST') {
      return await handleRappiSyncMenu(req, res);
    }
    if (action === 'rappi-import-menu' && req.method === 'POST') {
      return await handleRappiImportMenu(req, res);
    }
    if (action === 'rappi-order-action' && req.method === 'POST') {
      return await handleRappiOrderAction(req, res);
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
  // Mapeo de local: lookup en mapeos_locales_externos por (provider, external_local_id).
  // Si vino ?local_id explícito en query, lo respetamos (modo testing/dev).
  // Si no hay mapeo Y no hay override, devolvemos 404 con mensaje claro para
  // que el dueño sepa que tiene que configurar el mapeo.
  const externalLocalId = String(
    payload.store_id ?? payload.local_id ?? payload.restaurant_id ?? payload.location_id ?? ''
  ) || null;

  let localId = Number(req.query.local_id) || null;
  if (!localId && externalLocalId) {
    const { data: mapeo } = await supabase.from('mapeos_locales_externos')
      .select('local_id')
      .eq('provider', provider)
      .eq('external_local_id', externalLocalId)
      .eq('activo', true)
      .maybeSingle();
    if (mapeo) localId = mapeo.local_id;
  }
  if (!localId) {
    res.status(404).json({
      error: `Sin mapeo de local para ${provider}.${externalLocalId ?? '(no se detectó external_local_id en payload)'}`,
      hint: 'Configurá el mapeo en /integraciones/' + (provider === 'pedidos-ya' ? 'pedidosya' : provider),
    });
    return;
  }

  const { data: local } = await supabase.from('locales').select('tenant_id').eq('id', localId).single();
  if (!local) {
    res.status(404).json({ error: `Local ${localId} no encontrado` });
    return;
  }

  // Canal slug por provider. Deliverect actúa como aggregator — usa el
  // canal del partner downstream que pase en payload.channel (rappi/peya/etc).
  // Por defecto, si Deliverect manda sin channel, lo mapeamos a 'deliverect'.
  const canalSlug = provider === 'rappi'
    ? 'rappi'
    : provider === 'pedidos-ya'
    ? 'pedidos-ya'
    : provider === 'deliverect'
    ? (payload.channel || 'deliverect')
    : provider;
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

  // External order ID — el ID que el partner usa para este pedido. Lo
  // necesitamos para llamadas de vuelta (take/dispatch/cancel).
  const externalOrderId = String(
    payload.order_id ?? payload.id ?? payload.external_id ?? ''
  ) || null;

  // Crear venta_pos con estado necesita_aprobacion
  const { data: nuevaVenta, error: errVenta } = await supabase.from('ventas_pos').insert({
    tenant_id: local.tenant_id,
    local_id: localId,
    numero_local: Math.floor(Date.now() / 1000) % 100000, // temporal — fn_next_ticket_number_comanda mejor
    modo: 'pedidos',
    canal_id: canal.id,
    estado: 'necesita_aprobacion',
    origen: 'webhook_' + provider,
    external_order_id: externalOrderId,
    external_provider: provider,
    tipo_entrega: payload.delivery ? 'delivery' : 'retiro',
    cliente_nombre: clienteNombre,
    cliente_telefono: clienteTelefono,
    cliente_direccion: clienteDireccion,
    subtotal: total,
    total: total,
    notas: payload.instructions || payload.notes || `Pedido externo ${provider} #${externalOrderId ?? '?'}`,
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

// ─── NOTIFY: Recibimos tu pedido ────────────────────────────────────────────
async function handleNotifyPedido(req, res) {
  const { venta_id, email_destinatario } = req.body || {};
  if (!venta_id || !email_destinatario) {
    res.status(400).json({ error: 'venta_id y email_destinatario requeridos' });
    return;
  }

  const supabase = db();

  // Lookup venta + local. Idempotency: si ya hay notif_email_recibido_at, skip.
  const { data: venta, error: verr } = await supabase
    .from('ventas_pos')
    .select('id, local_id, numero_local, total, tipo_entrega, cliente_nombre, notif_email_recibido_at, programada_para')
    .eq('id', venta_id)
    .single();
  if (verr || !venta) { res.status(404).json({ error: 'Venta no encontrada' }); return; }

  if (venta.notif_email_recibido_at) {
    res.status(200).json({ ok: true, skipped: 'YA_ENVIADO', sent_at: venta.notif_email_recibido_at });
    return;
  }

  const { data: local, error: lerr } = await supabase
    .from('locales').select('nombre').eq('id', venta.local_id).single();
  if (lerr || !local) { res.status(404).json({ error: 'Local no encontrado' }); return; }
  const { data: cls } = await supabase
    .from('comanda_local_settings')
    .select('slug, telefono, tiempo_delivery_min, tiempo_retiro_min')
    .eq('local_id', venta.local_id).single();

  // URL pública de seguimiento. Origin = host del request (PASE).
  const origin = req.headers.origin || (`https://${req.headers.host || 'pase-yndx.vercel.app'}`);
  const seguimientoUrl = `${origin}/comanda-app/tienda/${cls?.slug ?? ''}/confirmacion/${venta_id}`;

  const tiempo = venta.tipo_entrega === 'delivery'
    ? cls?.tiempo_delivery_min
    : cls?.tiempo_retiro_min;

  const html = htmlPedidoConfirmado({
    localNombre: local.nombre,
    clienteNombre: venta.cliente_nombre ?? '',
    ventaNumero: venta.numero_local ?? venta.id,
    total: venta.total,
    tipoEntrega: venta.tipo_entrega,
    tiempoEstimado: tiempo,
    seguimientoUrl,
    telefono: cls?.telefono ?? null,
  });

  const sent = await sendEmail({
    to: email_destinatario,
    subject: `Recibimos tu pedido — ${local.nombre}`,
    html,
  });

  if (!sent.ok && !sent.skipped) {
    res.status(502).json({ error: sent.error, detail: sent.detail });
    return;
  }

  // Marcar como enviado (también si skipped, así no reintenta cada navegación).
  // eslint-disable-next-line pase-local/no-direct-financiera-write -- campo no-financiero (timestamp notif), endpoint server-side con service_role
  await supabase
    .from('ventas_pos')
    .update({ notif_email_recibido_at: new Date().toISOString() })
    .eq('id', venta_id);

  res.status(200).json({ ok: true, sent: !sent.skipped, email_id: sent.id });
}

// ─── NOTIFY: Tu pedido está listo ───────────────────────────────────────────
// Llamado por el POS cuando alguien marca venta como 'lista'. Idempotency
// igual que el de arriba.
async function handleNotifyListo(req, res) {
  const { venta_id, email_destinatario } = req.body || {};
  if (!venta_id) {
    res.status(400).json({ error: 'venta_id requerido' });
    return;
  }

  const supabase = db();
  const { data: venta, error: verr } = await supabase
    .from('ventas_pos')
    .select('id, local_id, numero_local, tipo_entrega, cliente_nombre, cliente_email, notif_email_listo_at')
    .eq('id', venta_id)
    .single();
  if (verr || !venta) { res.status(404).json({ error: 'Venta no encontrada' }); return; }

  if (venta.notif_email_listo_at) {
    res.status(200).json({ ok: true, skipped: 'YA_ENVIADO' });
    return;
  }

  // Email viene del body o de la columna ventas_pos.cliente_email (migration
  // 202605200200). Si no hay ninguno, skip silencioso — pedidos sin email
  // (POS interno o cliente que no quiso dar) no rompen el flow del POS.
  const emailFinal = email_destinatario || venta.cliente_email;
  if (!emailFinal) {
    res.status(200).json({ ok: true, skipped: 'NO_EMAIL' });
    return;
  }

  const { data: local } = await supabase
    .from('locales').select('nombre').eq('id', venta.local_id).single();
  const { data: cls } = await supabase
    .from('comanda_local_settings')
    .select('direccion, telefono')
    .eq('local_id', venta.local_id).single();

  const html = htmlPedidoListo({
    localNombre: local?.nombre ?? '',
    clienteNombre: venta.cliente_nombre ?? '',
    ventaNumero: venta.numero_local ?? venta.id,
    tipoEntrega: venta.tipo_entrega,
    direccionLocal: cls?.direccion ?? null,
    telefono: cls?.telefono ?? null,
  });

  const subject = venta.tipo_entrega === 'delivery'
    ? `Salió tu pedido — ${local?.nombre ?? ''}`
    : `Tu pedido está listo — ${local?.nombre ?? ''}`;

  const sent = await sendEmail({ to: emailFinal, subject, html });
  if (!sent.ok && !sent.skipped) {
    res.status(502).json({ error: sent.error, detail: sent.detail });
    return;
  }

  // eslint-disable-next-line pase-local/no-direct-financiera-write -- campo no-financiero
  await supabase
    .from('ventas_pos')
    .update({ notif_email_listo_at: new Date().toISOString() })
    .eq('id', venta_id);

  res.status(200).json({ ok: true, sent: !sent.skipped });
}

// ─── RAPPI: test de conexión (auth check) ─────────────────────────────
async function handleRappiTest(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;
  if (!['dueno', 'admin', 'superadmin'].includes(auth.row.rol)) {
    return res.status(403).json({ error: 'PERMISO_DENEGADO' });
  }

  const supabase = db();
  const creds = await getRappiCredentials(supabase, auth.row.tenant_id);
  if (!creds) return res.status(400).json({ error: 'RAPPI_NO_CONFIGURADA' });

  const useProduction = req.body?.production === true;
  try {
    const client = createRappiClient(creds, { production: useProduction });
    await client.testConnection();
    // Marcar como active
    await supabase.from('integraciones_externas_credenciales')
      .update({ estado: 'active', last_test_at: new Date().toISOString(), last_error: null })
      .eq('tenant_id', auth.row.tenant_id).eq('provider', 'rappi');
    res.status(200).json({ ok: true, message: 'Conexión exitosa con Rappi' });
  } catch (err) {
    const msg = err.message || String(err);
    await supabase.from('integraciones_externas_credenciales')
      .update({ estado: 'error', last_test_at: new Date().toISOString(), last_error: msg })
      .eq('tenant_id', auth.row.tenant_id).eq('provider', 'rappi');
    res.status(502).json({ error: 'RAPPI_TEST_FAILED', detail: msg });
  }
}

// ─── RAPPI: sync menú COMANDA → Rappi ─────────────────────────────────
// Toma todos los items + grupos del tenant, los convierte al formato JSON
// que pide Rappi y hace PUT al menu del store_id.
async function handleRappiSyncMenu(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;
  if (!['dueno', 'admin', 'superadmin'].includes(auth.row.rol)) {
    return res.status(403).json({ error: 'PERMISO_DENEGADO' });
  }

  const { store_id, local_id, production } = req.body || {};
  if (!store_id) return res.status(400).json({ error: 'STORE_ID_REQUERIDO' });

  const supabase = db();
  const creds = await getRappiCredentials(supabase, auth.row.tenant_id);
  if (!creds) return res.status(400).json({ error: 'RAPPI_NO_CONFIGURADA' });

  // Pull grupos + items + modificadores del tenant (filtrado por local si
  // se pasa local_id explícito; sin local_id = catálogo global del tenant).
  let itemsQ = supabase.from('items')
    .select('id, sku_rappi, nombre, descripcion, emoji, foto_url, precio_madre, grupo_id, visible_tienda, estado, agotado_at, agotado_hasta')
    .eq('tenant_id', auth.row.tenant_id)
    .is('deleted_at', null)
    .eq('visible_tienda', true);
  if (local_id) itemsQ = itemsQ.or(`local_id.eq.${local_id},local_id.is.null`);
  const { data: items, error: itemsErr } = await itemsQ;
  if (itemsErr) return res.status(500).json({ error: 'DB_ITEMS_FAILED', detail: itemsErr.message });

  const { data: grupos, error: gruposErr } = await supabase.from('item_grupos')
    .select('id, nombre, descripcion, orden')
    .eq('tenant_id', auth.row.tenant_id)
    .is('deleted_at', null)
    .order('orden');
  if (gruposErr) return res.status(500).json({ error: 'DB_GRUPOS_FAILED', detail: gruposErr.message });

  // Convertir a formato Rappi v3
  // Refs: services-staging.dev.rappi.com docs OpenAPI
  const menuPayload = {
    categories: (grupos || []).map((g) => ({
      external_id: `cat_${g.id}`,
      name: g.nombre,
      description: g.descripcion || '',
      sort_order: g.orden ?? 0,
    })),
    products: (items || []).map((it) => {
      const ahora = Date.now();
      const agotado = it.estado === 'agotado'
        || (it.agotado_at && (!it.agotado_hasta || new Date(it.agotado_hasta).getTime() > ahora));
      return {
        external_id: it.sku_rappi || `item_${it.id}`,
        category_external_id: it.grupo_id ? `cat_${it.grupo_id}` : null,
        name: it.nombre,
        description: it.descripcion || '',
        price: Number(it.precio_madre),
        image_url: it.foto_url || null,
        is_available: !agotado,
      };
    }),
    // modifier_groups + modifiers: TODO sprint Rappi#2 — requiere mapear
    // modifier_groups y modifier_options al schema Rappi. Por ahora menú
    // plano sin extras.
  };

  // PUT al endpoint de Rappi
  let result;
  try {
    const rappi = createRappiClient(creds, { production: !!production });
    result = await rappi.syncMenu(store_id, menuPayload);
  } catch (err) {
    const detail = err.message || String(err);
    await supabase.from('integraciones_externas_credenciales')
      .update({ estado: 'error', last_test_at: new Date().toISOString(), last_error: detail })
      .eq('tenant_id', auth.row.tenant_id).eq('provider', 'rappi');
    return res.status(502).json({ error: 'RAPPI_SYNC_FAILED', detail });
  }

  // Backfill items.sku_rappi si Rappi devolvió IDs nuevos en la respuesta
  // (Rappi v3 a veces retorna product_id asignado por ellos).
  if (result?.products && Array.isArray(result.products)) {
    for (const p of result.products) {
      if (p.external_id?.startsWith('item_') && p.rappi_id) {
        const internalId = parseInt(p.external_id.replace('item_', ''));
        if (Number.isFinite(internalId)) {
          await supabase.from('items').update({ sku_rappi: p.rappi_id }).eq('id', internalId);
        }
      }
    }
  }

  await supabase.from('integraciones_externas_credenciales')
    .update({ estado: 'active', last_test_at: new Date().toISOString(), last_error: null })
    .eq('tenant_id', auth.row.tenant_id).eq('provider', 'rappi');

  res.status(200).json({
    ok: true,
    productos_sincronizados: menuPayload.products.length,
    categorias_sincronizadas: menuPayload.categories.length,
  });
}

// ─── RAPPI: cambiar estado de pedido (take / dispatch / cancel) ────────
// Llamado desde el POS cuando el operador marca el pedido. Mapeo:
//   "Aceptar pedido" → take    (en_preparacion)
//   "Está listo / Salió" → dispatch
//   "Rechazar" → cancel con reason
async function handleRappiOrderAction(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;

  const { order_id, action: ordAction, prep_time_minutes, reason, production } = req.body || {};
  if (!order_id || !ordAction) {
    return res.status(400).json({ error: 'PARAMS_REQUERIDOS: order_id + action' });
  }
  if (!['take', 'dispatch', 'cancel'].includes(ordAction)) {
    return res.status(400).json({ error: 'ACTION_INVALIDA' });
  }

  const supabase = db();
  const creds = await getRappiCredentials(supabase, auth.row.tenant_id);
  if (!creds) return res.status(400).json({ error: 'RAPPI_NO_CONFIGURADA' });

  try {
    const rappi = createRappiClient(creds, { production: !!production });
    let result;
    if (ordAction === 'take') result = await rappi.takeOrder(order_id, prep_time_minutes || 30);
    else if (ordAction === 'dispatch') result = await rappi.dispatchOrder(order_id, prep_time_minutes || 0);
    else result = await rappi.cancelOrder(order_id, reason);

    res.status(200).json({ ok: true, action: ordAction, rappi_response: result });
  } catch (err) {
    res.status(502).json({ error: `RAPPI_${ordAction.toUpperCase()}_FAILED`, detail: err.message || String(err) });
  }
}

// ─── RAPPI: importar menú existente de Rappi → COMANDA ─────────────────────
// El dueño pega su store_id, el server hace GET al menú de Rappi, mapea
// categorías → item_grupos y productos → items en COMANDA (con sku_rappi
// pre-poblado). Idempotente: si un item ya existe con ese sku_rappi, lo
// actualiza en vez de duplicarlo.
//
// Esto es lo que hace Datalive y aggregators: con solo el store_id ya
// tenés todo tu catálogo importado, sin recargarlo de cero.
async function handleRappiImportMenu(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;
  if (!['dueno', 'admin', 'superadmin'].includes(auth.row.rol)) {
    return res.status(403).json({ error: 'PERMISO_DENEGADO' });
  }

  const { store_id, local_id, production, dry_run } = req.body || {};
  if (!store_id) return res.status(400).json({ error: 'STORE_ID_REQUERIDO' });

  const supabase = db();
  const creds = await getRappiCredentials(supabase, auth.row.tenant_id);
  if (!creds) return res.status(400).json({ error: 'RAPPI_NO_CONFIGURADA' });

  // 1) Pull del menú de Rappi
  let rappiMenu;
  try {
    const rappi = createRappiClient(creds, { production: !!production });
    rappiMenu = await rappi.getMenu(store_id);
  } catch (err) {
    return res.status(502).json({ error: 'RAPPI_GET_MENU_FAILED', detail: err.message || String(err) });
  }

  // 2) Normalizar shape — Rappi v3 a veces usa categories/products, otras
  // veces sections/items. Defensivo: intentamos las dos variantes.
  const categoriasRaw = rappiMenu?.categories ?? rappiMenu?.sections ?? rappiMenu?.menu?.categories ?? [];
  const productosRaw = rappiMenu?.products ?? rappiMenu?.items ?? rappiMenu?.menu?.products ?? [];

  if (!Array.isArray(categoriasRaw) || !Array.isArray(productosRaw)) {
    return res.status(502).json({
      error: 'RAPPI_MENU_SHAPE_INESPERADO',
      detail: 'No pudimos identificar categories[] ni products[] en el response. Revisar logs server.',
      raw_keys: rappiMenu ? Object.keys(rappiMenu) : [],
    });
  }

  // 3) Plan de cambios
  const tenantId = auth.row.tenant_id;
  const localId = local_id ? Number(local_id) : null;
  const summary = {
    grupos_a_crear: 0, grupos_a_actualizar: 0,
    items_a_crear: 0, items_a_actualizar: 0,
    items_ignorados: 0,
  };

  // Mapeo external_id Rappi → id COMANDA (para que productos referencien grupo correcto)
  const gruposMap = new Map(); // external_id Rappi → grupo_id COMANDA

  // 4) Procesar categorías
  for (const cat of categoriasRaw) {
    const nombre = (cat.name || cat.nombre || '').trim();
    if (!nombre) continue;
    const externalId = String(cat.external_id || cat.id || nombre);

    // Buscar grupo existente por external_id_rappi o por nombre como fallback
    const { data: existente } = await supabase
      .from('item_grupos')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('nombre', nombre)
      .is('deleted_at', null)
      .maybeSingle();

    if (existente) {
      gruposMap.set(externalId, existente.id);
      summary.grupos_a_actualizar++;
      if (!dry_run) {
        await supabase.from('item_grupos').update({
          descripcion: cat.description || cat.descripcion || null,
          orden: cat.sort_order ?? cat.orden ?? 0,
        }).eq('id', existente.id);
      }
    } else {
      summary.grupos_a_crear++;
      if (!dry_run) {
        const { data: nuevo } = await supabase.from('item_grupos').insert({
          tenant_id: tenantId,
          local_id: localId,
          nombre,
          descripcion: cat.description || cat.descripcion || null,
          orden: cat.sort_order ?? cat.orden ?? 0,
          color: '#94a3b8',
          activo: true,
        }).select('id').single();
        if (nuevo) gruposMap.set(externalId, nuevo.id);
      }
    }
  }

  // 5) Procesar productos
  for (const prod of productosRaw) {
    const nombre = (prod.name || prod.nombre || '').trim();
    if (!nombre) { summary.items_ignorados++; continue; }

    const skuRappi = String(prod.external_id || prod.id || `rappi_${Date.now()}_${Math.random()}`);
    const precio = Number(prod.price ?? prod.precio ?? 0);
    if (precio <= 0) { summary.items_ignorados++; continue; }

    const catExternalId = prod.category_external_id || prod.category_id || prod.section_id;
    const grupoId = catExternalId ? gruposMap.get(String(catExternalId)) : null;

    // Buscar por sku_rappi (preferido) o por nombre como fallback
    const { data: existente } = await supabase
      .from('items')
      .select('id')
      .eq('tenant_id', tenantId)
      .or(`sku_rappi.eq.${skuRappi},nombre.eq.${nombre}`)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();

    if (existente) {
      summary.items_a_actualizar++;
      if (!dry_run) {
        await supabase.from('items').update({
          nombre,
          descripcion: prod.description || prod.descripcion || null,
          precio_madre: precio,
          foto_url: prod.image_url || prod.foto_url || null,
          grupo_id: grupoId,
          sku_rappi: skuRappi,
          estado: (prod.is_available === false) ? 'agotado' : 'disponible',
        }).eq('id', existente.id);
      }
    } else {
      summary.items_a_crear++;
      if (!dry_run) {
        await supabase.from('items').insert({
          tenant_id: tenantId,
          local_id: localId,
          nombre,
          descripcion: prod.description || prod.descripcion || null,
          precio_madre: precio,
          foto_url: prod.image_url || prod.foto_url || null,
          grupo_id: grupoId,
          sku_rappi: skuRappi,
          estado: (prod.is_available === false) ? 'agotado' : 'disponible',
          visible_pos: true,
          visible_qr: false,    // Por defecto solo Rappi — el dueño puede activar después
          visible_tienda: false,
        });
      }
    }
  }

  // 6) Marcar integración como activa
  if (!dry_run) {
    await supabase.from('integraciones_externas_credenciales')
      .update({ estado: 'active', last_test_at: new Date().toISOString(), last_error: null })
      .eq('tenant_id', tenantId).eq('provider', 'rappi');
  }

  res.status(200).json({
    ok: true,
    dry_run: !!dry_run,
    summary,
  });
}

// Note: verifyRappiWebhookSignature está importada pero no usada todavía
// en handlePartnerWebhook (que es genérico). Wire-up de validación HMAC
// en sprint próximo cuando Lucas tenga creds reales para testear.
void verifyRappiWebhookSignature;
