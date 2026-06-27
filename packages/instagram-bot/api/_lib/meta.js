// Helpers para hablar con la Graph API de Meta (Instagram Messaging).
//
// IMPORTANTE: usamos Instagram Login API (token empieza con IGAA), por lo
// tanto el endpoint es graph.instagram.com (no graph.facebook.com como
// es con Facebook Login API).
//
// Docs:
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api

import crypto from 'crypto';

const GRAPH_API_VERSION = 'v21.0';

/**
 * Valida la firma X-Hub-Signature-256 que Meta manda con cada webhook.
 * Garantiza que el body viene de Meta y no de un atacante con la URL.
 *
 * @param {string} rawBody - body del request como string crudo
 * @param {string|undefined} signatureHeader - valor del header 'x-hub-signature-256'
 * @param {string} appSecret - META_APP_SECRET env var
 * @returns {boolean}
 */
export function validarFirmaWebhook(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  // Header viene como 'sha256=<hex>'
  const [algo, hash] = signatureHeader.split('=');
  if (algo !== 'sha256' || !hash) return false;

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  // timingSafeEqual evita ataques de timing
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Envía un mensaje de texto a un usuario de Instagram via Graph API.
 *
 * @param {object} opts
 * @param {string} opts.pageAccessToken - token de la página FB conectada al IG
 * @param {string} opts.igsid - Instagram-Scoped User ID del destinatario
 * @param {string} opts.texto - cuerpo del mensaje (max ~1000 chars seguros)
 * @returns {Promise<{ok: boolean, message_id?: string, error?: string}>}
 */
export async function enviarMensaje({ pageAccessToken, igsid, texto }) {
  const url = `https://graph.instagram.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  const body = {
    recipient: { id: igsid },
    message: { text: texto },
    // 'RESPONSE' = respondemos a un mensaje del usuario dentro de la ventana de 24h
    messaging_type: 'RESPONSE',
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return {
        ok: false,
        error: data?.error?.message || `HTTP ${resp.status}`,
      };
    }
    return {
      ok: true,
      message_id: data.message_id,
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e),
    };
  }
}

/**
 * Trae el perfil público del usuario de Instagram (nombre, @username, foto).
 * Funciona para usuarios con una conversación activa con el negocio.
 *
 * @param {object} opts
 * @param {string} opts.pageAccessToken
 * @param {string} opts.igsid - Instagram-Scoped User ID del cliente
 * @returns {Promise<{ok: boolean, name?: string|null, username?: string|null, profile_pic?: string|null, error?: string}>}
 */
export async function obtenerPerfil({ pageAccessToken, igsid }) {
  const url = `https://graph.instagram.com/${GRAPH_API_VERSION}/${encodeURIComponent(igsid)}?fields=name,username,profile_pic&access_token=${encodeURIComponent(pageAccessToken)}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) {
      return { ok: false, error: data?.error?.message || `HTTP ${resp.status}` };
    }
    return {
      ok: true,
      name: data.name ?? null,
      username: data.username ?? null,
      profile_pic: data.profile_pic ?? null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Marca el chat como "leído" (cliente ve los ✓✓ azules). Buena práctica
 * después de procesar un mensaje para que el usuario sepa que llegó.
 */
export async function marcarLeido({ pageAccessToken, igsid }) {
  const url = `https://graph.instagram.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: igsid },
        sender_action: 'mark_seen',
      }),
    });
  } catch {
    // Silent fail — no es crítico
  }
}

/**
 * Muestra el indicador "escribiendo..." (los puntitos animados).
 * Útil para feedback inmediato mientras Claude piensa.
 *
 * Meta cierra automáticamente el indicador después de 20s o cuando se
 * manda un mensaje real, lo que pase primero.
 */
export async function escribiendo({ pageAccessToken, igsid, on = true }) {
  const url = `https://graph.instagram.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: igsid },
        sender_action: on ? 'typing_on' : 'typing_off',
      }),
    });
  } catch {
    // Silent fail
  }
}
