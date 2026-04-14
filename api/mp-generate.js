// mp-generate: POST a MP para generar CSV nuevo. Responde en <5s.
export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('local_id, access_token, locales(nombre)')
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

    for (const cred of creds) {
      try {
        const postRes = await fetch(
          'https://api.mercadopago.com/v1/account/release_report',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cred.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ begin_date: beginIso, end_date: endIso }),
          }
        );
        const postBody = await postRes.text();
        console.log('[mp-generate] POST', cred.local_id, postRes.status, postBody.slice(0, 200));
        resultados.push({
          local_id: cred.local_id,
          local: cred.locales?.nombre,
          status: postRes.status,
        });
      } catch (e) {
        console.error('[mp-generate] error', cred.local_id, e);
        resultados.push({
          local_id: cred.local_id,
          local: cred.locales?.nombre,
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
