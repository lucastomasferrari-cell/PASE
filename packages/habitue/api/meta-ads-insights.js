// Endpoint de insights de Meta Ads — a spec.
// https://developers.facebook.com/docs/marketing-api/insights
//
// "Solo credenciales": setear estas env vars en Vercel:
//   META_ADS_TOKEN        → access token (long-lived) del System User con permiso ads_read
//   META_ADS_ACCOUNT_ID   → id de la ad account (formato "act_XXXXXXX")
//   META_API_VERSION      → opcional, default v21.0
//
// Query: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (default = últimos 30 días)
// Respuesta: { ok, configured, insights: { gasto, alcance, clicks, conversiones } }

const GRAPH = 'https://graph.facebook.com';

function rangoDefault() {
  const hasta = new Date(); const desde = new Date(); desde.setDate(desde.getDate() - 30);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { desde: iso(desde), hasta: iso(hasta) };
}

export default async function handler(req, res) {
  const token = process.env.META_ADS_TOKEN;
  const accountId = process.env.META_ADS_ACCOUNT_ID;
  const version = process.env.META_API_VERSION || 'v21.0';
  if (!token || !accountId) {
    return res.status(200).json({ ok: false, configured: false, error: 'Meta Ads sin credenciales (META_ADS_TOKEN / META_ADS_ACCOUNT_ID).' });
  }

  const { desde: defDesde, hasta: defHasta } = rangoDefault();
  const desde = req.query.desde || defDesde;
  const hasta = req.query.hasta || defHasta;

  const fields = ['spend', 'reach', 'clicks', 'actions'].join(',');
  const timeRange = encodeURIComponent(JSON.stringify({ since: desde, until: hasta }));
  const url = `${GRAPH}/${version}/${accountId}/insights?fields=${fields}&time_range=${timeRange}&access_token=${token}`;

  try {
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) {
      return res.status(200).json({ ok: false, configured: true, error: data?.error?.message || `HTTP ${r.status}`, raw: data });
    }
    const row = Array.isArray(data?.data) && data.data.length ? data.data[0] : null;
    // "actions" trae conversiones por tipo; sumamos las relevantes.
    const conversiones = Array.isArray(row?.actions)
      ? row.actions
          .filter((a) => ['purchase', 'lead', 'complete_registration', 'offsite_conversion.fb_pixel_purchase'].includes(a.action_type))
          .reduce((s, a) => s + Number(a.value || 0), 0)
      : 0;

    return res.status(200).json({
      ok: true,
      configured: true,
      insights: {
        gasto: Number(row?.spend || 0),
        alcance: Number(row?.reach || 0),
        clicks: Number(row?.clicks || 0),
        conversiones,
      },
      rango: { desde, hasta },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, configured: true, error: e instanceof Error ? e.message : String(e) });
  }
}
