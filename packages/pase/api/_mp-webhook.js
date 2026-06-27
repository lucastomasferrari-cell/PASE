// Helper para verificar la firma del webhook de MercadoPago.
//
// SEGURIDAD (fix audit 26-jun CRIT-2):
//   Antes el webhook MP en tienda-mp.js no validaba firma — comentario "TODO
//   completo: implementar verificación HMAC. Por ahora confiamos en que el
//   endpoint es público + validamos contra MP API antes de marcar." Eso dejaba
//   abierto: (a) que un atacante mande webhooks falsos para gastar rate limit
//   de MP, (b) en el caso peor, simular cobros si conseguía un paymentId real.
//
// MP firma así (https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks#editor_8):
//   - Header x-signature: "ts=<ts>,v1=<hex>"
//   - Header x-request-id: <uuid>
//   - Query param data.id: <paymentId>
//   - Template del manifest:
//       id:<data.id>;request-id:<x-request-id>;ts:<ts>;
//   - Secret se configura en MP Dashboard → Notificaciones → Webhooks.
//
// El secret se busca en env var MP_WEBHOOK_SECRET (global del SaaS por ahora).
// Si se necesita multi-tenant por cuenta MP separada, agregar columna
// webhook_secret a mp_credenciales y pasar el credId hint como argumento.

import { createHmac, timingSafeEqual } from 'crypto';

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60; // ±5 min anti-replay

/**
 * Verifica la firma del webhook MP.
 * @param {object} headers - req.headers (debe traer x-signature y x-request-id).
 * @param {string|number} dataId - paymentId del query param data.id.
 * @param {string} secret - MP webhook signing secret.
 * @returns {{ ok: boolean, error?: string, timestamp?: number }}
 */
export function verifyMpSignature(headers, dataId, secret) {
  if (!secret || typeof secret !== 'string') {
    return { ok: false, error: 'missing_secret' };
  }
  const signature = headers?.['x-signature'];
  const requestId = headers?.['x-request-id'];
  if (!signature || typeof signature !== 'string') {
    return { ok: false, error: 'missing_x_signature' };
  }
  if (!requestId || typeof requestId !== 'string') {
    return { ok: false, error: 'missing_x_request_id' };
  }
  if (dataId === null || dataId === undefined || dataId === '') {
    return { ok: false, error: 'missing_data_id' };
  }

  // Parsear "ts=...,v1=..."
  const parts = signature.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (!k || !v) return acc;
    if (k.trim() === 'ts') acc.ts = v.trim();
    else if (k.trim() === 'v1') acc.v1 = v.trim();
    return acc;
  }, { ts: null, v1: null });

  if (!parts.ts || !parts.v1) {
    return { ok: false, error: 'invalid_signature_format' };
  }

  const timestamp = parseInt(parts.ts, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, error: 'invalid_timestamp' };
  }

  // Anti-replay: rechazar timestamp viejo. MP usa milisegundos en algunos
  // ejemplos y segundos en otros — toleramos ambos heurísticamente.
  const tsSec = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsSec) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, error: 'timestamp_out_of_tolerance' };
  }

  // Manifest según MP docs:
  //   id:<dataId>;request-id:<x-request-id>;ts:<ts>;
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(parts.v1, 'hex');
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, error: 'signature_mismatch' };
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, error: 'signature_mismatch' };
  }
  return { ok: true, timestamp: tsSec };
}

/** Resuelve el webhook secret a usar para validar la firma. */
export function getMpWebhookSecret() {
  return process.env.MP_WEBHOOK_SECRET || null;
}
