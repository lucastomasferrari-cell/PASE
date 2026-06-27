// Endpoint de envío por WhatsApp Cloud API (Meta) — a spec.
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
//
// "Solo credenciales": setear estas env vars en el proyecto Vercel de Habitué y
// queda funcionando. NADA más del código cambia.
//   WHATSAPP_TOKEN            → token permanente del System User / app (Bearer)
//   WHATSAPP_PHONE_NUMBER_ID  → id del número de WhatsApp Business
//   WHATSAPP_API_VERSION      → opcional, default v21.0
//
// Para el PRIMER contacto / marketing, Meta exige PLANTILLAS aprobadas (no texto
// libre). Por eso el body acepta `template` (nombre + variables). Para
// conversaciones abiertas (dentro de 24hs) se puede mandar `texto` libre.
//
// Body JSON:
//   { to: "<telefono>", texto?: "...", template?: { nombre, idioma?, variables?: string[] } }

// SEGURIDAD (fix audit 26-jun CRIT-3): requiere JWT del caller. Antes era
// abierto y permitía mandar WhatsApps arbitrarios usando los créditos Meta
// del tenant.
import { checkUserAuth } from './_auth.js';

const GRAPH = 'https://graph.facebook.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const auth = await checkUserAuth(req, res);
  if (!auth) return;

  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';

  // "Solo credenciales": si no están seteadas, avisa sin romper (la app cae a wa.me).
  if (!token || !phoneId) {
    return res.status(200).json({ ok: false, configured: false, error: 'WhatsApp API sin credenciales (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).' });
  }

  const { to, texto, template } = req.body || {};
  if (!to) return res.status(400).json({ ok: false, error: 'Falta "to"' });

  // Armar el payload según la spec de Cloud API.
  let payload;
  if (template) {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template.nombre,
        language: { code: template.idioma || 'es_AR' },
        ...(Array.isArray(template.variables) && template.variables.length
          ? { components: [{ type: 'body', parameters: template.variables.map((v) => ({ type: 'text', text: String(v) })) }] }
          : {}),
      },
    };
  } else {
    payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: texto || '' } };
  }

  try {
    const r = await fetch(`${GRAPH}/${version}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(200).json({ ok: false, configured: true, error: data?.error?.message || `HTTP ${r.status}`, raw: data });
    }
    const messageId = data?.messages?.[0]?.id ?? null;
    return res.status(200).json({ ok: true, configured: true, messageId });
  } catch (e) {
    return res.status(200).json({ ok: false, configured: true, error: e instanceof Error ? e.message : String(e) });
  }
}
