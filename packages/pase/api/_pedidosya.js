// _pedidosya.js — cliente PedidosYa POS Integration API.
//
// Documentación oficial:
//   - https://developers.pedidosya.com/ (Partner Hub)
//   - https://developers.pedidosya.com/docs/integrations/pos
//
// Flow OAuth 2 (client_credentials):
//   1. POST /v3/oauth/token con client_id + client_secret
//   2. PeYa retorna { access_token, expires_in (typically 3600), token_type: 'Bearer' }
//   3. Reusar el token hasta 5 min antes de expirar (cache en memoria)
//
// Operaciones que cubrimos (espejo del helper _rappi.js):
//   - getMenu(restaurantId): trae catálogo actual de PeYa.
//   - syncMenu(restaurantId, menuJson): PUT del catálogo completo.
//   - acceptOrder(orderId, prepMin): aceptar pedido.
//   - dispatchOrder(orderId): marcar despachado / listo.
//   - cancelOrder(orderId, reason): rechazar.
//   - getOrder(orderId): traer detalle.
//   - testConnection(): valida creds via OAuth.

const STAGING_BASE = 'https://api-stg.pedidosya.com';
const PROD_BASE = 'https://partner-api.pedidosya.com';

const _tokenCache = new Map(); // clientId -> { token, expiresAt }

export function createPedidosYaClient(creds, opts = {}) {
  const baseUrl = opts.production ? PROD_BASE : STAGING_BASE;
  const clientId = creds.client_id;
  const clientSecret = creds.client_secret;

  if (!clientId || !clientSecret) {
    throw new Error('PEYA_CREDS_INVALIDAS: faltan client_id o client_secret');
  }

  async function getAccessToken() {
    const cached = _tokenCache.get(clientId);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cached.token;
    }

    // PeYa usa form-encoded para OAuth, no JSON
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const resp = await fetch(`${baseUrl}/v3/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`PEYA_AUTH_FAILED ${resp.status}: ${detail}`);
    }
    const data = await resp.json();
    if (!data.access_token) throw new Error('PEYA_AUTH_NO_TOKEN');

    const token = data.access_token;
    const expiresIn = (data.expires_in || 3600) * 1000;
    _tokenCache.set(clientId, { token, expiresAt: Date.now() + expiresIn });
    return token;
  }

  async function apiRequest(method, path, body) {
    const token = await getAccessToken();
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

    if (!resp.ok) {
      const err = new Error(`PEYA_${resp.status}: ${json?.message || json?.error || text || 'sin detalle'}`);
      err.status = resp.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    baseUrl,
    clientId,

    /** PUT del catálogo. PedidosYa sobrescribe el menú anterior. */
    async syncMenu(restaurantId, menuJson) {
      return apiRequest('PUT', `/v3/integrations/restaurants/${restaurantId}/menu`, menuJson);
    },

    /** GET del menú existente de un restaurant. */
    async getMenu(restaurantId) {
      return apiRequest('GET', `/v3/integrations/restaurants/${restaurantId}/menu`);
    },

    /** Confirma pedido (PeYa lo llama "confirm" — equivalente a Rappi "take"). */
    async acceptOrder(orderId, prepTimeMinutes = 30) {
      return apiRequest('POST', `/v3/integrations/orders/${orderId}/confirm`, {
        preparation_time: prepTimeMinutes,
      });
    },

    /** Marca el pedido como listo / despachado. */
    async dispatchOrder(orderId) {
      return apiRequest('POST', `/v3/integrations/orders/${orderId}/dispatch`, {});
    },

    /** Rechaza pedido. Razones típicas PeYa: out_of_stock, restaurant_closed,
     *  cannot_deliver, duplicate, other. */
    async cancelOrder(orderId, reason) {
      return apiRequest('POST', `/v3/integrations/orders/${orderId}/reject`, {
        reason: reason || 'other',
      });
    },

    /** Trae detalle de un pedido. */
    async getOrder(orderId) {
      return apiRequest('GET', `/v3/integrations/orders/${orderId}`);
    },

    /** Ping para validar credenciales. */
    async testConnection() {
      await getAccessToken();
      return { ok: true };
    },
  };
}

/** Helper: obtener credentials de un tenant desde DB. */
export async function getPedidosYaCredentials(supabase, tenantId) {
  const { data, error } = await supabase
    .from('integraciones_externas_credenciales')
    .select('credentials, estado')
    .eq('tenant_id', tenantId)
    .eq('provider', 'pedidos-ya')
    .single();
  if (error || !data) return null;
  return data.credentials;
}

/**
 * Verificación de firma HMAC del webhook PedidosYa. PeYa manda firma en
 * header 'X-PeYa-Signature' formato HMAC-SHA256 base64.
 */
export async function verifyPedidosYaWebhookSignature(req, secret) {
  if (!secret) return true; // sin secret configurado, permitimos (modo dev)
  const sig = req.headers['x-peya-signature'] || req.headers['x-signature'];
  if (!sig) return false;
  const crypto = await import('node:crypto');
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
