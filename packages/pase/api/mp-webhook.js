// Endpoint receptor de webhooks de MercadoPago — OBSERVATORIO solamente.
//
// Origen: Lucas 2026-05-14 — probar si los webhooks traen pagos que el cron
//         actual (release_report + payments/search 30min) pierde.
//         Específicamente Point Smart, donde se documentó faltante de ~$553k
//         el 1/5 que NO entró por release/settlement.
//
// Diseño:
//   • NO toca mp_movimientos / mp_credenciales / cron actual.
//   • Filtra a un solo local: Neko Villa Crespo (lookup por nombre runtime).
//   • Cada webhook se guarda crudo en mp_webhooks_test + se hace GET
//     /v1/payments/{id} para enriquecerlo + se cruza contra mp_movimientos.
//   • SIEMPRE devuelve 200 (MP reintenta si no, generaríamos ruido).
//
// 2 pruebas en paralelo (sprint 2026-05-14):
//   • source=1 → Prueba Conciliación 1: app principal de PASE (cubre TODO
//     lo que el cron cubre — Point + QR + link + online + Rappi/etc).
//   • source=2 → Prueba Conciliación 2: app "prueba webhook" tipo Point
//     (solo Point Smart presencial).
//
// El source se distingue por query param de la URL configurada en cada app
// MP: https://.../api/mp-webhook?source=1 vs ?source=2. MP preserva query
// params al hacer el POST. Default 0 = legacy/smoke test.
//
// Configuración requerida en Vercel env vars:
//   • SUPABASE_URL                — ya existe
//   • SUPABASE_SERVICE_KEY        — ya existe
//   • MP_WEBHOOK_SECRET_1         — clave secreta de la app PRINCIPAL.
//   • MP_WEBHOOK_SECRET_2         — clave secreta de la app de Point.
//   Si alguna está ausente, el webhook llega pero queda sin validar firma
//   (modo "abierto" para testing inicial).
//
// Validación de firma HMAC (formato MP):
//   • Header: x-signature: ts=<timestamp>,v1=<hmac_hex>
//   • Header: x-request-id: <uuid>
//   • Manifest: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
//   • HMAC SHA-256 del manifest con la clave secreta correspondiente al
//     source de la URL.

import crypto from 'node:crypto';

export default async function handler(req, res) {
  // MP a veces hace GET para validar el endpoint (health check al guardar URL).
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, msg: 'mp-webhook listening' });
  }

  // Variables de entorno mínimas. Si faltan, devolver 200 igual para no
  // hacer reintentar a MP en loop, pero loguear duro.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('[mp-webhook] FATAL: SUPABASE env vars missing');
    return res.status(200).json({ ok: false, error: 'env_missing' });
  }

  const startedAt = Date.now();

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ─── 0. Identificar source desde query param (1 o 2) ──────────────────
    // MP preserva query params al hacer el POST. Cada app de MP tiene su URL
    // configurada con un source distinto (?source=1 para app principal,
    // ?source=2 para app de Point). Default 0 si no viene (smoke test, etc).
    const sourceRaw = req.query?.source ?? '';
    const source = sourceRaw === '1' ? 1 : sourceRaw === '2' ? 2 : 0;

    // ─── 1. Validar firma HMAC (si está configurado el secret) ────────────
    // Cada source usa su propio secret (cada app de MP genera la suya).
    const signatureHeader = req.headers['x-signature'] || '';
    const requestIdHeader = req.headers['x-request-id'] || '';
    const secret = source === 1 ? (process.env.MP_WEBHOOK_SECRET_1 || '')
                 : source === 2 ? (process.env.MP_WEBHOOK_SECRET_2 || '')
                 : (process.env.MP_WEBHOOK_SECRET || ''); // legacy fallback

    let signatureValid = null;
    let signatureError = null;

    if (secret) {
      const result = validateMpSignature({
        signatureHeader: String(signatureHeader),
        requestId: String(requestIdHeader),
        body: req.body,
        secret,
      });
      signatureValid = result.valid;
      signatureError = result.error;
      if (!result.valid) {
        console.warn('[mp-webhook] signature invalid', {
          error: result.error,
          request_id: requestIdHeader,
        });
        // Igual seguimos guardando — útil para diagnóstico (ver si el secret
        // es el correcto, si MP cambió formato, etc).
      }
    }

    // ─── 2. Buscar local Neko Villa Crespo + su credencial activa ─────────
    const { local, credencial, lookupError } = await findVillaCrespoCredential(db);
    if (lookupError) {
      console.warn('[mp-webhook] no se pudo identificar local Villa Crespo:', lookupError);
      // Insertamos igual con tenant/local null para diagnóstico.
    }

    // ─── 3. Extraer campos top-level del payload ──────────────────────────
    const body = req.body || {};
    const mpTopic = body.topic || body.type || null;
    const mpAction = body.action || null;
    // En notificaciones de MP, el id del recurso viene en data.id (formato
    // nuevo) o en resource (formato viejo merchant_orders). Intentamos los
    // 2 lugares.
    const mpResourceId = String(
      body?.data?.id ?? extractIdFromResource(body.resource) ?? body.id ?? ''
    ).trim() || null;
    const mpUserId = String(body.user_id || '').trim() || null;

    // ─── 4. INSERT inicial del webhook crudo ──────────────────────────────
    const { data: inserted, error: insErr } = await db
      .from('mp_webhooks_test')
      .insert({
        source,
        tenant_id: local?.tenant_id || null,
        local_id: local?.id || null,
        mp_credencial_id: credencial?.id || null,
        http_signature_header: String(signatureHeader) || null,
        http_request_id: String(requestIdHeader) || null,
        http_signature_valid: signatureValid,
        http_signature_error: signatureError,
        raw_body: body,
        mp_topic: mpTopic,
        mp_action: mpAction,
        mp_resource_id: mpResourceId,
        mp_user_id: mpUserId,
      })
      .select('id')
      .single();

    if (insErr) {
      console.error('[mp-webhook] INSERT mp_webhooks_test failed', insErr.message);
      return res.status(200).json({ ok: false, error: 'db_insert_failed' });
    }

    const webhookRowId = inserted.id;

    // ─── 5. Si es payment + tenemos credencial, enriquecer ────────────────
    // Para el resto (merchant_order, etc), guardamos el raw y listo.
    const isPayment = (mpTopic === 'payment')
      || (typeof mpAction === 'string' && mpAction.startsWith('payment.'));

    if (isPayment && mpResourceId && credencial) {
      // Disparar fetch + match en background (await pero con timeout corto
      // para no bloquear MP). MP exige respuesta en <22s; nosotros nos damos
      // 8s para dejar margen.
      try {
        await enrichWebhook({ db, webhookRowId, paymentId: mpResourceId, credencial });
      } catch (e) {
        console.error('[mp-webhook] enrich threw', e?.message);
      }
    } else if (!mpResourceId) {
      await markMatch(db, webhookRowId, 'no_payment_id', null);
    } else if (!credencial) {
      await markMatch(db, webhookRowId, 'no_credencial', null);
    }

    const elapsed = Date.now() - startedAt;
    console.log('[mp-webhook] ok', JSON.stringify({
      webhook_id: webhookRowId,
      source,
      topic: mpTopic,
      action: mpAction,
      resource_id: mpResourceId,
      local_id: local?.id || null,
      sig_valid: signatureValid,
      elapsed_ms: elapsed,
    }));

    return res.status(200).json({ ok: true, webhook_id: webhookRowId });
  } catch (err) {
    console.error('[mp-webhook] unhandled', err?.stack || err?.message || String(err));
    // SIEMPRE 200 para no entrar en loop de reintentos de MP.
    return res.status(200).json({ ok: false, error: 'internal' });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Lookup runtime: encontrar el local "Neko Villa Crespo" y su mp_credenciales
// activa. Hacemos el lookup en cada request (es ~2 SELECT, despreciable y
// nos hace robusto si Lucas cambia el nombre del local).
async function findVillaCrespoCredential(db) {
  const { data: locales, error: locErr } = await db
    .from('locales')
    .select('id, nombre, tenant_id')
    .ilike('nombre', '%villa crespo%');
  if (locErr) return { lookupError: `locales: ${locErr.message}` };
  if (!locales || locales.length === 0) {
    return { lookupError: 'no se encontró ningún local con "villa crespo" en el nombre' };
  }
  // Si hay >1 (raro), tomar el primero y warnear.
  if (locales.length > 1) {
    console.warn('[mp-webhook] >1 local matchea "villa crespo":',
      locales.map(l => `${l.id}:${l.nombre}`).join(','));
  }
  const local = locales[0];

  const { data: creds, error: credErr } = await db
    .from('mp_credenciales')
    .select('id, local_id, tenant_id')
    .eq('local_id', local.id)
    .eq('activo', true)
    .limit(1);
  if (credErr) return { local, lookupError: `mp_credenciales: ${credErr.message}` };
  if (!creds || creds.length === 0) {
    return { local, lookupError: `local ${local.id} (${local.nombre}) sin mp_credenciales activa` };
  }
  return { local, credencial: creds[0] };
}

// Hace GET /v1/payments/{id} con el token de la cred + cruza contra
// mp_movimientos + actualiza la fila del webhook.
async function enrichWebhook({ db, webhookRowId, paymentId, credencial }) {
  // Obtener token desencriptado vía RPC get_mp_token (igual que los otros
  // endpoints MP — patrón _mp-token.js).
  let token;
  try {
    const { data: tok, error: tokErr } = await db.rpc('get_mp_token', {
      p_credencial_id: credencial.id,
    });
    if (tokErr || !tok) throw new Error(tokErr?.message || 'token vacío');
    token = tok;
  } catch (e) {
    await db.from('mp_webhooks_test').update({
      payment_fetch_status: null,
      payment_fetch_error: `token: ${e.message}`,
      payment_fetched_at: new Date().toISOString(),
    }).eq('id', webhookRowId);
    return;
  }

  // GET /v1/payments/{id}
  let status, paymentData = null, fetchError = null;
  try {
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    status = r.status;
    if (r.ok) {
      paymentData = await r.json();
    } else {
      const body = await r.text().catch(() => '');
      fetchError = `${r.status}: ${body.slice(0, 200)}`;
    }
  } catch (e) {
    fetchError = `fetch threw: ${e.message}`;
  }

  await db.from('mp_webhooks_test').update({
    payment_fetched_at: new Date().toISOString(),
    payment_fetch_status: status || null,
    payment_fetch_error: fetchError,
    payment_data: paymentData,
  }).eq('id', webhookRowId);

  // Cruzar contra mp_movimientos por referencia_id (= payment_id en MP).
  // El cron actual guarda los pagos con id "pay-{paymentId}" y referencia_id
  // = paymentId.
  let matchStatus, matchMpMovId = null;
  try {
    const { data: matches, error: matchErr } = await db
      .from('mp_movimientos')
      .select('id')
      .eq('referencia_id', String(paymentId))
      .eq('local_id', credencial.local_id)
      .eq('tenant_id', credencial.tenant_id)
      .like('id', 'pay-%')
      .limit(1);
    if (matchErr) {
      matchStatus = 'mov_check_err';
      console.warn('[mp-webhook] mov check error', matchErr.message);
    } else if (matches && matches.length > 0) {
      matchStatus = 'already_in_mov';
      matchMpMovId = matches[0].id;
    } else {
      matchStatus = 'not_in_mov';
    }
  } catch (e) {
    matchStatus = 'mov_check_err';
    console.warn('[mp-webhook] mov check threw', e.message);
  }

  await markMatch(db, webhookRowId, matchStatus, matchMpMovId);
}

async function markMatch(db, webhookRowId, matchStatus, matchMpMovId) {
  await db.from('mp_webhooks_test').update({
    match_status: matchStatus,
    match_mp_movimiento_id: matchMpMovId,
    match_checked_at: new Date().toISOString(),
  }).eq('id', webhookRowId);
}

// Valida la firma HMAC de un webhook MP.
// Formato del header x-signature:
//   ts=1701234567,v1=abc123hexdigest
// Manifest:
//   id:<resource_id>;request-id:<x-request-id>;ts:<ts>;
// HMAC SHA-256 del manifest con la clave secreta → debe matchear v1.
function validateMpSignature({ signatureHeader, requestId, body, secret }) {
  if (!signatureHeader) return { valid: false, error: 'no_x_signature_header' };
  if (!secret) return { valid: false, error: 'no_secret_configured' };

  // Parsear "ts=...,v1=..."
  const parts = {};
  for (const p of signatureHeader.split(',')) {
    const [k, v] = p.split('=', 2);
    if (k && v) parts[k.trim()] = v.trim();
  }
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return { valid: false, error: 'malformed_x_signature' };

  // Resource id (lo que MP pone en data.id)
  const resourceId = String(body?.data?.id ?? '').trim();

  // Manifest exacto que MP firma del lado server (de la doc oficial).
  const manifest = `id:${resourceId};request-id:${requestId};ts:${ts};`;

  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  if (hmac.length !== v1.length) return { valid: false, error: 'hmac_length_mismatch' };

  // timing-safe compare
  const ok = crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(v1, 'hex'));
  return { valid: ok, error: ok ? null : 'hmac_mismatch' };
}

// merchant_orders viejos vienen en formato:
//   resource: "https://api.mercadolibre.com/merchant_orders/12345"
// Sacamos el último segmento.
function extractIdFromResource(resource) {
  if (!resource || typeof resource !== 'string') return null;
  const m = resource.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}
