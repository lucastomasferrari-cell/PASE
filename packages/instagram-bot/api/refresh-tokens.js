// Endpoint para refrescar tokens long-lived de Instagram.
//
// Los tokens IGAA viven 60 días. Antes de que venzan, hay que llamar al
// endpoint de refresh de Instagram para extenderlos otros 60 días.
//
// Este endpoint:
//   1. Busca todos los ig_config con token_expira_at en los próximos 14 días
//   2. Para cada uno, llama a /refresh_access_token de Instagram
//   3. Actualiza ig_config con el nuevo token + nueva fecha de expiración
//
// Trigger:
//   - Cron job (GitHub Actions semanal) que pega a este endpoint
//   - También se puede llamar manualmente
//
// Autenticación: header X-Refresh-Secret con el valor de REFRESH_SECRET env var
// (un string random que solo conoce el cron). Sin eso, 401.

// AUDIT F7A#4: usar helper centralizado _lib/db.js.
import { db } from './_lib/db.js';

const REFRESH_SECRET = process.env.REFRESH_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  // AUDIT F2D #7 (refactor): fail-closed si REFRESH_SECRET falta en producción.
  // Antes: si se olvidaba la env var, el endpoint quedaba abierto.
  if (process.env.VERCEL && !REFRESH_SECRET) {
    return res.status(500).json({ ok: false, error: 'REFRESH_SECRET_NOT_CONFIGURED' });
  }
  if (REFRESH_SECRET) {
    const secret = req.headers['x-refresh-secret'];
    if (secret !== REFRESH_SECRET) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
  }

  // Buscar configs cuyo token vence en <=14 días o ya venció (rescate).
  // AUDIT F2D #27: NO seleccionamos page_access_token; lo leemos via RPC encrypted.
  const cutoff = new Date(Date.now() + 14 * 86400_000).toISOString();
  const { data: configs, error } = await db.from('ig_config')
    .select('tenant_id, ig_account_id, ig_username, token_expira_at, bot_activo')
    .eq('bot_activo', true)
    .is('desconectado_at', null)
    .lte('token_expira_at', cutoff);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  const resultados = [];
  for (const cfg of configs || []) {
    try {
      // AUDIT F2D #27: obtener token vía RPC encrypted.
      const { data: tokenActual, error: tokErr } = await db.rpc('get_ig_token', { p_tenant_id: cfg.tenant_id });
      if (tokErr || !tokenActual) {
        resultados.push({ tenant_id: cfg.tenant_id, ig_username: cfg.ig_username, ok: false, error: 'NO_PUDIMOS_LEER_TOKEN' });
        continue;
      }

      // Fix 30-may: Meta cambió API — refresh_access_token ahora REQUIERE POST.
      // El cron de los domingos probablemente venía fallando silenciosamente
      // desde el cambio. Verificar último refresh exitoso en ig_eventos.
      const refreshResp = await fetch('https://graph.instagram.com/refresh_access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'ig_refresh_token',
          access_token: tokenActual,
        }).toString(),
      });
      const refreshData = await refreshResp.json();

      if (!refreshResp.ok || !refreshData.access_token) {
        const motivo = refreshData?.error?.message || `HTTP ${refreshResp.status}`;
        await db.from('ig_config')
          .update({ desconectado_at: new Date().toISOString(), bot_activo: false })
          .eq('ig_account_id', cfg.ig_account_id);

        await db.from('ig_eventos').insert({
          tenant_id: cfg.tenant_id,
          tipo: 'token_refresh_failed',
          error_message: motivo,
          payload: { ig_username: cfg.ig_username, account_id: cfg.ig_account_id },
        });

        resultados.push({
          tenant_id: cfg.tenant_id,
          ig_username: cfg.ig_username,
          ok: false,
          error: motivo,
        });
        continue;
      }

      const nuevoToken = refreshData.access_token;
      const expiresIn = refreshData.expires_in || 5184000; // 60 días
      const nuevaExpiracion = new Date(Date.now() + expiresIn * 1000).toISOString();

      // AUDIT F2D #27: escribir token nuevo vía RPC encrypted.
      const { error: setErr } = await db.rpc('set_ig_token', {
        p_tenant_id: cfg.tenant_id,
        p_token: nuevoToken,
        p_token_creado_at: new Date().toISOString(),
        p_token_expira_at: nuevaExpiracion,
      });
      if (setErr) {
        resultados.push({ tenant_id: cfg.tenant_id, ig_username: cfg.ig_username, ok: false, error: 'SET_TOKEN_FAILED: ' + setErr.message });
        continue;
      }

      await db.from('ig_eventos').insert({
        tenant_id: cfg.tenant_id,
        tipo: 'token_refreshed',
        payload: { ig_username: cfg.ig_username, expires_at: nuevaExpiracion },
      });

      resultados.push({
        tenant_id: cfg.tenant_id,
        ig_username: cfg.ig_username,
        ok: true,
        new_expires_at: nuevaExpiracion,
      });
    } catch (e) {
      resultados.push({
        tenant_id: cfg.tenant_id,
        ig_username: cfg.ig_username,
        ok: false,
        error: String(e?.message || e),
      });
    }
  }

  // Limpiar oauth_states expirados (housekeeping)
  await db.rpc('fn_cleanup_oauth_states');

  return res.status(200).json({
    ok: true,
    processed: resultados.length,
    resultados,
  });
}
