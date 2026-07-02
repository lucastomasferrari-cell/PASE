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
  const tipo = (req.body && req.body.tipo) === 'resena' ? 'resena' : 'confirmacion';
  if (!reservaId) return res.status(400).json({ ok: false, error: 'Falta reservaId' });

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Cargar la reserva.
  const { data: r, error } = await db
    .from('reservas')
    .select('id, cliente_nombre, cliente_email, fecha_hora, personas, estado, local_id, created_at, notif_confirmacion_at, notif_resena_at, cancel_token')
    .eq('id', reservaId)
    .maybeSingle();
  // Respuesta genérica para TODOS los casos de "no envío": no revelar si la
  // reserva existe / tiene email / etc → evita usar el endpoint como oráculo
  // de enumeración de reservas (auditoría I2).
  const OK = { ok: true };
  if (error || !r) return res.status(200).json(OK);
  if (!r.cliente_email) return res.status(200).json(OK);
  if (tipo === 'resena') {
    if (r.notif_resena_at) return res.status(200).json(OK);
    if (!['sentada', 'finalizada'].includes(r.estado)) return res.status(200).json(OK);
  } else {
    if (r.notif_confirmacion_at) return res.status(200).json(OK);
    const edadMin = (Date.now() - new Date(r.created_at).getTime()) / 60000;
    if (edadMin > 15) return res.status(200).json(OK);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromEnv = process.env.RESEND_FROM;
  if (!apiKey || !fromEnv) {
    return res.status(200).json({ ok: false, configured: false, error: 'Email sin credenciales (RESEND_API_KEY / RESEND_FROM).' });
  }

  // Nombre del local (para el asunto/cuerpo) + remitente con display name.
  const { data: local } = await db.from('locales').select('nombre').eq('id', r.local_id).maybeSingle();
  const localNombre = local?.nombre || 'el restaurante';
  const from = fromEnv.includes('<') ? fromEnv : `${localNombre} <${fromEnv}>`;
  const mesaBase = (process.env.MESA_PUBLIC_BASE || 'https://mesa-orpin.vercel.app').replace(/\/$/, '');
  const tokenQ = r.cancel_token ? `?t=${r.cancel_token}` : '';

  let asunto, html, markCol;
  if (tipo === 'resena') {
    const url = `${mesaBase}/r/resena/${r.id}${tokenQ}`;
    asunto = `¿Cómo estuvo tu experiencia en ${localNombre}?`;
    html = `
      <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">
        <h2 style="margin:0 0 8px">¡Gracias por venir, ${r.cliente_nombre}!</h2>
        <p style="margin:0 0 16px;color:#555">¿Nos dejás una reseña de tu visita a <strong>${localNombre}</strong>? Te toma 10 segundos y nos ayuda un montón.</p>
        <a href="${url}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">Dejar mi reseña</a>
        <p style="margin:20px 0 0;color:#aaa;font-size:12px">Si no fuiste vos, ignorá este mail.</p>
      </div>`;
    markCol = 'notif_resena_at';
  } else {
    const cancelUrl = `${mesaBase}/r/cancelar/${r.id}${tokenQ}`;
    const cuando = fmtFechaHora(r.fecha_hora);
    const estadoTxt = r.estado === 'confirmada'
      ? 'Tu reserva quedó <strong>confirmada</strong>.'
      : 'Recibimos tu solicitud. El restaurante la va a <strong>confirmar en breve</strong>.';
    asunto = `Reserva en ${localNombre} — ${cuando}`;
    html = `
      <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">
        <h2 style="margin:0 0 8px">¡Hola ${r.cliente_nombre}!</h2>
        <p style="margin:0 0 16px;color:#555">${estadoTxt}</p>
        <table style="width:100%;border-collapse:collapse;font-size:15px">
          <tr><td style="padding:6px 0;color:#888">Lugar</td><td style="padding:6px 0;text-align:right"><strong>${localNombre}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#888">Fecha y hora</td><td style="padding:6px 0;text-align:right"><strong>${cuando}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#888">Personas</td><td style="padding:6px 0;text-align:right"><strong>${r.personas}</strong></td></tr>
        </table>
        <p style="margin:20px 0 8px;color:#555;font-size:14px">¿No podés asistir? Cancelá así liberamos la mesa:</p>
        <a href="${cancelUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">Cancelar mi reserva</a>
        <p style="margin:20px 0 0;color:#aaa;font-size:12px">Si no fuiste vos quien reservó, ignorá este mail.</p>
      </div>`;
    markCol = 'notif_confirmacion_at';
  }

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
    await db.from('reservas').update({ [markCol]: new Date().toISOString() }).eq('id', r.id);
    return res.status(200).json({ ok: true, id: data?.id ?? null });
  } catch (e) {
    return res.status(200).json({ ok: false, configured: true, error: e instanceof Error ? e.message : String(e) });
  }
}
