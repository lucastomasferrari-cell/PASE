// /api/stripe-webhook — endpoint dedicado para webhooks de Stripe.
//
// SEGURIDAD (fix audit 26-jun CRIT-1):
//   Antes este flujo estaba dentro de auth-admin.js como action=stripe-webhook,
//   requiriendo JWT del caller. Como Stripe nunca manda JWT, ese endpoint
//   estaba roto Y permitía que cualquier dueño/admin autenticado modificara
//   tenant_subscriptions ajeno pasando metadata.tenant_id arbitrario.
//   Este endpoint:
//     1. NO requiere JWT (Stripe no manda).
//     2. Valida HMAC SHA-256 del header Stripe-Signature.
//     3. Procesa eventos contra tenant_subscriptions matcheando por
//        stripe_subscription_id o stripe_customer_id (NO por metadata.tenant_id
//        sin verificar — ese era el bug).
//     4. Idempotency por event.id (Stripe reintenta hasta 3 días).
//
// Setup en Stripe Dashboard:
//   1. Developers → Webhooks → Add endpoint
//   2. URL: https://pase-yndx.vercel.app/api/stripe-webhook
//   3. Events: checkout.session.completed, customer.subscription.updated,
//      customer.subscription.deleted, invoice.payment_failed, invoice.paid
//   4. Copiar el "Signing secret" (whsec_...) y pegarlo en env var
//      STRIPE_WEBHOOK_SECRET del proyecto Vercel.

// IMPORTANTE: Stripe firma el RAW body. Vercel parsea JSON por default →
// hay que deshabilitarlo y leer el stream manualmente.
export const config = {
  api: { bodyParser: false },
};

import { createClient } from '@supabase/supabase-js';
import { verifyStripeSignature, processStripeEvent, getStripeWebhookSecret } from './_stripe.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'MISSING_ENV' });
  }

  const secret = getStripeWebhookSecret();
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET no configurado');
    return res.status(503).json({ error: 'WEBHOOK_SECRET_NOT_CONFIGURED' });
  }

  // 1. Leer raw body (necesario para HMAC)
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    console.error('[stripe-webhook] read body falló:', e?.message);
    return res.status(400).json({ error: 'BAD_BODY' });
  }

  // 2. Validar firma Stripe-Signature
  const signature = req.headers['stripe-signature'];
  const verify = verifyStripeSignature(rawBody, signature, secret);
  if (!verify.ok) {
    console.warn('[stripe-webhook] firma inválida:', verify.error);
    return res.status(401).json({ error: 'INVALID_SIGNATURE', detail: verify.error });
  }

  // 3. Parsear el evento (ya verificado)
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'BAD_JSON', detail: e?.message });
  }

  // 4. Procesar
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = await processStripeEvent(db, event);

  if (!result.ok) {
    // Devolver 500 para que Stripe reintente. Si era un error de validación
    // del payload (tenant_id ausente, etc), eso NO se va a arreglar con retry,
    // pero igual loggeamos y devolvemos 200 para no acumular reintentos
    // perdidos. Distinguimos por código de error.
    const transient = ['upsert_failed', 'update_failed', 'fallback_update_failed', 'exception']
      .some((tag) => (result.error || '').startsWith(tag));
    if (transient) {
      console.error('[stripe-webhook] error transient — pedir retry a Stripe:', result.error);
      return res.status(500).json({ ok: false, error: result.error });
    }
    console.error('[stripe-webhook] error no-transient (ack 200):', result.error);
    return res.status(200).json({ ok: false, error: result.error, event_id: event.id });
  }

  return res.status(200).json({
    ok: true,
    action: result.action,
    event_id: event.id,
    event_type: event.type,
  });
}
