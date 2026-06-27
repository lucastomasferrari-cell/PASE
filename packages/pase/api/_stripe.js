// Helper para webhook de Stripe — verificación de firma + procesamiento de
// eventos de suscripción. Lo usa /api/stripe-webhook.js.
//
// SEGURIDAD (fix audit 26-jun CRIT-1):
//   El handler anterior estaba dentro de auth-admin.js como action=stripe-webhook.
//   Eso requería JWT del caller (Stripe nunca puede llegar) y permitía que
//   cualquier dueño/admin autenticado modificara tenant_subscriptions ajeno
//   pasando metadata.tenant_id arbitrario. Este endpoint dedicado:
//     1. Bypasea JWT (Stripe no manda).
//     2. Valida HMAC SHA-256 del header Stripe-Signature contra webhook_secret.
//     3. Toleranza de timestamp ±5 min para evitar replay.
//     4. Si firma inválida → 401 sin tocar nada.
//
// El webhook_secret se busca en este orden:
//   1. env var STRIPE_WEBHOOK_SECRET (global del SaaS).
//   2. integraciones.config.webhook_secret del tenant del metadata
//      (multi-tenant futuro, donde cada tenant tendría su propia cuenta Stripe
//      Connect con su propio webhook).
//
// Eventos manejados:
//   - checkout.session.completed   → activa suscripción
//   - customer.subscription.updated → actualiza periodo/plan
//   - customer.subscription.deleted → cancela
//   - invoice.payment_failed       → marca past_due
//   - invoice.paid                 → renueva periodo

import { createHmac, timingSafeEqual } from 'crypto';

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60; // ±5 min

/**
 * Verifica la firma de un webhook Stripe.
 * Formato del header: "t=<timestamp>,v1=<sig>[,v1=<sig2>]"
 * @param {string} rawBody     Cuerpo crudo del request (Buffer o string).
 * @param {string} signature   Valor del header Stripe-Signature.
 * @param {string} secret      Webhook signing secret (whsec_...).
 * @returns {{ ok: boolean, error?: string, timestamp?: number }}
 */
export function verifyStripeSignature(rawBody, signature, secret) {
  if (!signature || typeof signature !== 'string') {
    return { ok: false, error: 'missing_signature' };
  }
  if (!secret || typeof secret !== 'string') {
    return { ok: false, error: 'missing_secret' };
  }

  // Parsear "t=...,v1=..."
  const parts = signature.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (!k || !v) return acc;
    if (k === 't') acc.t = v;
    else if (k === 'v1') (acc.v1 = acc.v1 || []).push(v);
    return acc;
  }, { t: null, v1: null });

  if (!parts.t || !parts.v1 || parts.v1.length === 0) {
    return { ok: false, error: 'invalid_signature_format' };
  }

  const timestamp = parseInt(parts.t, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, error: 'invalid_timestamp' };
  }

  // Anti-replay: rechazar si el timestamp difiere demasiado del actual.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, error: 'timestamp_out_of_tolerance' };
  }

  // Stripe firma: `${timestamp}.${rawBody}`
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedPayload = `${parts.t}.${bodyStr}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Comparar timing-safe contra cada v1 (puede venir más de una en rotación).
  const expectedBuf = Buffer.from(expected, 'hex');
  let matched = false;
  for (const v of parts.v1) {
    const provided = Buffer.from(v, 'hex');
    if (provided.length !== expectedBuf.length) continue;
    if (timingSafeEqual(provided, expectedBuf)) { matched = true; break; }
  }

  if (!matched) return { ok: false, error: 'signature_mismatch' };
  return { ok: true, timestamp };
}

/**
 * Procesa un evento Stripe ya verificado. Updatea tenant_subscriptions según
 * el tipo. Cada update filtra por stripe_subscription_id o stripe_customer_id
 * (no por metadata.tenant_id sin verificar — eso era el bug de cross-tenant).
 *
 * @param {object} db          Cliente Supabase con service_role.
 * @param {object} event       Evento Stripe (ya parseado de JSON, firma verificada).
 * @returns {Promise<{ ok: boolean, action?: string, error?: string }>}
 */
export async function processStripeEvent(db, event) {
  if (!event || !event.type) return { ok: false, error: 'invalid_event' };

  const obj = event.data?.object;
  if (!obj) return { ok: false, error: 'missing_event_object' };

  // Idempotency: si ya procesamos este event.id, salir 200. Stripe reintenta
  // por hasta 3 días, por lo que ver el mismo id varias veces es normal.
  // Usamos la tabla idempotency_keys (existente) con rpc_name='stripe-webhook'.
  if (event.id) {
    try {
      const { error: idemErr } = await db.from('idempotency_keys').insert({
        rpc_name: 'stripe-webhook',
        key: event.id,
      });
      if (idemErr && idemErr.code === '23505') {
        // duplicate key — ya procesado. OK silencioso.
        return { ok: true, action: 'already_processed', event_id: event.id };
      }
      // otro tipo de error de inserción: log y seguir. No queremos bloquear
      // el evento por un fallo de idempotency tracking (Stripe igualmente
      // reintenta si devolvemos 5xx).
      if (idemErr) console.warn('[stripe-webhook] idempotency insert warn:', idemErr.message);
    } catch (e) {
      console.warn('[stripe-webhook] idempotency exception:', e?.message);
    }
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const tenantId = obj.metadata?.tenant_id;
      const planId = obj.metadata?.plan_id;
      const subscriptionId = obj.subscription;
      if (!tenantId) return { ok: false, error: 'metadata.tenant_id_missing' };

      // UPSERT (NO update simple): cubre el caso "primer checkout sin row previo".
      const { error } = await db.from('tenant_subscriptions').upsert({
        tenant_id: tenantId,
        estado: 'active',
        stripe_subscription_id: subscriptionId,
        stripe_customer_id: obj.customer,
        gateway_provider: 'stripe',
        plan_id: planId || undefined,
        current_period_start: new Date().toISOString(),
      }, { onConflict: 'tenant_id' });
      if (error) return { ok: false, error: 'upsert_failed: ' + error.message };
      return { ok: true, action: 'subscription_activated', tenant_id: tenantId };
    }

    if (event.type === 'customer.subscription.updated') {
      // Matchea por stripe_subscription_id O stripe_customer_id (defensa
      // contra orden de eventos: si .updated llega antes que .completed, el
      // subscription_id quizá aún no esté seteado en DB pero customer_id sí).
      const subId = obj.id;
      const customerId = obj.customer;
      const periodStart = obj.current_period_start
        ? new Date(obj.current_period_start * 1000).toISOString() : null;
      const periodEnd = obj.current_period_end
        ? new Date(obj.current_period_end * 1000).toISOString() : null;
      const update = {
        stripe_subscription_id: subId,
        estado: obj.status === 'active' ? 'active'
              : obj.status === 'past_due' ? 'past_due'
              : obj.status === 'canceled' ? 'cancelled'
              : obj.status,
        ...(periodStart ? { current_period_start: periodStart } : {}),
        ...(periodEnd ? { current_period_end: periodEnd } : {}),
      };
      // Intentar update por subscription_id primero
      const { data: bySub, error: e1 } = await db.from('tenant_subscriptions')
        .update(update).eq('stripe_subscription_id', subId).select('id');
      if (e1) return { ok: false, error: 'update_failed: ' + e1.message };
      if (Array.isArray(bySub) && bySub.length > 0) {
        return { ok: true, action: 'subscription_updated_by_sub_id', rows: bySub.length };
      }
      // Fallback: matchear por customer_id si no había row con ese sub_id
      if (customerId) {
        const { error: e2 } = await db.from('tenant_subscriptions')
          .update(update).eq('stripe_customer_id', customerId).is('stripe_subscription_id', null);
        if (e2) return { ok: false, error: 'fallback_update_failed: ' + e2.message };
        return { ok: true, action: 'subscription_updated_by_customer_id' };
      }
      return { ok: true, action: 'no_matching_row' };
    }

    if (event.type === 'customer.subscription.deleted') {
      const subId = obj.id;
      const customerId = obj.customer;
      const update = { estado: 'cancelled', cancelled_at: new Date().toISOString() };
      const { data: bySub, error: e1 } = await db.from('tenant_subscriptions')
        .update(update).eq('stripe_subscription_id', subId).select('id');
      if (e1) return { ok: false, error: 'update_failed: ' + e1.message };
      if (Array.isArray(bySub) && bySub.length > 0) {
        return { ok: true, action: 'subscription_cancelled_by_sub_id', rows: bySub.length };
      }
      if (customerId) {
        const { error: e2 } = await db.from('tenant_subscriptions')
          .update(update).eq('stripe_customer_id', customerId);
        if (e2) return { ok: false, error: 'fallback_update_failed: ' + e2.message };
        return { ok: true, action: 'subscription_cancelled_by_customer_id' };
      }
      return { ok: true, action: 'no_matching_row' };
    }

    if (event.type === 'invoice.payment_failed') {
      const subId = obj.subscription;
      const customerId = obj.customer;
      const update = { estado: 'past_due' };
      const { data: bySub, error: e1 } = await db.from('tenant_subscriptions')
        .update(update).eq('stripe_subscription_id', subId).select('id');
      if (e1) return { ok: false, error: 'update_failed: ' + e1.message };
      if (Array.isArray(bySub) && bySub.length > 0) {
        return { ok: true, action: 'marked_past_due', rows: bySub.length };
      }
      if (customerId) {
        const { error: e2 } = await db.from('tenant_subscriptions')
          .update(update).eq('stripe_customer_id', customerId);
        if (e2) return { ok: false, error: 'fallback_update_failed: ' + e2.message };
        return { ok: true, action: 'marked_past_due_by_customer_id' };
      }
      return { ok: true, action: 'no_matching_row' };
    }

    if (event.type === 'invoice.paid') {
      const subId = obj.subscription;
      const update = {
        estado: 'active',
        current_period_start: new Date().toISOString(),
      };
      const { error } = await db.from('tenant_subscriptions')
        .update(update).eq('stripe_subscription_id', subId);
      if (error) return { ok: false, error: 'update_failed: ' + error.message };
      return { ok: true, action: 'period_renewed' };
    }

    // Evento que no manejamos — log y devolver ok (Stripe no necesita reintento).
    return { ok: true, action: 'ignored', event_type: event.type };
  } catch (e) {
    console.error('[stripe-webhook] processStripeEvent exception:', e?.message);
    return { ok: false, error: 'exception: ' + (e?.message || String(e)) };
  }
}

/**
 * Resuelve el webhook_secret a usar para validar la firma.
 * Por ahora: env var STRIPE_WEBHOOK_SECRET (global). Si el día de mañana
 * cada tenant tiene su propia cuenta Stripe, parsear primero el body para
 * extraer metadata.tenant_id y buscar el secret específico de ese tenant.
 */
export function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}
