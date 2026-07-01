// Confirmación automática al cliente tras crear una reserva pública (MESA).
//
// Lo llama (fire-and-forget) el widget público apenas se crea la reserva.
// Manda un email de confirmación vía Resend. Público pero acotado:
//   - Solo envía a la dirección guardada EN la reserva (no a un mail arbitrario).
//   - Solo una vez (columna notif_confirmacion_at), idempotente.
//   - Solo reservas recién creadas (< 15 min) → no sirve para spamear históricas.
//
// Requiere en el proyecto Vercel de PASE:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (ya están)
//   RESEND_API_KEY, RESEND_FROM         (setear para que envíe; sin esto no-op)
//
// El WhatsApp automático se enchufa acá también cuando esté la plantilla Meta.

import { createClient } from '@supabase/supabase-js';

function fmtFechaHora(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
    });
  } catch { return iso; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(200).json({ ok: false, error: 'Backend sin configurar' });
  }

  const reservaId = (req.body && (req.body.reservaId ?? req.body.reserva_id));
  if (!reservaId) return res.status(400).json({ ok: false, error: 'Falta reservaId' });

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Cargar la reserva.
  const { data: r, error } = await db
    .from('reservas')
    .select('id, cliente_nombre, cliente_email, fecha_hora, personas, estado, local_id, created_at, notif_confirmacion_at')
    .eq('id', reservaId)
    .maybeSingle();
  if (error || !r) return res.status(200).json({ ok: false, error: 'Reserva no encontrada' });

  // Guardas anti-abuso.
  if (r.notif_confirmacion_at) return res.status(200).json({ ok: true, already: true });
  if (!r.cliente_email) return res.status(200).json({ ok: false, error: 'Sin email' });
  const edadMin = (Date.now() - new Date(r.created_at).getTime()) / 60000;
  if (edadMin > 15) return res.status(200).json({ ok: false, error: 'Reserva no reciente' });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    return res.status(200).json({ ok: false, configured: false, error: 'Email sin credenciales (RESEND_API_KEY / RESEND_FROM).' });
  }

  // Nombre del local (para el asunto/cuerpo).
  const { data: local } = await db.from('locales').select('nombre').eq('id', r.local_id).maybeSingle();
  const localNombre = local?.nombre || 'el restaurante';
  const cuando = fmtFechaHora(r.fecha_hora);
  const estadoTxt = r.estado === 'confirmada'
    ? 'Tu reserva quedó <strong>confirmada</strong>.'
    : 'Recibimos tu solicitud. El restaurante la va a <strong>confirmar en breve</strong>.';

  const asunto = `Reserva en ${localNombre} — ${cuando}`;
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">
      <h2 style="margin:0 0 8px">¡Hola ${r.cliente_nombre}!</h2>
      <p style="margin:0 0 16px;color:#555">${estadoTxt}</p>
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr><td style="padding:6px 0;color:#888">Lugar</td><td style="padding:6px 0;text-align:right"><strong>${localNombre}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#888">Fecha y hora</td><td style="padding:6px 0;text-align:right"><strong>${cuando}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#888">Personas</td><td style="padding:6px 0;text-align:right"><strong>${r.personas}</strong></td></tr>
      </table>
      <p style="margin:16px 0 0;color:#888;font-size:13px">Si no podés asistir, avisanos así liberamos la mesa. ¡Te esperamos!</p>
    </div>`;

  try {
    const rr = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [r.cliente_email], subject: asunto, html }),
    });
    const data = await rr.json();
    if (!rr.ok) {
      return res.status(200).json({ ok: false, configured: true, error: data?.message || `HTTP ${rr.status}` });
    }
    // Marcar como enviado (idempotencia).
    await db.from('reservas').update({ notif_confirmacion_at: new Date().toISOString() }).eq('id', r.id);
    return res.status(200).json({ ok: true, id: data?.id ?? null });
  } catch (e) {
    return res.status(200).json({ ok: false, configured: true, error: e instanceof Error ? e.message : String(e) });
  }
}
