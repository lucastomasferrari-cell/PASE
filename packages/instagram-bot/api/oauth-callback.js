// Endpoint OAuth callback de Instagram.
//
// Flow:
//   GET /api/oauth-callback?code=XXX&state=YYY
//   1. Validar state en ig_oauth_states (existe + no consumido + no expirado)
//   2. Marcar state como consumido
//   3. Intercambiar code por short-lived token via api.instagram.com/oauth/access_token
//   4. Intercambiar short-lived por long-lived token (60 días) via graph.instagram.com
//   5. GET /me para obtener IG account ID + username
//   6. INSERT/UPDATE ig_config con el token + datos
//   7. Subscribir la cuenta al webhook (subscribed_apps)
//   8. Redirigir al user a PASE con el resultado
//
// Env vars necesarias:
//   IG_APP_ID         - Identificador de la app de Instagram (público, ej 28110839805172593)
//   IG_APP_SECRET     - Clave secreta de la app de Instagram
//   OAUTH_REDIRECT_URI - URL completa de este endpoint (ej https://pase-instagram-bot.vercel.app/api/oauth-callback)
//   PASE_BASE_URL     - URL de PASE para redirect post-conexión (ej https://pase-yndx.vercel.app)

// AUDIT F7A#4: usar helper centralizado _lib/db.js en vez de createClient inline.
import { db } from './_lib/db.js';

const IG_APP_ID = process.env.IG_APP_ID;
// IG_APP_SECRET = "Clave secreta de la app de Instagram" de Meta.
// En esta app es el MISMO valor que META_APP_SECRET (un solo secret para
// toda la app de Meta). Priorizo META_APP_SECRET porque sé que está bien
// configurado (lo usamos en validación de webhook). IG_APP_SECRET queda
// como fallback opcional.
const IG_APP_SECRET = process.env.META_APP_SECRET || process.env.IG_APP_SECRET;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'https://pase-instagram-bot.vercel.app/api/oauth-callback';
const PASE_BASE_URL = process.env.PASE_BASE_URL || 'https://pase-yndx.vercel.app';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const { code, state, error: oauthError, error_reason, error_description } = req.query;

  // Caso 1: el user canceló o hubo error en el OAuth de Meta
  if (oauthError) {
    return redirectToPase(res, {
      ok: false,
      error: error_reason || oauthError,
      detail: error_description,
    });
  }

  if (!code || !state) {
    return redirectToPase(res, { ok: false, error: 'MISSING_PARAMS' });
  }

  // ─── 1. Validar state ──────────────────────────────────────────────────
  const { data: stateRow } = await db.from('ig_oauth_states')
    .select('*')
    .eq('state', state)
    .single();

  if (!stateRow) {
    return redirectToPase(res, { ok: false, error: 'STATE_NOT_FOUND' });
  }
  if (stateRow.consumed) {
    return redirectToPase(res, { ok: false, error: 'STATE_ALREADY_USED' });
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    return redirectToPase(res, { ok: false, error: 'STATE_EXPIRED' });
  }

  // Marcar consumido al toque para evitar replay
  await db.from('ig_oauth_states')
    .update({ consumed: true, consumed_at: new Date().toISOString() })
    .eq('state', state);

  try {
    // ─── 2. Intercambiar code por short-lived token ────────────────────────
    // Loguear qué redirect_uri estamos enviando (debug del mismatch común)
    await logEvent('oauth_debug', stateRow.tenant_id, null, null, {
      stage: 'short_token_exchange',
      redirect_uri_enviado: OAUTH_REDIRECT_URI,
      client_id: IG_APP_ID,
    });

    // URLSearchParams.toString() codifica todos los valores con encodeURIComponent.
    // El frontend usa el mismo método en la URL de autorización, así que
    // ambos lados producen el mismo string codificado del redirect_uri.
    const requestBody = new URLSearchParams({
      client_id: IG_APP_ID,
      client_secret: IG_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: OAUTH_REDIRECT_URI,
      code: String(code),
    }).toString();

    // Loguear el body completo enmascarando el secret + code (para debug)
    const bodyDebug = requestBody
      .replace(IG_APP_SECRET, '***SECRET***')
      .replace(encodeURIComponent(IG_APP_SECRET), '***SECRET***')
      .replace(String(code), '***CODE***')
      .replace(encodeURIComponent(String(code)), '***CODE***');
    await logEvent('oauth_debug', stateRow.tenant_id, null, null, {
      stage: 'request_body_to_meta',
      body_masked: bodyDebug,
    });

    const shortTokenResp = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: requestBody,
    });
    const shortData = await shortTokenResp.json();
    if (!shortTokenResp.ok || !shortData.access_token) {
      await logEvent('error', stateRow.tenant_id, null, `exchange_short_token failed: ${JSON.stringify(shortData)} | redirect_uri usado: ${OAUTH_REDIRECT_URI}`);
      return redirectToPase(res, { ok: false, error: 'SHORT_TOKEN_FAILED', detail: shortData?.error_message || shortData?.error?.message || 'unknown' });
    }
    const shortToken = shortData.access_token;
    const userId = shortData.user_id; // Instagram-scoped User ID

    // ─── 3. Intercambiar short-lived por long-lived (60 días) ─────────────
    const longTokenResp = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(IG_APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`);
    const longData = await longTokenResp.json();
    if (!longTokenResp.ok || !longData.access_token) {
      await logEvent('error', stateRow.tenant_id, null, `exchange_long_token failed: ${JSON.stringify(longData)}`);
      return redirectToPase(res, { ok: false, error: 'LONG_TOKEN_FAILED', detail: longData?.error_message || 'unknown' });
    }
    const longToken = longData.access_token;
    const expiresIn = longData.expires_in || 5184000; // 60 días en segundos
    const tokenExpiraAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // ─── 4. Obtener info de la cuenta IG ──────────────────────────────────
    const meResp = await fetch(`https://graph.instagram.com/v21.0/me?fields=id,username,account_type&access_token=${encodeURIComponent(longToken)}`);
    const meData = await meResp.json();
    if (!meResp.ok || !meData.id) {
      await logEvent('error', stateRow.tenant_id, null, `me failed: ${JSON.stringify(meData)}`);
      return redirectToPase(res, { ok: false, error: 'ME_FAILED' });
    }

    // ─── 5. ig_account_id: distinguir page-scoped vs IGSID ────────────────
    // OJO: meData.id devuelve el "IGSID del owner" (Instagram-scoped User ID).
    // Pero los webhooks de Meta llegan con el "Page-scoped Instagram Business
    // Account ID" (otro número diferente). Si sobrescribimos el page-scoped
    // con el IGSID, el webhook no va a encontrar el ig_config y el bot deja
    // de responder.
    //
    // Estrategia:
    //   - Si ya existe ig_config para este tenant → respetar el ig_account_id
    //     guardado (suponemos que es el page-scoped correcto, viene del
    //     webhook o configuración manual previa).
    //   - Si NO existe → usar meData.id como fallback. Para apps nuevas que
    //     no tienen webhook configurado todavía, esto se reemplazará por el
    //     page-scoped cuando llegue el primer webhook.
    const ig_account_id_fallback = String(meData.id);

    // ─── 6. Insert/Update ig_config (multi-cuenta 29-may) ──────────────
    // Antes: si el ig_account_id del NUEVO token NO coincidía con el guardado,
    // abortaba con MULTI_ACCOUNT_NO_SOPORTADO. Refactor 29-may permite N
    // cuentas IG por tenant — la RPC set_ig_token ahora usa UNIQUE
    // (tenant_id, ig_account_id), por lo que conectar cuenta NUEVA crea
    // fila nueva en lugar de pisar la existente. Re-conectar la MISMA
    // cuenta (mismo ig_account_id) refresca el token de esa fila.
    //
    // local_id viene del state.local_id si el frontend lo pasó al iniciar
    // OAuth (significa "asociar esta cuenta IG al local X"); sino NULL =
    // cuenta global del tenant (compat con flujo viejo).
    const targetLocalId = stateRow.local_id || null;

    // AUDIT F2D #27: token va encrypted vía RPC set_ig_token (vault + pgcrypto).
    const { data: configId, error: setTokErr } = await db.rpc('set_ig_token', {
      p_tenant_id: stateRow.tenant_id,
      p_token: longToken,
      p_ig_account_id: ig_account_id_fallback,
      p_ig_username: meData.username,
      p_token_creado_at: new Date().toISOString(),
      p_token_expira_at: tokenExpiraAt,
      p_local_id: targetLocalId,
    });
    if (setTokErr) {
      console.error('[oauth-callback] set_ig_token failed:', setTokErr.message);
      return res.status(500).json({ error: 'no_pudimos_guardar_token', detail: setTokErr.message });
    }

    const finalAccountId = ig_account_id_fallback;

    // Actualizar campos que set_ig_token no toca, sobre la fila específica
    // (tenant_id, ig_account_id) en lugar de "todas las del tenant".
    const { error: upsertErr } = await db.from('ig_config')
      .update({ bot_activo: true, connected_by: stateRow.usuario_id })
      .eq('tenant_id', stateRow.tenant_id)
      .eq('ig_account_id', finalAccountId);

    if (upsertErr) {
      await logEvent('error', stateRow.tenant_id, null, `upsert ig_config failed: ${upsertErr.message}`);
      return redirectToPase(res, { ok: false, error: 'CONFIG_UPSERT_FAILED' });
    }

    // Variable que usamos abajo para el subscribed_apps endpoint
    const ig_account_id = finalAccountId;

    // ─── 7. Subscribir la cuenta al webhook ───────────────────────────────
    // Sin esto, los DMs llegan a Meta pero NO al endpoint del bot.
    const subResp = await fetch(`https://graph.instagram.com/v21.0/${ig_account_id}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `subscribed_fields=messages&access_token=${encodeURIComponent(longToken)}`,
    });
    const subData = await subResp.json();
    if (!subResp.ok || !subData.success) {
      // No es crítico — el bot va a funcionar pero los DMs no llegan
      // hasta que se subscriba. Logueamos warning.
      await logEvent('error', stateRow.tenant_id, null, `subscribe webhook warning: ${JSON.stringify(subData)}`);
    }

    // ─── 8. Loguear éxito ────────────────────────────────────────────────
    await logEvent('oauth_conectado', stateRow.tenant_id, null, null, {
      ig_username: meData.username,
      ig_account_id,
      account_type: meData.account_type,
    });

    return redirectToPase(res, {
      ok: true,
      username: meData.username,
      account_id: ig_account_id,
      expires_in_days: Math.floor(expiresIn / 86400),
    });
  } catch (e) {
    await logEvent('error', stateRow.tenant_id, null, `callback exception: ${String(e?.message || e)}`);
    return redirectToPase(res, { ok: false, error: 'EXCEPTION', detail: String(e?.message || e) });
  }
}

function redirectToPase(res, result) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(result)) {
    if (v !== null && v !== undefined) params.set(k, String(v));
  }
  const returnUrl = `${PASE_BASE_URL}/mensajeria?ig_oauth=${result.ok ? 'success' : 'error'}&${params.toString()}`;
  res.writeHead(302, { Location: returnUrl });
  res.end();
}

async function logEvent(tipo, tenant_id, conversacion_id, error_message, payload = null) {
  try {
    await db.from('ig_eventos').insert({
      tenant_id,
      conversacion_id,
      tipo,
      error_message,
      payload,
    });
  } catch {
    // ignore
  }
}
