// mp-generate: POST a MP para generar CSV nuevo. Responde en <5s.
import { createMpTokenGetter } from './_mp-token.js';
import { checkCronAuth } from './_cron-auth.js';

export default async function handler(req, res) {
  if (!checkCronAuth(req, res)) return;
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Getter de token MP con cache scoped al handler (RPC get_mp_token).
    const getMpToken = createMpTokenGetter(db);

    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('id, local_id, locales(nombre)')
      .eq('activo', true);

    if (credsError) {
      return res.status(500).json({ ok: false, error: credsError.message });
    }
    if (!creds || creds.length === 0) {
      return res.status(200).json({ ok: true, message: 'Sin credenciales configuradas' });
    }

    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const begin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const beginIso =
      `${begin.getUTCFullYear()}-${pad(begin.getUTCMonth() + 1)}-${pad(begin.getUTCDate())}T00:00:00Z`;
    const endIso =
      `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`;

    const resultados = [];
    const timestamp = Date.now();

    // Default: release_report. Es inclusivo (procesa Point Smart, propinas,
    // débitos automáticos, etc.); settlement_report filtraba por whitelist
    // incompleta y nos hizo perder ~$553k del 1/5/2026 (TASK 0.18).
    // Override manual: ?source=settlement para casos especiales.
    const sourceOverride = (req.query?.source || req.body?.source || '').toLowerCase();
    const source = sourceOverride === 'settlement' ? 'settlement' : 'release';
    const reportEndpoint = source === 'release'
      ? 'https://api.mercadopago.com/v1/account/release_report'
      : 'https://api.mercadopago.com/v1/account/settlement_report';

    for (const cred of creds) {
      try {
        const token = await getMpToken(cred.id);

        // PARTE C de TASK 0.11 + Opción A del fix de rate limit: NO hay
        // fallback automático. Cada call genera UNA sola task de MP.
        // Si la elegida (settlement por default) rechaza, devolvemos
        // error claro — el caller decide si retry con ?source=release.
        let postRes;
        try {
          postRes = await fetch(reportEndpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ begin_date: beginIso, end_date: endIso }),
          });
        } catch (eFetch) {
          console.error('[mp-generate] fetch error', cred.local_id, source, eFetch?.message);
          resultados.push({
            local_id: cred.local_id,
            local: cred.locales?.nombre,
            source,
            error: `fetch_error: ${eFetch?.message || String(eFetch)}`,
          });
          continue;
        }

        const postBody = await postRes.text();
        console.log('[mp-generate] POST', source, cred.local_id, postRes.status, postBody.slice(0, 200));
        resultados.push({
          local_id: cred.local_id,
          local: cred.locales?.nombre,
          source,
          status: postRes.status,
          ok: postRes.ok,
          body: postRes.ok ? undefined : postBody.slice(0, 200),
        });
      } catch (e) {
        console.error('[mp-generate] error', cred.local_id, e);
        resultados.push({
          local_id: cred.local_id,
          local: cred.locales?.nombre,
          source,
          error: e.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      timestamp,
      begin_date: beginIso,
      end_date: endIso,
      resultados,
    });
  } catch (err) {
    console.error('mp-generate: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
