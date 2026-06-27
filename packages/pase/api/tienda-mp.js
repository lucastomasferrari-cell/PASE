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
import { sendEmail, htmlPedidoConfirmado, htmlPedidoListo, htmlPedidoRechazado, htmlPedidoEntregado } from './_email.js';
import { createRappiClient, getRappiCredentials, verifyRappiWebhookSignature } from './_rappi.js';
import { createPedidosYaClient, getPedidosYaCredentials, verifyPedidosYaWebhookSignature } from './_pedidosya.js';
import { findMatchingMpSecret } from './_mp-webhook.js';
import { checkUserAuth } from './_user-auth.js';
import { Afip } from '@afipsdk/afip.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// URL pública de COMANDA (post-cleanup 22-may noche: ya no vive embebida en
// /comanda-app/, tiene URL propia). Las URLs de seguimiento/calificación que
// salen por email apuntan acá. Default a la URL canónica si no hay env var.
const COMANDA_PUBLIC_URL = (process.env.VITE_COMANDA_URL || 'https://pase-comanda.vercel.app').replace(/\/$/, '');

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
    // MESA módulo #4 (09-jun): checkout de eventos con prepago y giftcards.
    // Mismo flujo MP que la tienda, external_reference con prefijo para que
    // el webhook rutee (evento:<id> / gift:<id> vs numérico = venta tienda).
    if (action === 'evento-preference' && req.method === 'POST') {
      return await handlePagoPublicoPreference(req, res, 'evento');
    }
    if (action === 'giftcard-preference' && req.method === 'POST') {
      return await handlePagoPublicoPreference(req, res, 'gift');
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
    if (action === 'notify-rechazado' && req.method === 'POST') {
      return await handleNotifyRechazado(req, res);
    }
    if (action === 'notify-entregado' && req.method === 'POST') {
      return await handleNotifyEntregado(req, res);
    }
    // ── Print Agent heartbeat (Sprint 2 impresoras) ──
    if (action === 'agent-heartbeat' && req.method === 'POST') {
      return await handleAgentHeartbeat(req, res);
    }
    // ── Cron: procesar emails de pedidos auto-entregados (delivery) ──
    // Llamado por cron externo (Vercel cron, GH Actions, etc) cada 1-2min.
    // Auth: header X-Cron-Token == process.env.CRON_TOKEN.
    if (action === 'cron-process-delivered' && req.method === 'POST') {
      return await handleCronProcessDelivered(req, res);
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
    // ── PedidosYa: operaciones contra PeYa POS Integration API ──
    if (action === 'pedidosya-test' && req.method === 'POST') {
      return await handlePedidosyaTest(req, res);
    }
    if (action === 'pedidosya-sync-menu' && req.method === 'POST') {
      return await handlePedidosyaSyncMenu(req, res);
    }
    if (action === 'pedidosya-import-menu' && req.method === 'POST') {
      return await handlePedidosyaImportMenu(req, res);
    }
    if (action === 'pedidosya-order-action' && req.method === 'POST') {
      return await handlePedidosyaOrderAction(req, res);
    }
    if (action === 'afip-test-connection' && req.method === 'POST') {
      return await handleAfipTestConnection(req, res);
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

  // Obtener credencial MP del local (la primera activa).
  // NOTA: la columna real es `activo` (sin 'a') — afip_credenciales sí usa
  // `activa`, mp_credenciales no. Fix 26-jun.
  const { data: cred, error: errCred } = await supabase
    .from('mp_credenciales')
    .select('id, activo')
    .eq('local_id', venta.local_id)
    .eq('activo', true)
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
    // AUDIT F5C#4: metadata.mp_credencial_id permite que el webhook resuelva
    // directo qué credencial procesó el pago sin iterar todas las creds activas
    // del sistema (era leak + side-channel timing cross-tenant).
    metadata: {
      mp_credencial_id: cred.id,
      tenant_id: venta.tenant_id,
      local_id: venta.local_id,
    },
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

// ─── MESA módulo #4: preference para eventos (prepago) y giftcards ────────
// tipo = 'evento' (evento_inscripciones) | 'gift' (giftcard_compras).
// El monto NUNCA viene del front: se lee de la fila pendiente_pago que creó
// la RPC pública (fn_inscribir_evento_publico / fn_comprar_giftcard_publica),
// que a su vez lo calculó server-side del catálogo.
async function handlePagoPublicoPreference(req, res, tipo) {
  const { id, back_url_success } = req.body || {};
  if (!id) {
    res.status(400).json({ error: 'Body inválido: requiere id' });
    return;
  }
  const supabase = db();

  let row, titulo, cantidad, monto;
  if (tipo === 'evento') {
    const { data, error } = await supabase
      .from('evento_inscripciones')
      .select('id, tenant_id, local_id, cantidad, monto_total, estado, nombre, telefono, eventos(titulo)')
      .eq('id', id).single();
    if (error || !data) { res.status(404).json({ error: 'Inscripción no encontrada' }); return; }
    row = data;
    titulo = `Evento: ${data.eventos?.titulo ?? 'Reserva de cupo'}`;
    cantidad = Number(data.cantidad) || 1;
    monto = Number(data.monto_total);
  } else {
    const { data, error } = await supabase
      .from('giftcard_compras')
      .select('id, tenant_id, local_id, monto, estado, comprador_nombre, comprador_telefono, giftcards(nombre)')
      .eq('id', id).single();
    if (error || !data) { res.status(404).json({ error: 'Compra no encontrada' }); return; }
    row = data;
    titulo = `Giftcard: ${data.giftcards?.nombre ?? 'Regalo'}`;
    cantidad = 1;
    monto = Number(data.monto);
  }
  if (row.estado !== 'pendiente_pago') {
    res.status(409).json({ error: `Estado inválido: ${row.estado}` });
    return;
  }

  // Credencial MP del local (misma que usa la tienda — cero setup extra).
  // NOTA: columna real es `activo` (no `activa`). Fix 26-jun.
  const { data: cred, error: errCred } = await supabase
    .from('mp_credenciales')
    .select('id, activo')
    .eq('local_id', row.local_id)
    .eq('activo', true)
    .limit(1)
    .single();
  if (errCred || !cred) {
    res.status(400).json({ error: 'Local sin credenciales MP activas' });
    return;
  }
  const getToken = createMpTokenGetter(supabase);
  const token = await getToken(cred.id);

  const origin = req.headers.origin || req.headers.host || 'https://pase-yndx.vercel.app';
  const baseOrigin = origin.startsWith('http') ? origin : 'https://' + origin;
  const baseBack = back_url_success || `${baseOrigin}/r/confirmacion/${tipo}/${id}`;
  const notificationUrl = `https://pase-yndx.vercel.app/api/tienda-mp?action=webhook`;

  const prefBody = {
    items: [{
      id: '0',
      title: String(titulo).slice(0, 250),
      quantity: 1,
      // El monto total ya incluye la cantidad de cupos — 1 ítem por el total
      // evita drift de redondeo entre qty×unit y el monto guardado.
      unit_price: monto,
      currency_id: 'ARS',
    }],
    external_reference: `${tipo}:${id}`,
    metadata: {
      mp_credencial_id: cred.id,
      tenant_id: row.tenant_id,
      local_id: row.local_id,
      mesa_tipo: tipo,
      mesa_cantidad: cantidad,
    },
    back_urls: { success: baseBack, pending: baseBack, failure: baseBack },
    auto_return: 'approved',
    notification_url: notificationUrl,
    payer: (row.telefono || row.comprador_telefono) ? {
      name: row.nombre || row.comprador_nombre || undefined,
      phone: { number: row.telefono || row.comprador_telefono },
    } : undefined,
    statement_descriptor: 'PASE Resto',
  };

  const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(prefBody),
  });
  if (!mpResp.ok) {
    const errText = await mpResp.text();
    console.error(`[tienda-mp ${tipo}-preference] MP error:`, mpResp.status, errText);
    res.status(502).json({ error: `MP rechazó la preference: ${mpResp.status}` });
    return;
  }
  const pref = await mpResp.json();

  // Guardar el preference id en la fila (trazabilidad + soporte).
  const tabla = tipo === 'evento' ? 'evento_inscripciones' : 'giftcard_compras';
  await supabase.from(tabla).update({ mp_preference_id: pref.id }).eq('id', id);

  res.status(200).json({
    preference_id: pref.id,
    init_point: pref.init_point,
    sandbox_init_point: pref.sandbox_init_point,
    monto,
  });
}

// MESA módulo #4: confirmación de pago de evento/giftcard desde el webhook.
// El payment YA fue validado contra la API de MP (handleWebhook). Acá se
// delega a las RPCs atómicas (GRANT solo service_role) que validan monto,
// son idempotentes por estado, incrementan cupos y generan el código.
async function confirmarPagoPublico(supabase, payment, paymentId, extRef, res) {
  if (payment.status !== 'approved') {
    res.status(200).json({ ok: true, status: payment.status });
    return;
  }
  const [tipo, idStr] = extRef.split(':');
  const rowId = Number(idStr);
  if (!rowId) {
    res.status(200).json({ ok: true, bad_ref: extRef });
    return;
  }
  const rpc = tipo === 'evento' ? 'fn_confirmar_pago_evento' : 'fn_confirmar_pago_giftcard';
  const args = tipo === 'evento'
    ? { p_inscripcion_id: rowId, p_payment_id: String(paymentId), p_monto: Number(payment.transaction_amount) }
    : { p_compra_id: rowId, p_payment_id: String(paymentId), p_monto: Number(payment.transaction_amount) };
  const { data, error } = await supabase.rpc(rpc, args);
  if (error) {
    console.error(`[tienda-mp webhook ${tipo}] error confirmando`, rowId, error.message);
    // 200 igual — si fue una notif duplicada/tardía no queremos retry-loops de MP.
    res.status(200).json({ ok: false, error: error.message });
    return;
  }
  res.status(200).json({ ok: true, tipo, id: rowId, result: data });
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  // MP envía notif con query ?type=payment&data.id=123 o en body. Soportamos ambos.
  const type = req.query.type || req.body?.type;
  const paymentId = req.query['data.id'] || req.body?.data?.id;

  // ── Validar firma x-signature (fix audit 26-jun CRIT-2) ───────────────
  // MP firma id+request-id+ts con HMAC SHA-256 del webhook secret. Buscamos
  // contra TODOS los webhook_secret disponibles: primero los de
  // mp_credenciales (per-tenant, escala a N clientes sin tocar Vercel),
  // después env vars MP_WEBHOOK_SECRET* (fallback legacy).
  // Si NINGUNA matchea, rechazamos 401. Sin firma válida no procesamos nada.
  if (paymentId) {
    const supabaseEarly = db();
    const verify = await findMatchingMpSecret(supabaseEarly, req.headers, paymentId);
    if (!verify.ok) {
      console.warn('[tienda-mp webhook] firma MP inválida (ninguna credencial activa matchea)');
      res.status(401).json({ error: 'INVALID_SIGNATURE', detail: verify.error });
      return;
    }
    // Si quisiéramos limitar el procesamiento a la credencial que firmó,
    // podríamos pasar verify.credId como hint hacia el resolver de payment.
    // Por ahora dejamos que el flow existente (con credIdHint del body /
    // metadata.mp_credencial_id) maneje eso.
  }

  if (type !== 'payment' || !paymentId) {
    // No es un payment notification — ack 200 igual para que MP no reintente
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const supabase = db();

  // AUDIT F5C#4: resolver credencial usando metadata.mp_credencial_id que
  // mandamos al crear la preference. Antes el webhook iteraba TODAS las
  // mp_credenciales activas del sistema para encontrar el match, lo que
  // generaba leak cross-tenant + posibles throttlings a tenants ajenos.
  // Si el payment no tiene metadata (legacy), fallback al método anterior.
  const getToken = createMpTokenGetter(supabase);
  let payment = null;
  let credIdHint = null;

  // Intento 1: traer payment desde QUALQUIER credencial activa SOLO para
  // leer metadata.mp_credencial_id. Esto se simplifica a 1 sola call cuando
  // el primer cred matchea (lo más común porque el payment es válido en
  // toda credencial del MISMO tenant — MP lo deja consultar).
  // OPCIÓN: si el body trae mp_credencial_id como hint, usarlo directo.
  if (req.body?.metadata?.mp_credencial_id || req.query?.cred_id) {
    credIdHint = Number(req.body?.metadata?.mp_credencial_id || req.query?.cred_id);
  }

  if (credIdHint) {
    try {
      const token = await getToken(credIdHint);
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (r.ok) payment = await r.json();
    } catch (e) {
      console.warn(`[tienda-mp webhook] cred hint ${credIdHint} no funcionó`, e.message);
    }
  }

  // Si no hubo hint o el hint falló, fallback al método legacy (itera).
  // Pero ahora MP devuelve metadata en el payment → podemos cortar al primer
  // hit para no consumir N calls por webhook.
  if (!payment) {
    const { data: creds } = await supabase.from('mp_credenciales').select('id').eq('activo', true);
    if (!creds || creds.length === 0) {
      res.status(200).json({ ok: true, no_creds: true });
      return;
    }
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
  }

  // Después de tener payment, si trae metadata.mp_credencial_id confirma que
  // estamos hablando del tenant correcto (defense-in-depth).
  if (payment?.metadata?.mp_credencial_id && credIdHint &&
      Number(payment.metadata.mp_credencial_id) !== Number(credIdHint)) {
    console.warn(`[tienda-mp webhook] credIdHint=${credIdHint} pero payment.metadata.mp_credencial_id=${payment.metadata.mp_credencial_id}`);
  }

  if (!payment) {
    res.status(404).json({ error: 'Payment no encontrado en ninguna credencial' });
    return;
  }

  // MESA módulo #4: prefijos de external_reference para eventos/giftcards.
  // (numérico pelado = venta de tienda, flujo original intacto.)
  const extRef = String(payment.external_reference || '');
  if (extRef.startsWith('evento:') || extRef.startsWith('gift:')) {
    return await confirmarPagoPublico(supabase, payment, paymentId, extRef, res);
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

  // Anti-fraud: validar que MP cobró exactamente lo que decía la venta. Si
  // un cliente manipuló items[] en el body de preference y MP terminó cobrando
  // de menos, NO cobramos la venta en COMANDA — queda pendiente para revisar.
  // Tolerancia $0.50 por redondeos float.
  const { data: ventaDb } = await supabase
    .from('ventas_pos')
    .select('total')
    .eq('id', ventaId)
    .single();
  if (!ventaDb) {
    res.status(404).json({ error: 'Venta no encontrada para validar monto' });
    return;
  }
  const montoCobrado = Number(payment.transaction_amount);
  const montoEsperado = Number(ventaDb.total);
  if (Math.abs(montoCobrado - montoEsperado) > 0.5) {
    console.error(`[tienda-mp webhook] MISMATCH monto venta=${ventaId} esperado=${montoEsperado} cobrado=${montoCobrado}`);
    // Log para auditoría — quedará pendiente de revisión manual del dueño
    await supabase.from('pedidos_externos_log').insert({
      provider: 'mercadopago-fraud-check',
      external_id: paymentId,
      payload: { venta_id: ventaId, esperado: montoEsperado, cobrado: montoCobrado, payment },
      headers: { tipo: 'monto_mismatch' },
    }).catch(() => {});
    res.status(200).json({ ok: false, error: 'monto_mismatch', esperado: montoEsperado, cobrado: montoCobrado });
    return;
  }

  // Cobrar la venta via RPC (idempotente). Usamos el monto DE LA DB,
  // no el del payment de MP (defense-in-depth — aunque ya validamos arriba).
  const { error: errCobro } = await supabase.rpc('fn_cobrar_venta_comanda', {
    p_venta_id: ventaId,
    p_pagos: [{
      metodo: 'mercadopago',
      monto: montoEsperado,
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

  // ── AFIP CAE post-cobro (best-effort) ────────────────────────────────────
  // Si el tenant tiene AFIP activa, emitimos factura electrónica automática.
  // Default: Consumidor Final (doc_tipo=99). Si falla AFIP NO bloqueamos la
  // respuesta al webhook MP, pero marcamos `ventas_pos.afip_pendiente=true`
  // para que el POS muestre la venta como "necesita reintento" (fix audit
  // 26-jun CRIT-4: antes el rechazo quedaba enterrado en logs sin alertar).
  let afip_factura = null;
  let afip_error = null;
  try {
    afip_factura = await emitirFacturaPostCobroOnline(supabase, ventaId, paymentId);
    if (afip_factura && afip_factura.ok === false && !afip_factura.skipped) {
      afip_error = afip_factura.error || 'afip_failed';
    }
  } catch (e) {
    console.error('[tienda-mp webhook] emitir AFIP falló (no bloquea cobro)', ventaId, e?.message);
    afip_error = e?.message || String(e);
  }

  // Si AFIP falló (no skipped por afip_no_configurada), marcar venta como
  // pendiente para que el operador la reintente desde el POS.
  if (afip_error) {
    let marcaPendienteOk = false;
    let marcaError = null;
    try {
      // eslint-disable-next-line pase-local/no-direct-financiera-write -- afip_pendiente/afip_ultimo_error son flags fiscales no-monetarios.
      const { error: errUpdate } = await supabase.from('ventas_pos')
        .update({
          afip_pendiente: true,
          afip_ultimo_intento_at: new Date().toISOString(),
          afip_ultimo_error: afip_error,
        })
        .eq('id', ventaId);
      if (errUpdate) {
        marcaError = errUpdate.message;
      } else {
        marcaPendienteOk = true;
      }
    } catch (e) {
      marcaError = e?.message || String(e);
    }
    // Fix code-review 27-jun: si NO se pudo marcar el flag, dejar una alerta
    // visible en pedidos_externos_log porque sino la venta queda cobrada,
    // sin factura, sin pendiente — peor caso silencioso. El operador puede
    // ver estas alertas en logs.
    if (!marcaPendienteOk) {
      console.error('[tienda-mp webhook] CRÍTICO: no se pudo marcar afip_pendiente', ventaId, marcaError);
      try {
        await supabase.from('pedidos_externos_log').insert({
          provider: 'afip-flag-write-failed',
          external_id: String(paymentId),
          payload: {
            venta_id: ventaId,
            afip_error,
            marca_pendiente_error: marcaError,
            severity: 'critical',
            instruccion: 'Venta cobrada, AFIP rechazó, flag afip_pendiente NO se pudo setear. Revisar venta a mano y reintentar AFIP desde COMANDA o /api/afip-cae.',
          },
          headers: { tipo: 'afip_flag_write_failed' },
        });
      } catch { /* peor caso: ni siquiera el log funciona */ }
    }
  } else if (afip_factura && (afip_factura.cae || afip_factura.cached)) {
    // Éxito (nuevo CAE o ya estaba emitido): asegurar que el flag esté en false.
    try {
      await supabase.from('ventas_pos')
        .update({ afip_pendiente: false, afip_ultimo_error: null })
        .eq('id', ventaId)
        .eq('afip_pendiente', true);
    } catch { /* no crítico */ }
  }

  res.status(200).json({ ok: true, venta_id: ventaId, status, afip: afip_factura });
}

// ─── AFIP CAE para cobros online de tienda ─────────────────────────────────
// Server-to-server: no usa JWT (el cliente final del marketplace no tiene
// sesión). El tenant_id sale de la venta_pos. tipo_comprobante se elige
// según afip_credenciales.tipo_contribuyente. Si AFIP no está activa para
// el tenant, sale sin hacer nada (no es error — los locales que aún no se
// dieron de alta en AFIP siguen pudiendo vender online sin factura).
async function emitirFacturaPostCobroOnline(supabase, ventaId, paymentId) {
  // 1. Levantar venta + tenant_id
  const { data: venta } = await supabase
    .from('ventas_pos')
    .select('id, tenant_id, total, subtotal, cliente_nombre, cliente_email')
    .eq('id', ventaId)
    .single();
  if (!venta) return { ok: false, error: 'venta_no_encontrada' };

  // 2. Credenciales AFIP del tenant
  const { data: cred } = await supabase
    .from('afip_credenciales')
    .select('cuit, ambiente, cert_pem, key_pem, punto_venta, activa, tipo_contribuyente')
    .eq('tenant_id', venta.tenant_id)
    .maybeSingle();
  if (!cred || !cred.activa || !cred.cert_pem || !cred.key_pem) {
    return { ok: false, skipped: 'afip_no_configurada' };
  }

  // 3. Idempotency por venta+payment (anti doble-emisión si MP reenvía webhook).
  // Fix code-review 27-jun: persistir el uuid en ventas_pos para que el
  // reintento manual desde COMANDA → AFIP pendientes reuse el mismo y AFIP
  // devuelva el CAE cacheado en lugar de emitir un nuevo número.
  const requestUuid = `mp-${paymentId}-venta-${ventaId}`;
  try {
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- afip_request_uuid es metadata de idempotency fiscal no-monetaria.
    await supabase.from('ventas_pos')
      .update({ afip_request_uuid: requestUuid })
      .eq('id', ventaId)
      .is('afip_request_uuid', null); // solo setear si está vacío (no pisar)
  } catch (e) {
    console.warn('[tienda-mp afip] no se pudo persistir afip_request_uuid', e?.message);
  }
  const { data: prev } = await supabase
    .from('afip_facturas')
    .select('id, cae, numero, qr_fiscal_url, estado')
    .eq('request_uuid', requestUuid)
    .eq('tenant_id', venta.tenant_id)
    .maybeSingle();
  if (prev?.cae) {
    return { ok: true, cached: true, factura_id: prev.id, cae: prev.cae, numero: prev.numero };
  }

  // 4. tipo_comprobante + cálculo neto/iva según tipo_contribuyente
  //    monotributo  → Factura C (11), IVA 0
  //    exento       → Factura C (11), IVA 0
  //    resp_inscr.  → Factura B (6), IVA 21% (consumidor final default)
  let cbteTipo, importeNeto, importeIva, importeTotal;
  importeTotal = Number(venta.total);
  if (cred.tipo_contribuyente === 'responsable_inscripto') {
    cbteTipo = 6;
    importeNeto = +(importeTotal / 1.21).toFixed(2);
    importeIva = +(importeTotal - importeNeto).toFixed(2);
  } else {
    cbteTipo = 11;
    importeNeto = importeTotal;
    importeIva = 0;
  }

  // 5. SDK AFIP
  let afipSdk;
  try {
    afipSdk = new Afip({
      CUIT: cred.cuit, cert: cred.cert_pem, key: cred.key_pem,
      production: cred.ambiente === 'produccion',
    });
  } catch (e) {
    return { ok: false, error: 'afip_sdk_init_failed: ' + e.message };
  }

  const ptoVta = cred.punto_venta;
  let numero;
  try {
    const ultimo = await afipSdk.ElectronicBilling.getLastVoucher(ptoVta, cbteTipo);
    numero = (ultimo || 0) + 1;
  } catch (e) {
    return { ok: false, error: 'afip_get_last_voucher_failed: ' + e.message };
  }

  const today = new Date();
  const yyyymmdd = parseInt(today.toISOString().slice(0, 10).replaceAll('-', ''));

  let caeResult;
  try {
    caeResult = await afipSdk.ElectronicBilling.createVoucher({
      CantReg: 1, PtoVta: ptoVta, CbteTipo: cbteTipo, Concepto: 1,
      DocTipo: 99, DocNro: 0,
      CbteDesde: numero, CbteHasta: numero, CbteFch: yyyymmdd,
      ImpTotal: importeTotal, ImpTotConc: 0,
      ImpNeto: importeNeto, ImpOpEx: 0, ImpIVA: importeIva, ImpTrib: 0,
      MonId: 'PES', MonCotiz: 1,
      ...(importeIva > 0 ? { Iva: [{ Id: 5, BaseImp: importeNeto, Importe: importeIva }] } : {}),
    });
  } catch (e) {
    // Registrar rechazo para auditoría y reintento manual desde POS
    await supabase.from('afip_facturas').insert({
      tenant_id: venta.tenant_id, venta_pos_id: ventaId,
      tipo_comprobante: cbteTipo, punto_venta: ptoVta, numero,
      importe_neto: importeNeto, importe_iva: importeIva, importe_total: importeTotal,
      concepto: 1, doc_tipo: 99, doc_nro: null,
      cliente_razon_social: venta.cliente_nombre || null,
      estado: 'rechazada', rechazo_motivo: e.message,
      request_uuid: requestUuid, emitida_por: null,
    });
    return { ok: false, error: 'afip_rejected: ' + e.message };
  }

  // QR fiscal AR (Res. Gral. 4892/2020)
  const qrPayload = Buffer.from(JSON.stringify({
    ver: 1, fecha: today.toISOString().slice(0, 10),
    cuit: parseInt(cred.cuit), ptoVta, tipoCmp: cbteTipo, nroCmp: numero,
    importe: importeTotal, moneda: 'PES', ctz: 1,
    tipoDocRec: 99, nroDocRec: 0, tipoCodAut: 'E', codAut: parseInt(caeResult.CAE),
  })).toString('base64');
  const qrFiscalUrl = `https://www.afip.gob.ar/fe/qr/?p=${qrPayload}`;

  const { data: factura } = await supabase
    .from('afip_facturas')
    .insert({
      tenant_id: venta.tenant_id, venta_pos_id: ventaId,
      tipo_comprobante: cbteTipo, punto_venta: ptoVta, numero,
      importe_neto: importeNeto, importe_iva: importeIva, importe_total: importeTotal,
      concepto: 1, doc_tipo: 99, doc_nro: null,
      cliente_razon_social: venta.cliente_nombre || null,
      cae: caeResult.CAE, cae_vence_at: caeResult.CAEFchVto, qr_fiscal_url: qrFiscalUrl,
      estado: 'aprobada', request_uuid: requestUuid,
      emitida_at: new Date().toISOString(), emitida_por: null,
    })
    .select('id, cae, numero, qr_fiscal_url')
    .single();

  return { ok: true, factura_id: factura?.id, cae: caeResult.CAE, numero, qr_fiscal_url: qrFiscalUrl };
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

  // AUDIT F5C#1: wire HMAC validation. Antes los helpers verify*Signature
  // existían pero terminaban con `void verifyRappiWebhookSignature;` al
  // final del archivo — los webhooks aceptaban cualquier POST. Ahora se
  // valida la firma del partner contra el secret en mapeos_locales_externos
  // (o env var como fallback) antes de procesar el payload.
  const externalLocalId = String(
    payload.store_id ?? payload.local_id ?? payload.restaurant_id ?? payload.location_id ?? ''
  ) || null;

  let localId = null;
  let mapeo = null;
  if (externalLocalId) {
    const { data } = await supabase.from('mapeos_locales_externos')
      .select('local_id, webhook_secret')
      .eq('provider', provider)
      .eq('external_local_id', externalLocalId)
      .eq('activo', true)
      .maybeSingle();
    if (data) { localId = data.local_id; mapeo = data; }
  }
  if (!localId) {
    res.status(404).json({
      error: `Sin mapeo de local para ${provider}.${externalLocalId ?? '(no se detectó external_local_id en payload)'}`,
      hint: 'Configurá el mapeo en /integraciones/' + (provider === 'pedidos-ya' ? 'pedidosya' : provider),
    });
    return;
  }

  // AUDIT F5C#1: validar firma HMAC del partner. El secret se busca en
  // el mapeo (preferido) o en env var como fallback temporal.
  // Si el partner no manda firma o no hay secret configurado, registramos
  // warning y continuamos (modo soft-fail durante la migración). Cuando
  // todos los mapeos tengan secret, hacer hard-fail (`return 401`).
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const sigHeader = req.headers['x-signature'] || req.headers['x-rappi-signature'] || req.headers['x-peya-signature'] || null;
  const secret = mapeo?.webhook_secret || process.env[`${provider.toUpperCase().replace(/-/g, '_')}_WEBHOOK_SECRET`] || null;
  if (secret && sigHeader) {
    let valid = false;
    try {
      if (provider === 'rappi') {
        valid = verifyRappiWebhookSignature(rawBody, sigHeader, secret);
      } else if (provider === 'pedidos-ya') {
        valid = verifyPedidosYaWebhookSignature(rawBody, sigHeader, secret);
      } else {
        valid = true; // deliverect / otros — sin verificador implementado todavía
      }
    } catch (e) {
      console.warn(`[${provider}] HMAC verify threw:`, e?.message);
    }
    if (!valid) {
      res.status(401).json({ error: 'INVALID_SIGNATURE' });
      return;
    }
  } else if (!secret) {
    console.warn(`[${provider}] webhook sin secret configurado — soft-fail (configurar mapeos_locales_externos.webhook_secret)`);
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

  // AUDIT F5C#3: idempotency check antes de INSERT.
  // Existe UNIQUE INDEX uniq_ventas_external_order (provider, external_order_id)
  // pero el handler hacía INSERT sin chequear → si Rappi reenvía el mismo
  // webhook (reintentos por timeout, retries de Meta), generaba 500
  // unique_violation → Rappi sigue reintentando indefinidamente.
  // Ahora chequeamos primero y respondemos 200 idempotent_replay.
  if (externalOrderId) {
    const { data: existing } = await supabase.from('ventas_pos')
      .select('id, estado')
      .eq('external_provider', provider)
      .eq('external_order_id', externalOrderId)
      .maybeSingle();
    if (existing) {
      res.status(200).json({
        ok: true,
        venta_id: existing.id,
        estado: existing.estado,
        idempotent_replay: true,
      });
      return;
    }
  }

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
    .select('id, local_id, numero_local, total, tipo_entrega, cliente_nombre, cliente_email, notif_email_recibido_at, programada_para')
    .eq('id', venta_id)
    .single();
  if (verr || !venta) { res.status(404).json({ error: 'Venta no encontrada' }); return; }

  // Fix auditoría 2026-05-21 ALTO-3: validar que email_destinatario sea el
  // del cliente de la venta. Antes el endpoint era anónimo + sin validación
  // → spam dirigido con dominio del local víctima.
  // - Si venta tiene cliente_email guardado: debe matchear.
  // - Si no lo tiene: lo guardamos ahora (1er envío, legítimo del cliente).
  if (venta.cliente_email) {
    if (venta.cliente_email.toLowerCase().trim() !== email_destinatario.toLowerCase().trim()) {
      res.status(403).json({ error: 'EMAIL_MISMATCH' });
      return;
    }
  } else {
    // Persistir el email para validación de notif siguientes.
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- campo no-financiero
    await supabase.from('ventas_pos').update({ cliente_email: email_destinatario }).eq('id', venta_id);
  }

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

  // URL pública de seguimiento — apunta al deploy independiente de COMANDA.
  const seguimientoUrl = `${COMANDA_PUBLIC_URL}/tienda/${cls?.slug ?? ''}/confirmacion/${venta_id}`;

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

  // ── WhatsApp paralelo (best-effort): si el tenant tiene WA Business API
  // configurada y la venta tiene cliente_telefono, mandar confirmación
  // también por WA. Es lo que los clientes argentinos esperan.
  let waResult = null;
  try {
    const { data: ventaTel } = await supabase
      .from('ventas_pos')
      .select('cliente_telefono, tenant_id')
      .eq('id', venta_id)
      .single();
    if (ventaTel?.cliente_telefono && ventaTel.tenant_id) {
      const { getCredencial, sendWhatsApp } = await import('./_integraciones.js');
      const wa = await getCredencial(supabase, ventaTel.tenant_id, 'whatsapp_api');
      if (wa) {
        const tel = ventaTel.cliente_telefono.replace(/\D/g, '');
        const texto = `Hola ${venta.cliente_nombre ?? ''}! ✅\nRecibimos tu pedido #${venta.numero_local ?? venta.id} en ${local.nombre}.\nTotal: $${venta.total}\n${tiempo ? `Tiempo estimado: ${tiempo} min\n` : ''}Seguilo acá: ${seguimientoUrl}`;
        waResult = await sendWhatsApp({ wa, to: tel, texto });
      }
    }
  } catch (e) {
    console.warn('[notify-pedido] WA paralelo falló:', e?.message);
  }

  // Marcar como enviado (también si skipped, así no reintenta cada navegación).
  // eslint-disable-next-line pase-local/no-direct-financiera-write -- campo no-financiero (timestamp notif), endpoint server-side con service_role
  await supabase
    .from('ventas_pos')
    .update({ notif_email_recibido_at: new Date().toISOString() })
    .eq('id', venta_id);

  res.status(200).json({ ok: true, sent: !sent.skipped, email_id: sent.id, wa: waResult });
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

  // Fix auditoría 2026-05-21 ALTO-3: si el body trae email_destinatario,
  // debe matchear con venta.cliente_email (evitar spam con dominio víctima).
  // Si solo está en DB, usarlo. Si ninguno, skip silencioso.
  if (email_destinatario && venta.cliente_email
      && email_destinatario.toLowerCase().trim() !== venta.cliente_email.toLowerCase().trim()) {
    res.status(403).json({ error: 'EMAIL_MISMATCH' });
    return;
  }
  const emailFinal = venta.cliente_email || email_destinatario;
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

  // ── WhatsApp paralelo (best-effort) — mismo patrón que notify-pedido
  let waResult = null;
  try {
    const { data: ventaTel } = await supabase
      .from('ventas_pos')
      .select('cliente_telefono, tenant_id')
      .eq('id', venta_id)
      .single();
    if (ventaTel?.cliente_telefono && ventaTel.tenant_id) {
      const { getCredencial, sendWhatsApp } = await import('./_integraciones.js');
      const wa = await getCredencial(supabase, ventaTel.tenant_id, 'whatsapp_api');
      if (wa) {
        const tel = ventaTel.cliente_telefono.replace(/\D/g, '');
        const accion = venta.tipo_entrega === 'delivery' ? 'sale en camino' : 'está listo para retirar';
        const texto = `${venta.cliente_nombre ?? ''}! 🎉\nTu pedido #${venta.numero_local ?? venta.id} en ${local?.nombre ?? ''} ${accion}.${cls?.direccion ? `\n📍 ${cls.direccion}` : ''}${cls?.telefono ? `\n📞 ${cls.telefono}` : ''}`;
        waResult = await sendWhatsApp({ wa, to: tel, texto });
      }
    }
  } catch (e) {
    console.warn('[notify-listo] WA paralelo falló:', e?.message);
  }

  // eslint-disable-next-line pase-local/no-direct-financiera-write -- campo no-financiero
  await supabase
    .from('ventas_pos')
    .update({ notif_email_listo_at: new Date().toISOString() })
    .eq('id', venta_id);

  res.status(200).json({ ok: true, sent: !sent.skipped, wa: waResult });
}

// ─── NOTIFY: Pedido rechazado / cancelado ───────────────────────────────────
// Llamado por el POS cuando alguien rechaza un pedido pending (estado=
// 'necesita_aprobacion' → 'anulada') o cancela uno ya activo. Le avisamos
// al cliente con el motivo para que no quede esperando.
async function handleNotifyRechazado(req, res) {
  const { venta_id, motivo, email_destinatario } = req.body || {};
  if (!venta_id) {
    res.status(400).json({ error: 'venta_id requerido' });
    return;
  }

  const supabase = db();
  const { data: venta, error: verr } = await supabase
    .from('ventas_pos')
    .select('id, local_id, numero_local, cliente_nombre, cliente_email, notif_email_rechazado_at')
    .eq('id', venta_id)
    .single();
  if (verr || !venta) { res.status(404).json({ error: 'Venta no encontrada' }); return; }

  if (venta.notif_email_rechazado_at) {
    res.status(200).json({ ok: true, skipped: 'YA_ENVIADO' });
    return;
  }

  const emailFinal = email_destinatario || venta.cliente_email;
  if (!emailFinal) {
    res.status(200).json({ ok: true, skipped: 'NO_EMAIL' });
    return;
  }

  const { data: local } = await supabase
    .from('locales').select('nombre').eq('id', venta.local_id).single();
  const { data: cls } = await supabase
    .from('comanda_local_settings')
    .select('telefono')
    .eq('local_id', venta.local_id).single();

  const html = htmlPedidoRechazado({
    localNombre: local?.nombre ?? '',
    clienteNombre: venta.cliente_nombre ?? '',
    ventaNumero: venta.numero_local ?? venta.id,
    motivo: motivo || null,
    telefono: cls?.telefono ?? null,
  });

  const sent = await sendEmail({
    to: emailFinal,
    subject: `Pedido cancelado — ${local?.nombre ?? ''}`,
    html,
  });
  if (!sent.ok && !sent.skipped) {
    res.status(502).json({ error: sent.error, detail: sent.detail });
    return;
  }

  // eslint-disable-next-line pase-local/no-direct-financiera-write -- campo no-financiero
  await supabase
    .from('ventas_pos')
    .update({ notif_email_rechazado_at: new Date().toISOString() })
    .eq('id', venta_id);
  res.status(200).json({ ok: true, sent: !sent.skipped });
}

// ─── NOTIFY: Pedido entregado / invitación a calificar ─────────────────────
// Llamado por el POS cuando una venta pasa a 'entregada' o 'cobrada'.
// Le mandamos invitación a dejar review.
async function handleNotifyEntregado(req, res) {
  const { venta_id, email_destinatario } = req.body || {};
  if (!venta_id) {
    res.status(400).json({ error: 'venta_id requerido' });
    return;
  }

  const supabase = db();
  const { data: venta, error: verr } = await supabase
    .from('ventas_pos')
    .select('id, local_id, numero_local, cliente_nombre, cliente_email, notif_email_entregado_at')
    .eq('id', venta_id)
    .single();
  if (verr || !venta) { res.status(404).json({ error: 'Venta no encontrada' }); return; }

  if (venta.notif_email_entregado_at) {
    res.status(200).json({ ok: true, skipped: 'YA_ENVIADO' });
    return;
  }

  const emailFinal = email_destinatario || venta.cliente_email;
  if (!emailFinal) {
    res.status(200).json({ ok: true, skipped: 'NO_EMAIL' });
    return;
  }

  const { data: local } = await supabase
    .from('locales').select('nombre').eq('id', venta.local_id).single();
  const { data: cls } = await supabase
    .from('comanda_local_settings')
    .select('slug')
    .eq('local_id', venta.local_id).single();

  // URL pública con el form de review (la confirmación detecta entregada
  // y muestra el ReviewForm).
  const calificarUrl = `${COMANDA_PUBLIC_URL}/tienda/${cls?.slug ?? ''}/confirmacion/${venta_id}`;

  const html = htmlPedidoEntregado({
    localNombre: local?.nombre ?? '',
    clienteNombre: venta.cliente_nombre ?? '',
    ventaNumero: venta.numero_local ?? venta.id,
    calificarUrl,
  });

  const sent = await sendEmail({
    to: emailFinal,
    subject: `¿Cómo estuvo tu pedido? — ${local?.nombre ?? ''}`,
    html,
  });
  if (!sent.ok && !sent.skipped) {
    res.status(502).json({ error: sent.error, detail: sent.detail });
    return;
  }

  // eslint-disable-next-line pase-local/no-direct-financiera-write -- campo no-financiero
  await supabase
    .from('ventas_pos')
    .update({ notif_email_entregado_at: new Date().toISOString() })
    .eq('id', venta_id);
  res.status(200).json({ ok: true, sent: !sent.skipped });
}

// ─── PRINT AGENT HEARTBEAT (Sprint 2 impresoras) ──────────────────────────
//
// Recibe heartbeat de cada Print Agent corriendo en una PC del comerciante.
// Auth: token único pre-vinculado (no JWT — el agent no tiene usuario).
// Cada 60s el agent hace POST con stats. Si el token no existe / fue
// revocado, devolvemos 401 — el agent dejará de mandar.
//
// Body:
//   {
//     agent_token: "abc123...",
//     agent_version: "1.1.0",
//     hostname: "PC-Cocina",
//     os_platform: "win32" | "darwin" | "linux",
//     printers: [{ id, nombre, estacion, online: bool }],
//     queue: { queued, printing, done, failed, dead_letter }
//   }
async function handleAgentHeartbeat(req, res) {
  const { agent_token, agent_version, hostname, os_platform, printers, queue } = req.body || {};
  if (!agent_token || typeof agent_token !== 'string') {
    return res.status(400).json({ error: 'agent_token requerido' });
  }

  const supabase = db();
  const { data: agent, error } = await supabase
    .from('comanda_print_agents')
    .select('id, local_id, tenant_id, deleted_at')
    .eq('agent_token', agent_token)
    .maybeSingle();
  if (error) {
    console.error('[heartbeat] DB error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }
  if (!agent || agent.deleted_at) {
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }

  const printersArr = Array.isArray(printers) ? printers : [];
  const onlineCount = printersArr.filter((p) => p && p.online).length;
  const q = queue || {};

  const { error: upErr } = await supabase
    .from('comanda_print_agents')
    .update({
      last_seen_at: new Date().toISOString(),
      agent_version: agent_version ?? null,
      hostname: hostname ?? null,
      os_platform: os_platform ?? null,
      printers_total: printersArr.length,
      printers_online: onlineCount,
      queue_queued: Number(q.queued ?? 0),
      queue_printing: Number(q.printing ?? 0),
      queue_failed: Number(q.failed ?? 0),
      queue_dead_letter: Number(q.dead_letter ?? 0),
      metadata: { printers: printersArr.slice(0, 20) }, // cap para no inflar la row
    })
    .eq('id', agent.id);
  if (upErr) {
    console.error('[heartbeat] update error:', upErr.message);
    return res.status(500).json({ error: 'UPDATE_FAILED' });
  }

  return res.status(200).json({
    ok: true,
    local_id: agent.local_id,
    server_time: new Date().toISOString(),
  });
}

// ─── CRON: emails post auto-entrega ─────────────────────────────────────
//
// Busca ventas que pasaron a 'entregada' (por geofencing trigger PG o por
// el comerciante) y todavía no tienen notif_email_entregado_at marcado.
// Dispara el email "calificá tu pedido" para cada una.
//
// Diseñado para ser llamado cada 1-2min. Idempotente — el flag
// notif_email_entregado_at evita doble envío.
//
// Auth: header X-Cron-Token. Si no matchea CRON_TOKEN env var, 401.
async function handleCronProcessDelivered(req, res) {
  const tokenHeader = req.headers['x-cron-token'];
  const expected = process.env.CRON_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'CRON_TOKEN no configurado en env' });
  }
  if (tokenHeader !== expected) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const supabase = db();
  // Trae hasta 50 candidatos por tick — más que suficiente para 1-2min.
  const { data: candidatos, error } = await supabase
    .from('ventas_pos')
    .select('id, local_id, numero_local, cliente_nombre, cliente_email, tipo_entrega')
    .eq('estado', 'entregada')
    .eq('tipo_entrega', 'delivery')
    .eq('origen', 'tienda_online')
    .is('deleted_at', null)
    .is('notif_email_entregado_at', null)
    .not('cliente_email', 'is', null)
    .limit(50);

  if (error) {
    console.error('[cron-deliver]', error);
    return res.status(500).json({ error: error.message });
  }

  if (!candidatos || candidatos.length === 0) {
    return res.status(200).json({ ok: true, processed: 0, msg: 'sin pendientes' });
  }

  let sent = 0;
  let failed = 0;
  for (const v of candidatos) {
    try {
      // Reutilizamos exactamente el mismo handler que ya existe.
      // Llamada interna fake: armamos req/res mocks.
      const fakeReq = {
        body: { venta_id: v.id },
        headers: req.headers,
      };
      const fakeRes = {
        status() { return this; },
        json() { return this; },
      };
      // Pero más limpio: refactorizamos el body de handleNotifyEntregado
      // a una función reutilizable. Por ahora hacemos call inline.
      const r = await sendNotifyEntregadoInline(supabase, v.id, req);
      if (r.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
      console.error('[cron-deliver] venta', v.id, e.message);
    }
  }

  res.status(200).json({ ok: true, candidatos: candidatos.length, sent, failed });
}

// Helper inline para reutilizar la lógica de handleNotifyEntregado.
// (Refactor mínimo — no rompemos el handler original.)
async function sendNotifyEntregadoInline(supabase, ventaId, req) {
  const { data: venta } = await supabase
    .from('ventas_pos')
    .select('id, local_id, numero_local, cliente_nombre, cliente_email, notif_email_entregado_at')
    .eq('id', ventaId)
    .single();
  if (!venta) return { ok: false, error: 'NOT_FOUND' };
  if (venta.notif_email_entregado_at) return { ok: true, skipped: 'YA_ENVIADO' };
  if (!venta.cliente_email) return { ok: false, error: 'NO_EMAIL' };

  const { data: local } = await supabase.from('locales').select('nombre').eq('id', venta.local_id).single();
  const { data: cls } = await supabase
    .from('comanda_local_settings')
    .select('slug')
    .eq('local_id', venta.local_id).single();

  const calificarUrl = `${COMANDA_PUBLIC_URL}/tienda/${cls?.slug ?? ''}/confirmacion/${ventaId}`;

  const html = htmlPedidoEntregado({
    localNombre: local?.nombre ?? '',
    clienteNombre: venta.cliente_nombre ?? '',
    ventaNumero: venta.numero_local ?? venta.id,
    calificarUrl,
  });
  const sent = await sendEmail({
    to: venta.cliente_email,
    subject: `¿Cómo estuvo tu pedido? — ${local?.nombre ?? ''}`,
    html,
  });
  if (!sent.ok && !sent.skipped) return { ok: false, error: sent.error };

  // eslint-disable-next-line pase-local/no-direct-financiera-write -- campo no-financiero
  await supabase
    .from('ventas_pos')
    .update({ notif_email_entregado_at: new Date().toISOString() })
    .eq('id', ventaId);

  return { ok: true };
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

// ═══════════════════════════════════════════════════════════════════════════
// PEDIDOSYA — operaciones contra PeYa POS Integration API
// Espejo de los handlers de Rappi adaptados al schema PeYa.
// ═══════════════════════════════════════════════════════════════════════════

async function handlePedidosyaTest(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;
  if (!['dueno', 'admin', 'superadmin'].includes(auth.row.rol)) {
    return res.status(403).json({ error: 'PERMISO_DENEGADO' });
  }

  const supabase = db();
  const creds = await getPedidosYaCredentials(supabase, auth.row.tenant_id);
  if (!creds) return res.status(400).json({ error: 'PEYA_NO_CONFIGURADA' });

  const useProduction = req.body?.production === true;
  try {
    const client = createPedidosYaClient(creds, { production: useProduction });
    await client.testConnection();
    await supabase.from('integraciones_externas_credenciales')
      .update({ estado: 'active', last_test_at: new Date().toISOString(), last_error: null })
      .eq('tenant_id', auth.row.tenant_id).eq('provider', 'pedidos-ya');
    res.status(200).json({ ok: true, message: 'Conexión exitosa con PedidosYa' });
  } catch (err) {
    const msg = err.message || String(err);
    await supabase.from('integraciones_externas_credenciales')
      .update({ estado: 'error', last_test_at: new Date().toISOString(), last_error: msg })
      .eq('tenant_id', auth.row.tenant_id).eq('provider', 'pedidos-ya');
    res.status(502).json({ error: 'PEYA_TEST_FAILED', detail: msg });
  }
}

async function handlePedidosyaSyncMenu(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;
  if (!['dueno', 'admin', 'superadmin'].includes(auth.row.rol)) {
    return res.status(403).json({ error: 'PERMISO_DENEGADO' });
  }

  const { restaurant_id, local_id, production } = req.body || {};
  if (!restaurant_id) return res.status(400).json({ error: 'RESTAURANT_ID_REQUERIDO' });

  const supabase = db();
  const creds = await getPedidosYaCredentials(supabase, auth.row.tenant_id);
  if (!creds) return res.status(400).json({ error: 'PEYA_NO_CONFIGURADA' });

  // Pull catálogo COMANDA (mismo flow que Rappi)
  let itemsQ = supabase.from('items')
    .select('id, sku_pedidosya, nombre, descripcion, emoji, foto_url, precio_madre, grupo_id, visible_tienda, estado, agotado_at, agotado_hasta')
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

  // Schema PedidosYa v3 (Partner Integration). Similar a Rappi pero con
  // nombres distintos: sections en vez de categories, products igual.
  const menuPayload = {
    sections: (grupos || []).map((g) => ({
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
        external_id: it.sku_pedidosya || `item_${it.id}`,
        section_external_id: it.grupo_id ? `cat_${it.grupo_id}` : null,
        name: it.nombre,
        description: it.descripcion || '',
        price: Number(it.precio_madre),
        image_url: it.foto_url || null,
        enabled: !agotado,
      };
    }),
  };

  let result;
  try {
    const peya = createPedidosYaClient(creds, { production: !!production });
    result = await peya.syncMenu(restaurant_id, menuPayload);
  } catch (err) {
    const detail = err.message || String(err);
    await supabase.from('integraciones_externas_credenciales')
      .update({ estado: 'error', last_test_at: new Date().toISOString(), last_error: detail })
      .eq('tenant_id', auth.row.tenant_id).eq('provider', 'pedidos-ya');
    return res.status(502).json({ error: 'PEYA_SYNC_FAILED', detail });
  }

  // Backfill items.sku_pedidosya si PeYa devolvió IDs nuevos
  if (result?.products && Array.isArray(result.products)) {
    for (const p of result.products) {
      if (p.external_id?.startsWith('item_') && p.peya_id) {
        const internalId = parseInt(p.external_id.replace('item_', ''));
        if (Number.isFinite(internalId)) {
          await supabase.from('items').update({ sku_pedidosya: p.peya_id }).eq('id', internalId);
        }
      }
    }
  }

  await supabase.from('integraciones_externas_credenciales')
    .update({ estado: 'active', last_test_at: new Date().toISOString(), last_error: null })
    .eq('tenant_id', auth.row.tenant_id).eq('provider', 'pedidos-ya');

  res.status(200).json({
    ok: true,
    productos_sincronizados: menuPayload.products.length,
    categorias_sincronizadas: menuPayload.sections.length,
  });
}

// Import menú existente de PedidosYa → COMANDA. Mismo flow que Rappi
// pero con shape PeYa (sections en vez de categories).
async function handlePedidosyaImportMenu(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;
  if (!['dueno', 'admin', 'superadmin'].includes(auth.row.rol)) {
    return res.status(403).json({ error: 'PERMISO_DENEGADO' });
  }

  const { restaurant_id, local_id, production, dry_run } = req.body || {};
  if (!restaurant_id) return res.status(400).json({ error: 'RESTAURANT_ID_REQUERIDO' });

  const supabase = db();
  const creds = await getPedidosYaCredentials(supabase, auth.row.tenant_id);
  if (!creds) return res.status(400).json({ error: 'PEYA_NO_CONFIGURADA' });

  let peyaMenu;
  try {
    const peya = createPedidosYaClient(creds, { production: !!production });
    peyaMenu = await peya.getMenu(restaurant_id);
  } catch (err) {
    return res.status(502).json({ error: 'PEYA_GET_MENU_FAILED', detail: err.message || String(err) });
  }

  // Normalizar shape — PeYa usa sections/products típicamente
  const categoriasRaw = peyaMenu?.sections ?? peyaMenu?.categories ?? peyaMenu?.menu?.sections ?? [];
  const productosRaw = peyaMenu?.products ?? peyaMenu?.items ?? peyaMenu?.menu?.products ?? [];

  if (!Array.isArray(categoriasRaw) || !Array.isArray(productosRaw)) {
    return res.status(502).json({
      error: 'PEYA_MENU_SHAPE_INESPERADO',
      detail: 'No pudimos identificar sections[] ni products[] en el response.',
      raw_keys: peyaMenu ? Object.keys(peyaMenu) : [],
    });
  }

  const tenantId = auth.row.tenant_id;
  const localId = local_id ? Number(local_id) : null;
  const summary = {
    grupos_a_crear: 0, grupos_a_actualizar: 0,
    items_a_crear: 0, items_a_actualizar: 0,
    items_ignorados: 0,
  };
  const gruposMap = new Map();

  for (const cat of categoriasRaw) {
    const nombre = (cat.name || cat.nombre || '').trim();
    if (!nombre) continue;
    const externalId = String(cat.external_id || cat.id || nombre);

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

  for (const prod of productosRaw) {
    const nombre = (prod.name || prod.nombre || '').trim();
    if (!nombre) { summary.items_ignorados++; continue; }

    const skuPeya = String(prod.external_id || prod.id || `peya_${Date.now()}_${Math.random()}`);
    const precio = Number(prod.price ?? prod.precio ?? 0);
    if (precio <= 0) { summary.items_ignorados++; continue; }

    const catExternalId = prod.section_external_id || prod.category_id || prod.section_id;
    const grupoId = catExternalId ? gruposMap.get(String(catExternalId)) : null;

    const { data: existente } = await supabase
      .from('items')
      .select('id')
      .eq('tenant_id', tenantId)
      .or(`sku_pedidosya.eq.${skuPeya},nombre.eq.${nombre}`)
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
          sku_pedidosya: skuPeya,
          estado: (prod.enabled === false) ? 'agotado' : 'disponible',
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
          sku_pedidosya: skuPeya,
          estado: (prod.enabled === false) ? 'agotado' : 'disponible',
          visible_pos: true,
          visible_qr: false,
          visible_tienda: false,
        });
      }
    }
  }

  if (!dry_run) {
    await supabase.from('integraciones_externas_credenciales')
      .update({ estado: 'active', last_test_at: new Date().toISOString(), last_error: null })
      .eq('tenant_id', tenantId).eq('provider', 'pedidos-ya');
  }

  res.status(200).json({ ok: true, dry_run: !!dry_run, summary });
}

async function handlePedidosyaOrderAction(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;

  const { order_id, action: ordAction, prep_time_minutes, reason, production } = req.body || {};
  if (!order_id || !ordAction) {
    return res.status(400).json({ error: 'PARAMS_REQUERIDOS: order_id + action' });
  }
  if (!['accept', 'dispatch', 'cancel'].includes(ordAction)) {
    return res.status(400).json({ error: 'ACTION_INVALIDA: accept | dispatch | cancel' });
  }

  const supabase = db();
  const creds = await getPedidosYaCredentials(supabase, auth.row.tenant_id);
  if (!creds) return res.status(400).json({ error: 'PEYA_NO_CONFIGURADA' });

  try {
    const peya = createPedidosYaClient(creds, { production: !!production });
    let result;
    if (ordAction === 'accept') result = await peya.acceptOrder(order_id, prep_time_minutes || 30);
    else if (ordAction === 'dispatch') result = await peya.dispatchOrder(order_id);
    else result = await peya.cancelOrder(order_id, reason);

    res.status(200).json({ ok: true, action: ordAction, peya_response: result });
  } catch (err) {
    res.status(502).json({ error: `PEYA_${ordAction.toUpperCase()}_FAILED`, detail: err.message || String(err) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AFIP — probar conexión (validar cert + key + WSAA login)
// Útil ANTES de emitir la primera factura real: confirma que las creds
// realmente funcionan contra AFIP. Si falla acá, el dueño sabe que hay
// algo mal (cert vencido, key incorrecta, ambiente equivocado) sin tener
// que cobrar una venta para enterarse.
// ═══════════════════════════════════════════════════════════════════════════

async function handleAfipTestConnection(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;
  if (!['dueno', 'admin', 'superadmin'].includes(auth.row.rol)) {
    return res.status(403).json({ error: 'PERMISO_DENEGADO' });
  }

  const supabase = db();
  const { data: cred, error: credErr } = await supabase
    .from('afip_credenciales')
    .select('cuit, ambiente, cert_pem, key_pem, punto_venta, activa, tipo_contribuyente')
    .eq('tenant_id', auth.row.tenant_id)
    .single();

  if (credErr || !cred) {
    return res.status(400).json({ error: 'AFIP_NO_CONFIGURADA' });
  }
  if (!cred.cert_pem || !cred.key_pem) {
    return res.status(400).json({ error: 'AFIP_SIN_CERT_KEY' });
  }

  try {
    const afip = new Afip({
      CUIT: cred.cuit,
      cert: cred.cert_pem,
      key: cred.key_pem,
      production: cred.ambiente === 'produccion',
    });

    // 1) WSAA login — saca token para WSFEv1. Si falla acá, el cert/key
    //    es inválido o el servicio no está adherido.
    // 2) getLastVoucher — confirma que el punto de venta + tipo está
    //    habilitado. Tipo 11 = Factura C (más común para monotributo).
    const tipoChequeo = cred.tipo_contribuyente === 'responsable_inscripto' ? 6 : 11;
    const ultimoNumero = await afip.ElectronicBilling.getLastVoucher(cred.punto_venta, tipoChequeo);

    // Marcar last token success
    await supabase.from('afip_credenciales')
      .update({ ultimo_token_at: new Date().toISOString() })
      .eq('tenant_id', auth.row.tenant_id);

    return res.status(200).json({
      ok: true,
      message: 'Conexión exitosa con AFIP',
      ambiente: cred.ambiente,
      punto_venta: cred.punto_venta,
      proximo_numero: (ultimoNumero || 0) + 1,
      tipo_chequeado: tipoChequeo === 6 ? 'Factura B' : 'Factura C',
    });
  } catch (err) {
    const msg = err.message || String(err);
    return res.status(502).json({ error: 'AFIP_TEST_FAILED', detail: msg });
  }
}

// Verificadores de firma HMAC importados pero no wireados al webhook
// genérico todavía. Sprint próximo cuando Lucas tenga creds.
// AUDIT F5C#1: las funciones verify*Signature ahora SÍ se usan en
// handlePartnerWebhook. Eliminado el `void` que las marcaba como no-usadas.
