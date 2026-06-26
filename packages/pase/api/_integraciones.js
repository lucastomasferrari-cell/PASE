// Helper centralizado para credenciales por tenant (tabla `integraciones`).
//
// Cada endpoint que necesite mandar WhatsApp/Email/Stripe/etc. usa este helper
// en vez de leer env vars directo. Resultado: cada tenant tiene SUS PROPIAS
// credenciales (multi-tenant friendly), pero como fallback se respetan env
// vars globales (útil mientras Lucas opera 1 tenant).
//
// Uso:
//   import { getCredencial, sendWhatsApp, sendEmailTransactional } from './_integraciones.js';
//   const wa = await getCredencial(supabase, tenantId, 'whatsapp_api');
//   if (wa) await sendWhatsApp({ wa, to: '+5491156781234', texto: 'Hola' });

const GRAPH = 'https://graph.facebook.com';
const WHATSAPP_API_VERSION = 'v21.0';
const RESEND_API = 'https://api.resend.com';

/**
 * Lee la credencial de un tenant para un provider dado. Si no hay fila en
 * `integraciones`, cae a env vars globales (1-tenant mode).
 * @returns {Promise<{ config: object, source: 'tenant'|'env' } | null>}
 */
export async function getCredencial(supabase, tenantId, provider) {
  // 1. Buscar en tabla integraciones (multi-tenant)
  if (tenantId) {
    const { data } = await supabase
      .from('integraciones')
      .select('config, estado')
      .eq('tenant_id', tenantId)
      .eq('provider', provider)
      .maybeSingle();
    if (data?.config) return { config: data.config, source: 'tenant', estado: data.estado };
  }

  // 2. Fallback a env vars globales (legacy / single-tenant mode)
  const envMap = {
    whatsapp_api: {
      access_token: process.env.WHATSAPP_TOKEN,
      phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID,
    },
    email: {
      api_key: process.env.RESEND_API_KEY,
      from: process.env.RESEND_FROM,
    },
    meta_ads: {
      access_token: process.env.META_ADS_TOKEN,
      ad_account_id: process.env.META_ADS_ACCOUNT_ID,
    },
    google_maps: {
      api_key: process.env.GOOGLE_PLACES_API_KEY,
    },
    stripe: {
      secret_key: process.env.STRIPE_SECRET_KEY,
      webhook_secret: process.env.STRIPE_WEBHOOK_SECRET,
    },
  };
  const envCfg = envMap[provider];
  if (envCfg && Object.values(envCfg).some((v) => !!v)) {
    return { config: envCfg, source: 'env' };
  }

  return null;
}

/**
 * Envía un mensaje de WhatsApp via Cloud API. `wa` viene de getCredencial.
 * Soporta texto libre (dentro de 24hs de la última interacción) o template
 * aprobado (para iniciar conversación).
 */
export async function sendWhatsApp({ wa, to, texto, template }) {
  if (!wa?.config) return { ok: false, configured: false, error: 'wa_sin_credenciales' };
  const { access_token, phone_number_id } = wa.config;
  if (!access_token || !phone_number_id) {
    return { ok: false, configured: false, error: 'wa_credenciales_incompletas' };
  }

  let payload;
  if (template) {
    payload = {
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: template.nombre,
        language: { code: template.idioma || 'es_AR' },
        ...(Array.isArray(template.variables) && template.variables.length
          ? { components: [{ type: 'body', parameters: template.variables.map((v) => ({ type: 'text', text: String(v) })) }] }
          : {}),
      },
    };
  } else {
    payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: texto || '' } };
  }

  try {
    const r = await fetch(`${GRAPH}/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      return { ok: false, configured: true, error: data?.error?.message || `HTTP ${r.status}`, raw: data };
    }
    return { ok: true, configured: true, messageId: data?.messages?.[0]?.id ?? null };
  } catch (e) {
    return { ok: false, configured: true, error: e?.message || String(e) };
  }
}

/**
 * Envía un email transaccional via Resend. `email` viene de getCredencial.
 */
export async function sendEmailTransactional({ email, to, subject, html, text }) {
  if (!email?.config) return { ok: false, configured: false, error: 'email_sin_credenciales' };
  const { api_key, from } = email.config;
  if (!api_key) return { ok: false, configured: false, error: 'email_api_key_falta' };
  if (!from) return { ok: false, configured: false, error: 'email_from_falta' };

  const recipients = Array.isArray(to) ? to : [to];
  try {
    const r = await fetch(`${RESEND_API}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: recipients, subject, html, text }),
    });
    const data = await r.json();
    if (!r.ok) {
      return { ok: false, configured: true, error: data?.message || `HTTP ${r.status}` };
    }
    return { ok: true, configured: true, id: data?.id ?? null };
  } catch (e) {
    return { ok: false, configured: true, error: e?.message || String(e) };
  }
}

/**
 * Levanta una credencial Stripe del tenant para hacer operaciones billing.
 */
export async function getStripeKey(supabase, tenantId) {
  const cred = await getCredencial(supabase, tenantId, 'stripe');
  return cred?.config?.secret_key ?? null;
}
