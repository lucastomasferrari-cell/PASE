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

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REFRESH_SECRET = process.env.REFRESH_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE config');
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  // Auth básico: header X-Refresh-Secret debe coincidir con env
  if (REFRESH_SECRET) {
    const secret = req.headers['x-refresh-secret'];
    if (secret !== REFRESH_SECRET) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
  }

  // Buscar configs cuyo token vence en <=14 días o ya venció (rescate)
  const cutoff = new Date(Date.now() + 14 * 86400_000).toISOString();
  const { data: configs, error } = await db.from('ig_config')
    .select('tenant_id, ig_account_id, ig_username, page_access_token, token_expira_at, bot_activo')
    .eq('bot_activo', true)
    .is('desconectado_at', null)
    .lte('token_expira_at', cutoff);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  const resultados = [];
  for (const cfg of configs || []) {
    try {
      // Endpoint de refresh de Instagram Login API
      const refreshResp = await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(cfg.page_access_token)}`,
      );
      const refreshData = await refreshResp.json();

      if (!refreshResp.ok || !refreshData.access_token) {
        // Si el token ya venció hace mucho, Meta puede rechazar el refresh.
        // En ese caso, marcamos la config como desconectada y avisamos al dueño.
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

      await db.from('ig_config')
        .update({
          page_access_token: nuevoToken,
          token_creado_at: new Date().toISOString(),
          token_expira_at: nuevaExpiracion,
        })
        .eq('ig_account_id', cfg.ig_account_id);

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
