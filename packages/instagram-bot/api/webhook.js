// Webhook endpoint para Instagram Messaging.
//
// Meta envía dos cosas a esta URL:
//   GET  /api/webhook?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
//        → handshake inicial. Validamos verify_token y devolvemos challenge.
//   POST /api/webhook
//        → cada vez que un usuario manda un DM. Body con array de entries.
//
// Flujo POST:
//   1. Validar firma X-Hub-Signature-256 (anti-spoofing).
//   2. Para cada entry, identificar tenant via ig_config.ig_account_id.
//   3. Para cada mensaje del entry:
//      a. Upsert ig_clientes (si no existía, lo creamos).
//      b. Upsert ig_conversaciones.
//      c. Insertar ig_mensajes (dedup por ig_mid).
//      d. Si bot_activo + estado=bot → procesar con Claude + responder.
//      e. Si bot inactivo o conversación en humano → solo guardar.
//   4. Devolver 200 OK siempre (Meta reintenta si dice <>200).

import { db } from './_lib/db.js';
import { validarFirmaWebhook, enviarMensaje, marcarLeido, escribiendo } from './_lib/meta.js';
import { llamarClaude } from './_lib/claude.js';
import { getSystemPrompt } from './_lib/prompt.js';
import { notificarDMNuevo } from './_lib/push.js';

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;

export const config = {
  // Vercel: necesitamos el body crudo para validar la firma HMAC.
  // El default ya parsea como JSON, pero la validación de firma se hace
  // sobre el string original. Lo manejamos guardando el raw en
  // handler via req.body (Vercel lo parsea pero podemos reconstruir).
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  // ─── GET: handshake de verificación ───────────────────────────────────
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
      console.log('[webhook] handshake OK');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // ─── POST: mensaje entrante ──────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'CANNOT_READ_BODY', detail: String(e?.message || e) });
  }

  // Validar firma de Meta (defensa contra spoofing del webhook)
  if (META_APP_SECRET) {
    const ok = validarFirmaWebhook(rawBody, req.headers['x-hub-signature-256'], META_APP_SECRET);
    if (!ok) {
      console.warn('[webhook] firma inválida');
      // Logueamos el evento pero devolvemos 200 (Meta no reintenta)
      await db.from('ig_eventos').insert({
        tipo: 'error',
        error_message: 'firma X-Hub-Signature-256 inválida',
      });
      return res.status(403).send('Invalid signature');
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'INVALID_JSON' });
  }

  // Logueamos el webhook crudo para debugging
  await db.from('ig_eventos').insert({
    tipo: 'webhook_received',
    payload,
  });

  // IMPORTANTE: procesar ANTES de responder 200 porque en Vercel
  // serverless la función termina al responder y el await en background
  // se cancela. Meta tolera respuestas en <20s antes de retry, y Claude
  // Haiku responde en 1-3s, así que tenemos margen.
  try {
    await procesarPayload(payload);
  } catch (e) {
    console.error('[webhook] procesamiento falló:', e);
    await db.from('ig_eventos').insert({
      tipo: 'error',
      error_message: String(e?.message || e),
      payload: { stage: 'procesarPayload', original: payload },
    });
  }

  return res.status(200).send('EVENT_RECEIVED');
}

// ─── Procesamiento ────────────────────────────────────────────────────

async function procesarPayload(payload) {
  // Meta puede mandar varios entries en un solo webhook (rare pero pasa)
  for (const entry of payload.entry || []) {
    const ig_account_id = entry.id;  // viene como string numérico

    // Buscar config del tenant que posee esta cuenta IG
    const { data: cfg, error: cfgErr } = await db
      .from('ig_config')
      .select('*')
      .eq('ig_account_id', ig_account_id)
      .single();

    if (cfgErr || !cfg) {
      console.warn(`[webhook] ig_account_id ${ig_account_id} no tiene config registrada`);
      await db.from('ig_eventos').insert({
        tipo: 'error',
        error_message: `ig_account_id ${ig_account_id} sin config`,
        payload: entry,
      });
      continue;
    }

    // Procesar cada messaging event del entry
    for (const event of entry.messaging || []) {
      // Los echo events (mensajes que NOSOTROS enviamos) llegan también.
      // Filtrar para no caer en loop.
      if (event.message?.is_echo) continue;

      // Bug 27-may (Lucas reportó "[unsupported]" pollutando los chats):
      // Meta manda varios eventos sin `event.message` que no son mensajes
      // reales del cliente:
      //   - event.read    → read receipt ("visto"), el cliente leyó algo nuestro
      //   - event.reaction → like/heart en uno de nuestros mensajes
      //   - event.delivery → confirmación de delivery
      //   - event.postback → click de botón (no usamos)
      //   - event.referral → click desde una ad o link parámetro
      // Estos NO deberían crear filas en `ig_mensajes` — solo loguearlos.
      if (!event.message) {
        const otroTipo = event.read ? 'read_receipt'
          : event.reaction ? 'reaction'
          : event.delivery ? 'delivery'
          : event.postback ? 'postback'
          : event.referral ? 'referral'
          : 'desconocido';
        // Log opcional pero NO insert en ig_mensajes.
        await db.from('ig_eventos').insert({
          tenant_id: cfg.tenant_id,
          tipo: `meta_${otroTipo}`,
          payload: event,
        }).catch(() => { /* no crítico */ });
        continue;
      }

      const sender_igsid = event.sender?.id;
      if (!sender_igsid) continue;

      // El sender_igsid puede ser el mismo ig_account_id si el bot mismo
      // se manda algo. Filtrar.
      if (sender_igsid === ig_account_id) continue;

      try {
        await procesarMensajeEntrante({ cfg, event, sender_igsid });
      } catch (e) {
        console.error('[webhook] mensaje individual falló:', e);
        await db.from('ig_eventos').insert({
          tenant_id: cfg.tenant_id,
          tipo: 'error',
          error_message: String(e?.message || e),
          payload: { stage: 'procesarMensajeEntrante', event },
        });
      }
    }
  }
}

async function procesarMensajeEntrante({ cfg, event, sender_igsid }) {
  // Upsert cliente
  const { data: cliente } = await db
    .from('ig_clientes')
    .upsert(
      { tenant_id: cfg.tenant_id, igsid: sender_igsid },
      { onConflict: 'tenant_id,igsid' },
    )
    .select('*')
    .single();

  if (cliente?.bloqueado) {
    console.log(`[webhook] cliente ${sender_igsid} bloqueado — ignoramos`);
    return;
  }

  // AUDIT F6A#1: NO sobreescribir el `estado` de una conversación existente.
  // Antes el upsert seteaba estado='bot' en cada DM nuevo → si el dueño
  // tomaba la conversación como humano y el cliente seguía escribiendo, el
  // bot reactivaba la conversación automáticamente y respondía sobre lo
  // que el humano había dicho. Ahora: SELECT primero, si no existe creamos
  // con 'bot' por default; si existe respetamos su estado actual.
  let conv;
  {
    const { data: existing } = await db
      .from('ig_conversaciones')
      .select('*')
      .eq('tenant_id', cfg.tenant_id)
      .eq('cliente_id', cliente.id)
      .maybeSingle();
    if (existing) {
      conv = existing;
    } else {
      const { data: nueva } = await db
        .from('ig_conversaciones')
        .insert({ tenant_id: cfg.tenant_id, cliente_id: cliente.id, estado: 'bot' })
        .select('*')
        .single();
      conv = nueva;
    }
  }

  // Extraer info del mensaje
  const msg = event.message;
  const mid = msg?.mid;
  let tipo = 'unsupported';
  let texto = null;
  let media_url = null;

  if (msg?.text) {
    tipo = 'texto';
    texto = msg.text;
  } else if (msg?.attachments?.[0]) {
    const att = msg.attachments[0];
    tipo = att.type || 'unsupported';  // image | video | audio | file | sticker
    media_url = att.payload?.url || null;
  }

  // Insertar mensaje (dedup por mid + tenant)
  const { error: msgInsertErr } = await db.from('ig_mensajes').insert({
    conversacion_id: conv.id,
    tenant_id: cfg.tenant_id,
    direccion: 'in',
    origen: 'cliente',
    tipo,
    texto,
    media_url,
    ig_mid: mid,
  });

  if (msgInsertErr) {
    // Probable duplicado de mid — Meta a veces reintenta. Ignorar.
    if (msgInsertErr.code === '23505') {
      console.log(`[webhook] mid ${mid} duplicado, skip`);
      return;
    }
    throw new Error(`insertar mensaje: ${msgInsertErr.message}`);
  }

  // Push notification a superadmins suscriptos (Lucas en celu).
  // Cooldown de 5min por conversación — anti-spam.
  // No bloquea el flujo del bot si falla.
  notificarDMNuevo({ db, cfg, cliente, texto, conv }).catch((e) => {
    console.warn('[webhook] push notif falló (no crítico):', e?.message);
  });

  // Si el bot está apagado o la conversación está en humano/cerrada,
  // solo guardamos el mensaje y no respondemos.
  if (!cfg.bot_activo) return;
  if (conv.estado !== 'bot') return;

  // AUDIT F2D #27 fase 2: la columna page_access_token plana fue droppeada
  // en F6 sprint. get_ig_token RPC es la única fuente del token IG ahora.
  const { data: tokenIG } = await db.rpc('get_ig_token', { p_tenant_id: cfg.tenant_id });
  const pageAccessToken = tokenIG;
  if (!pageAccessToken) {
    console.warn('[webhook] no hay token IG para tenant', cfg.tenant_id);
    return;
  }

  // AUDIT F6A#2: rate limit per-tenant. Las columnas existían pero NUNCA
  // se leían. Sin esto, 5000 DMs de un mismo cliente en 30s ≈ $150 USD de
  // Claude sin tope. Defaults: 30 msgs en 5min si la config no define.
  const rateMaxMsgs = cfg.rate_limit_msgs ?? 30;
  const rateWindowMin = cfg.rate_limit_minutos ?? 5;
  if (rateMaxMsgs > 0 && rateWindowMin > 0) {
    const cutoff = new Date(Date.now() - rateWindowMin * 60_000).toISOString();
    const { count } = await db.from('ig_mensajes')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', cfg.tenant_id)
      .eq('direccion', 'out')
      .eq('origen', 'bot')
      .gte('created_at', cutoff);
    if ((count ?? 0) >= rateMaxMsgs) {
      console.warn(`[webhook] rate limit hit tenant=${cfg.tenant_id} (${count}/${rateMaxMsgs} en ${rateWindowMin}min). Skip respuesta.`);
      // Loguear evento para que el dueño lo vea en Mensajería
      await db.from('ig_eventos').insert({
        tenant_id: cfg.tenant_id,
        conversacion_id: conv.id,
        tipo: 'rate_limit_hit',
        error_message: `${count} respuestas del bot en ${rateWindowMin}min (limite ${rateMaxMsgs})`,
        payload: { igsid: sender_igsid, ig_username: cliente.ig_username || null },
      }).catch(() => { /* no crítico */ });
      return;
    }
  }

  // Marcar como leído + mostrar "escribiendo"
  await marcarLeido({ pageAccessToken, igsid: sender_igsid });
  await escribiendo({ pageAccessToken, igsid: sender_igsid, on: true });

  // Armar contexto: últimos N mensajes de la conversación.
  // Bug encontrado 22-may noche (Lucas reportó que el bot no respondía
  // mensajes nuevos en conversaciones largas): la query traía los PRIMEROS
  // N en orden ascendente, no los últimos N. En convs con muchos mensajes
  // viejos, el "Hola" reciente quedaba fuera de la ventana y el bot
  // skipeaba con "último mensaje no es user".
  // Fix: order DESC + limit + reverse en JS para devolver los últimos N
  // ordenados cronológicamente (lo que necesita Claude).
  const { data: historicoDesc } = await db
    .from('ig_mensajes')
    .select('direccion, origen, tipo, texto, created_at')
    .eq('conversacion_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(cfg.contexto_mensajes || 30);

  const historico = (historicoDesc || []).reverse();

  const messagesParaClaude = historico
    .filter((m) => m.texto)  // solo mensajes de texto para Sprint B
    .map((m) => ({
      role: m.direccion === 'in' ? 'user' : 'assistant',
      content: m.texto,
    }));

  // Si por algún motivo no hay mensajes (race condition?), usar el texto actual
  if (messagesParaClaude.length === 0 && texto) {
    messagesParaClaude.push({ role: 'user', content: texto });
  }

  // Si el último mensaje no es 'user' (esperamos turno del usuario), saltar
  if (messagesParaClaude[messagesParaClaude.length - 1]?.role !== 'user') {
    console.log('[webhook] último mensaje no es user, skip');
    return;
  }

  // Agregar info del cliente al system prompt (memoria persistente)
  const systemPrompt = construirSystemPromptConContexto(cfg, cliente);

  // Llamar Claude
  let respuesta;
  try {
    respuesta = await llamarClaude({
      systemPrompt,
      messages: messagesParaClaude,
      modelo: cfg.modelo,
      maxTokens: cfg.max_tokens,
    });
  } catch (e) {
    console.error('[webhook] Claude falló:', e);
    await db.from('ig_eventos').insert({
      tenant_id: cfg.tenant_id,
      conversacion_id: conv.id,
      tipo: 'error',
      error_message: `Claude API: ${String(e?.message || e)}`,
    });
    return;
  }

  if (!respuesta.texto || respuesta.texto.trim().length === 0) {
    console.warn('[webhook] Claude devolvió respuesta vacía');
    return;
  }

  // Enviar respuesta a Instagram (token encrypted)
  const envio = await enviarMensaje({
    pageAccessToken,
    igsid: sender_igsid,
    texto: respuesta.texto,
  });

  // Guardar el mensaje saliente con tracking de costo
  await db.from('ig_mensajes').insert({
    conversacion_id: conv.id,
    tenant_id: cfg.tenant_id,
    direccion: 'out',
    origen: 'bot',
    tipo: 'texto',
    texto: respuesta.texto,
    ig_mid: envio.message_id,
    llm_tokens_in: respuesta.tokens_in,
    llm_tokens_out: respuesta.tokens_out,
    llm_cost_usd: respuesta.costo_usd,
    error: envio.ok ? null : envio.error,
  });

  // Apagar typing indicator
  await escribiendo({ pageAccessToken, igsid: sender_igsid, on: false });
}

function construirSystemPromptConContexto(cfg, cliente) {
  const base = getSystemPrompt(cfg);
  // Agregar memoria del cliente al final del prompt si tenemos info
  const memoria = [];
  if (cliente.nombre) memoria.push(`Nombre: ${cliente.nombre}`);
  if (cliente.telefono) memoria.push(`Teléfono: ${cliente.telefono}`);
  if (cliente.alergias) memoria.push(`Alergias: ${cliente.alergias}`);
  if (cliente.preferencias) memoria.push(`Preferencias: ${cliente.preferencias}`);
  if (cliente.mensajes_count > 1) memoria.push(`Es un cliente recurrente (${cliente.mensajes_count} mensajes previos).`);

  if (memoria.length === 0) return base;
  return base + '\n\n## CONTEXTO DEL CLIENTE\n' + memoria.join('\n');
}
