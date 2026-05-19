// _rappi.js — cliente Rappi Restaurant Integration API v3.
//
// Documentación oficial:
//   - https://restaurantes.rappi.com.ar/api (link al dashboard partner)
//   - https://services-staging.dev.rappi.com/api/restaurants-integrations-public-api/swagger-ui/index.html
//
// Flow OAuth 2 (client_credentials):
//   1. POST /api/cargo-public-api-token/api/access-token con client_id+secret
//   2. AFIPSDK retorna { access_token, expires_in }
//   3. Reusar el token hasta 5 min antes de expirar
//
// Operaciones que cubrimos:
//   - syncMenu(storeId, menuJson): PUT del catálogo entero.
//   - takeOrder(orderId): aceptar un pedido.
//   - dispatchOrder(orderId, etaMinutes?): marcar enviado.
//   - cancelOrder(orderId, reason): rechazar/cancelar con motivo.
//   - getOrder(orderId): traer detalle desde Rappi.
//
// El helper NO maneja persistencia del token entre requests serverless —
// cada cold-start saca uno nuevo. Para volúmenes <100/min es aceptable.
// Si escala, pasar a cachear en una tabla `rappi_oauth_tokens`.

const STAGING_BASE = 'https://services-staging.dev.rappi.com';
const PROD_BASE = 'https://services.rappi.com';

// Cache en memoria por (clientId) — sobrevive entre invocaciones SOLO si
// la function se mantiene "warm". Mejora latencia, no es indispensable.
const _tokenCache = new Map(); // clientId -> { token, expiresAt }

/**
 * Crea un cliente Rappi configurado con credenciales del tenant.
 *
 * @param {object} creds — del row integraciones_externas_credenciales.credentials
 *   { api_key, api_secret, partner_id, webhook_secret? }
 *   api_key === client_id en jerga Rappi.
 * @param {object} opts
 * @param {boolean} opts.production — true = endpoints prod, false = staging
 */
export function createRappiClient(creds, opts = {}) {
  const baseUrl = opts.production ? PROD_BASE : STAGING_BASE;
  const clientId = creds.api_key;
  const clientSecret = creds.api_secret;

  if (!clientId || !clientSecret) {
    throw new Error('RAPPI_CREDS_INVALIDAS: faltan api_key o api_secret en credentials JSON');
  }

  async function getAccessToken() {
    const cached = _tokenCache.get(clientId);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cached.token;
    }

    const resp = await fetch(`${baseUrl}/api/cargo-public-api-token/api/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        audience: opts.production ? 'public' : 'public-staging',
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`RAPPI_AUTH_FAILED ${resp.status}: ${detail}`);
    }
    const data = await resp.json();
    if (!data.access_token) throw new Error('RAPPI_AUTH_NO_TOKEN');

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
      const err = new Error(`RAPPI_${resp.status}: ${json?.message || text || 'sin detalle'}`);
      err.status = resp.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    baseUrl,
    clientId,

    /** PUT del catálogo entero. Idempotente — Rappi sobrescribe el menú anterior. */
    async syncMenu(storeId, menuJson) {
      return apiRequest('PUT', `/api/restaurants-integrations-public-api/api/v3/menu/${storeId}`, menuJson);
    },

    /**
     * Acepta un pedido. Rappi notifica al cliente final que el restaurant
     * está preparando. Equivalente a "necesita_aprobacion" → "en_preparacion".
     * @param prepTimeMinutes tiempo estimado de preparación
     */
    async takeOrder(orderId, prepTimeMinutes = 30) {
      return apiRequest('POST', `/api/restaurants-integrations-public-api/api/v3/orders/${orderId}/take`, {
        cooking_time: prepTimeMinutes,
      });
    },

    /**
     * Marca el pedido como listo para retirar / despachado.
     * Después de esto Rappi notifica al delivery (Rappi-tendero o partner).
     */
    async dispatchOrder(orderId, etaMinutes = 0) {
      return apiRequest('POST', `/api/restaurants-integrations-public-api/api/v3/orders/${orderId}/dispatch`, {
        eta: etaMinutes,
      });
    },

    /** Cancela un pedido. Motivos típicos: NO_STOCK, NO_DELIVERY, OTHER. */
    async cancelOrder(orderId, reason) {
      return apiRequest('POST', `/api/restaurants-integrations-public-api/api/v3/orders/${orderId}/cancel`, {
        reason: reason || 'OTHER',
      });
    },

    /** Trae detalle de un pedido (útil para reconciliar webhooks tardíos). */
    async getOrder(orderId) {
      return apiRequest('GET', `/api/restaurants-integrations-public-api/api/v3/orders/${orderId}`);
    },

    /** Ping para validar credenciales — intenta sacar un token. */
    async testConnection() {
      await getAccessToken();
      return { ok: true };
    },
  };
}

/**
 * Helper para obtener las credentials de un tenant desde la DB.
 * Maneja el lookup en `integraciones_externas_credenciales`.
 */
export async function getRappiCredentials(supabase, tenantId) {
  const { data, error } = await supabase
    .from('integraciones_externas_credenciales')
    .select('credentials, estado')
    .eq('tenant_id', tenantId)
    .eq('provider', 'rappi')
    .single();
  if (error || !data) return null;
  return data.credentials;
}

/**
 * Verifica firma HMAC de un webhook de Rappi. Rappi manda en el header
 * 'x-rappi-signature' el HMAC-SHA256 hex del body. Si no matchea, rechazar.
 */
export async function verifyRappiWebhookSignature(req, secret) {
  if (!secret) return true; // sin secret configurado, no validamos (modo dev)
  const sig = req.headers['x-rappi-signature'] || req.headers['x-signature'];
  if (!sig) return false;
  const crypto = await import('node:crypto');
  // body raw — Vercel parsea como JSON pero si tenemos req.rawBody mejor
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  // timing-safe compare
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
