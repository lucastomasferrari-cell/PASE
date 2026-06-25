// Endpoint de envío de email por Resend — a spec.
// https://resend.com/docs/api-reference/emails/send-email
//
// "Solo credenciales": setear estas env vars en el proyecto Vercel de Habitué:
//   RESEND_API_KEY  → API key de Resend
//   RESEND_FROM     → remitente verificado, ej "Habitué <hola@tudominio.com>"
//
// Body JSON: { to: ["a@x.com", ...], asunto: "...", html?: "...", texto?: "..." }
// (to acepta hasta 50 destinatarios por request según Resend; para más, batch.)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    return res.status(200).json({ ok: false, configured: false, error: 'Email sin credenciales (RESEND_API_KEY / RESEND_FROM).' });
  }

  const { to, asunto, html, texto } = req.body || {};
  if (!Array.isArray(to) || to.length === 0) return res.status(400).json({ ok: false, error: 'Falta "to" (array)' });
  if (!asunto) return res.status(400).json({ ok: false, error: 'Falta "asunto"' });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        subject: asunto,
        ...(html ? { html } : { text: texto || '' }),
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(200).json({ ok: false, configured: true, error: data?.message || `HTTP ${r.status}`, raw: data });
    }
    return res.status(200).json({ ok: true, configured: true, id: data?.id ?? null });
  } catch (e) {
    return res.status(200).json({ ok: false, configured: true, error: e instanceof Error ? e.message : String(e) });
  }
}
