// Helpers del módulo de email marketing (Habitué). NO es un endpoint (_ prefix).
//
// Concentra la lógica compartida entre mkt.js (envío), mkt-webhook.js (eventos)
// y mkt-unsubscribe.js (bajas): llamada a Resend, merge tags, tokens de baja
// firmados y verificación de la firma del webhook (Svix, que es lo que usa Resend).

import { createHmac, timingSafeEqual } from 'node:crypto';

const RESEND_API = 'https://api.resend.com/emails';
export const RESEND_BATCH_API = 'https://api.resend.com/emails/batch';

// ── Merge tags: {{nombre}}, {{email}}, etc. → valores del contacto ──────────
// Uso: renderTemplate('Hola {{nombre}}', { nombre: 'Ana' }) → 'Hola Ana'.
// Faltantes → string vacío (no deja "{{x}}" crudo en el mail).
export function renderTemplate(tpl, vars) {
  if (!tpl) return '';
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
    const v = vars?.[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

// ── Token de baja firmado (HMAC) — sin estado, verificable en el endpoint ──
// El link de "darse de baja" lleva email+tenant+firma; no se puede falsificar
// sin el secreto. Base64url para que viaje limpio en la URL.
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function firmarBajaToken(email, tenantId, secret) {
  const payload = `${email.trim().toLowerCase()}|${tenantId}`;
  const sig = createHmac('sha256', secret).update(payload).digest();
  return `${b64url(Buffer.from(payload))}.${b64url(sig)}`;
}
export function verificarBajaToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [p, s] = token.split('.');
  let payload;
  try {
    payload = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return null; }
  const esperado = b64url(createHmac('sha256', secret).update(payload).digest());
  const a = Buffer.from(s || '');
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [email, tenantId] = payload.split('|');
  if (!email || !tenantId) return null;
  return { email, tenantId };
}

// ── URL de baja (one-click) para el header List-Unsubscribe + link visible ──
export function urlBaja(baseUrl, email, tenantId, secret) {
  const t = firmarBajaToken(email, tenantId, secret);
  return `${baseUrl}/api/mkt-unsubscribe?token=${encodeURIComponent(t)}`;
}

// ── Envío por Resend (un request = hasta 1 destinatario acá; batch aparte) ──
// Devuelve { id, error }. Incluye headers List-Unsubscribe (one-click, requerido
// por Gmail/Yahoo para envíos masivos) y tags para correlacionar en el webhook.
export async function resendEnviar({ apiKey, from, replyTo, to, subject, html, text, unsubUrl, tags }) {
  const headers = unsubUrl
    ? { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined;
  try {
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to, subject,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(html ? { html } : { text: text || '' }),
        ...(headers ? { headers } : {}),
        ...(tags ? { tags } : {}),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { id: null, error: data?.message || `HTTP ${r.status}` };
    return { id: data?.id ?? null, error: null };
  } catch (e) {
    return { id: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Verificación de la firma del webhook (Svix, lo que usa Resend) ──────────
// Header svix-signature = "v1,<base64hmac> v1,<otra>...". La firma es
// HMAC-SHA256 de `${svix_id}.${svix_timestamp}.${rawBody}` con el secreto
// (whsec_<base64>). Devuelve true/false. rawBody debe ser el body CRUDO.
export function verificarFirmaWebhook(secret, headers, rawBody) {
  try {
    if (!secret) return false;
    const id = headers['svix-id'] || headers['webhook-id'];
    const ts = headers['svix-timestamp'] || headers['webhook-timestamp'];
    const sigHeader = headers['svix-signature'] || headers['webhook-signature'];
    if (!id || !ts || !sigHeader) return false;
    const key = secret.startsWith('whsec_')
      ? Buffer.from(secret.slice(6), 'base64')
      : Buffer.from(secret, 'utf8');
    const signed = `${id}.${ts}.${rawBody}`;
    const esperado = createHmac('sha256', key).update(signed).digest('base64');
    // El header puede traer varias firmas separadas por espacio.
    for (const part of sigHeader.split(' ')) {
      const sig = part.includes(',') ? part.split(',')[1] : part;
      const a = Buffer.from(sig);
      const b = Buffer.from(esperado);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Lee el body crudo de un request (necesario para verificar la firma antes de
// parsear el JSON). En Vercel, si el body ya viene parseado, lo re-serializa.
export async function leerRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && Object.keys(req.body).length) return JSON.stringify(req.body);
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
