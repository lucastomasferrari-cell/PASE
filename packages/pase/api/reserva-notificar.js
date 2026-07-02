// Mails de reservas (MESA) vía Resend. Dos modos:
//
//  1) PÚBLICO (lo llama el widget al reservar): POST { reservaId, tipo }
//     - tipo 'confirmacion' (default): confirma la reserva recién creada (<15min).
//     Solo envía a la dirección guardada EN la reserva, una vez (idempotente).
//
//  2) CRON (GitHub Actions diario): POST con Authorization: Bearer <SERVICE_KEY>.
//     - Recordatorios: reservas de HOY (con email, sin recordatorio enviado).
//     - Reseñas: reservas de AYER que no se cancelaron / no fueron no-show.
//
// Requiere en Vercel pase-yndx: SUPABASE_URL, SUPABASE_SERVICE_KEY (ya están),
// RESEND_API_KEY, RESEND_FROM. Opcional MESA_PUBLIC_BASE (URL pública de MESA).

import { createClient } from '@supabase/supabase-js';

function fmtFechaHora(iso) {
  try {
    return new Date(iso).toLocaleString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
    });
  } catch { return iso; }
}
function fmtHora(iso) {
  try {
    return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
  } catch { return iso; }
}
// Fecha AR (YYYY-MM-DD) con offset de días.
function arDate(offDays) {
  return new Date(Date.now() + offDays * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

const box = (inner) => `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">${inner}</div>`;
const btn = (href, label) => `<a href="${href}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">${label}</a>`;

// Reemplaza {{nombre}}, {{local}}, {{fecha}}, {{hora}}, {{personas}} en textos custom.
function interp(txt, vars) {
  if (!txt) return txt;
  return txt.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function tplConfirmacion(r, localNombre, cancelUrl, custom) {
  const cuando = fmtFechaHora(r.fecha_hora);
  const vars = { nombre: r.cliente_nombre, local: localNombre, fecha: cuando, hora: fmtHora(r.fecha_hora), personas: String(r.personas) };
  const estadoTxt = r.estado === 'confirmada'
    ? 'Tu reserva quedó <strong>confirmada</strong>.'
    : 'Recibimos tu solicitud. El restaurante la va a <strong>confirmar en breve</strong>.';
  const titulo = interp(custom?.titulo, vars) || `¡Hola ${r.cliente_nombre}!`;
  const subtitulo = interp(custom?.subtitulo, vars) || estadoTxt;
  return {
    asunto: interp(custom?.titulo, vars) || `Reserva en ${localNombre} — ${cuando}`,
    html: box(`
      <h2 style="margin:0 0 8px">${titulo}</h2>
      <p style="margin:0 0 16px;color:#555">${subtitulo}</p>
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr><td style="padding:6px 0;color:#888">Lugar</td><td style="padding:6px 0;text-align:right"><strong>${localNombre}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#888">Fecha y hora</td><td style="padding:6px 0;text-align:right"><strong>${cuando}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#888">Personas</td><td style="padding:6px 0;text-align:right"><strong>${r.personas}</strong></td></tr>
      </table>
      <p style="margin:20px 0 8px;color:#555;font-size:14px">¿No podés asistir? Cancelá así liberamos la mesa:</p>
      ${btn(cancelUrl, 'Cancelar mi reserva')}
      <p style="margin:20px 0 0;color:#aaa;font-size:12px">Si no fuiste vos quien reservó, ignorá este mail.</p>`),
  };
}
function tplRecordatorio(r, localNombre, cancelUrl, custom) {
  const vars = { nombre: r.cliente_nombre, local: localNombre, fecha: fmtFechaHora(r.fecha_hora), hora: fmtHora(r.fecha_hora), personas: String(r.personas) };
  const titulo = interp(custom?.titulo, vars) || `¡Hola ${r.cliente_nombre}!`;
  const subtitulo = interp(custom?.subtitulo, vars) || `Te recordamos tu reserva de <strong>hoy a las ${fmtHora(r.fecha_hora)}</strong> en <strong>${localNombre}</strong> para <strong>${r.personas}</strong> ${r.personas === 1 ? 'persona' : 'personas'}. ¡Te esperamos!`;
  return {
    asunto: interp(custom?.titulo, vars) || `Hoy te esperamos en ${localNombre} 🍽️`,
    html: box(`
      <h2 style="margin:0 0 8px">${titulo}</h2>
      <p style="margin:0 0 16px;color:#555">${subtitulo}</p>
      <p style="margin:0 0 8px;color:#555;font-size:14px">Si no vas a poder venir, avisanos:</p>
      ${btn(cancelUrl, 'Cancelar mi reserva')}`),
  };
}
function tplResena(r, localNombre, url, custom) {
  const vars = { nombre: r.cliente_nombre, local: localNombre, fecha: fmtFechaHora(r.fecha_hora), hora: fmtHora(r.fecha_hora), personas: String(r.personas) };
  const titulo = interp(custom?.titulo, vars) || `¡Gracias por venir, ${r.cliente_nombre}!`;
  const subtitulo = interp(custom?.subtitulo, vars) || `¿Nos dejás una reseña de tu visita a <strong>${localNombre}</strong>? Te toma 10 segundos y nos ayuda un montón.`;
  return {
    asunto: interp(custom?.titulo, vars) || `¿Cómo estuvo tu experiencia en ${localNombre}?`,
    html: box(`
      <h2 style="margin:0 0 8px">${titulo}</h2>
      <p style="margin:0 0 16px;color:#555">${subtitulo}</p>
      ${btn(url, 'Dejar mi reseña')}
      <p style="margin:20px 0 0;color:#aaa;font-size:12px">Si no fuiste vos, ignorá este mail.</p>`),
  };
}

async function sendEmail(apiKey, from, to, subject, html) {
  try {
    const rr = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    const data = await rr.json();
    if (!rr.ok) return { ok: false, error: data?.message || `HTTP ${rr.status}` };
    return { ok: true, id: data?.id ?? null };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

const SEL = 'id, cliente_nombre, cliente_email, fecha_hora, personas, estado, local_id, cancel_token';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(200).json({ ok: false, error: 'Backend sin configurar' });

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const apiKey = process.env.RESEND_API_KEY;
  const fromEnv = process.env.RESEND_FROM;
  const mesaBase = (process.env.MESA_PUBLIC_BASE || 'https://mesa-orpin.vercel.app').replace(/\/$/, '');
  const fromHdr = (localNombre) => (fromEnv && fromEnv.includes('<')) ? fromEnv : `${localNombre} <${fromEnv}>`;
  const cancelUrl = (r) => `${mesaBase}/r/cancelar/${r.id}${r.cancel_token ? `?t=${r.cancel_token}` : ''}`;
  const resenaUrl = (r) => `${mesaBase}/r/resena/${r.id}${r.cancel_token ? `?t=${r.cancel_token}` : ''}`;

  const auth = req.headers.authorization || '';
  const isCron = auth === `Bearer ${serviceKey}`;

  // ─── MODO CRON (GitHub Actions, cada hora): recordatorios + reseñas ───
  // Cada local define su hora de envío (reservas_notif_hora) y qué mails manda.
  if (isCron) {
    if (!apiKey || !fromEnv) return res.status(200).json({ ok: false, configured: false, error: 'Email sin credenciales.' });
    const hourAR = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }));
    const { data: cfgs } = await db.from('comanda_local_settings')
      .select('local_id, reservas_notif_recordatorio, reservas_notif_resena, reservas_notif_hora, reservas_tpl_recordatorio_titulo, reservas_tpl_recordatorio_subtitulo, reservas_tpl_resena_titulo, reservas_tpl_resena_subtitulo')
      .is('deleted_at', null);
    const tplsDe = Object.fromEntries((cfgs || []).map((c) => [c.local_id, c]));
    const recLocals = (cfgs || []).filter((c) => c.reservas_notif_recordatorio && (c.reservas_notif_hora ?? 11) === hourAR).map((c) => c.local_id);
    const revLocals = (cfgs || []).filter((c) => c.reservas_notif_resena && (c.reservas_notif_hora ?? 11) === hourAR).map((c) => c.local_id);
    if (recLocals.length === 0 && revLocals.length === 0) return res.status(200).json({ ok: true, recordatorios: 0, resenas: 0, hora: hourAR });

    const todayStart = `${arDate(0)}T00:00:00-03:00`;
    const tomStart = `${arDate(1)}T00:00:00-03:00`;
    const yestStart = `${arDate(-1)}T00:00:00-03:00`;

    const recs = recLocals.length ? (await db.from('reservas').select(SEL)
      .in('local_id', recLocals)
      .gte('fecha_hora', todayStart).lt('fecha_hora', tomStart)
      .in('estado', ['pendiente', 'confirmada', 'sentada'])
      .not('cliente_email', 'is', null).is('notif_recordatorio_at', null).is('deleted_at', null)).data : [];
    const revs = revLocals.length ? (await db.from('reservas').select(SEL)
      .in('local_id', revLocals)
      .gte('fecha_hora', yestStart).lt('fecha_hora', todayStart)
      .in('estado', ['confirmada', 'sentada', 'finalizada'])
      .not('cliente_email', 'is', null).is('notif_resena_at', null).is('deleted_at', null)).data : [];

    const ids = [...new Set([...(recs || []), ...(revs || [])].map((x) => x.local_id))];
    const { data: locs } = ids.length ? await db.from('locales').select('id, nombre').in('id', ids) : { data: [] };
    const nombreDe = Object.fromEntries((locs || []).map((l) => [l.id, l.nombre]));

    let nRec = 0, nRev = 0;
    for (const r of recs || []) {
      const ln = nombreDe[r.local_id] || 'el restaurante';
      const tc = tplsDe[r.local_id];
      const { asunto, html } = tplRecordatorio(r, ln, cancelUrl(r), { titulo: tc?.reservas_tpl_recordatorio_titulo, subtitulo: tc?.reservas_tpl_recordatorio_subtitulo });
      const s = await sendEmail(apiKey, fromHdr(ln), r.cliente_email, asunto, html);
      if (s.ok) { await db.from('reservas').update({ notif_recordatorio_at: new Date().toISOString() }).eq('id', r.id); nRec++; }
    }
    for (const r of revs || []) {
      const ln = nombreDe[r.local_id] || 'el restaurante';
      const tc = tplsDe[r.local_id];
      const { asunto, html } = tplResena(r, ln, resenaUrl(r), { titulo: tc?.reservas_tpl_resena_titulo, subtitulo: tc?.reservas_tpl_resena_subtitulo });
      const s = await sendEmail(apiKey, fromHdr(ln), r.cliente_email, asunto, html);
      if (s.ok) { await db.from('reservas').update({ notif_resena_at: new Date().toISOString() }).eq('id', r.id); nRev++; }
    }
    return res.status(200).json({ ok: true, recordatorios: nRec, resenas: nRev });
  }

  // ─── MODO PÚBLICO: confirmación de una reserva recién creada ───
  const reservaId = (req.body && (req.body.reservaId ?? req.body.reserva_id));
  const tipo = (req.body && req.body.tipo) === 'resena' ? 'resena' : 'confirmacion';
  if (!reservaId) return res.status(400).json({ ok: false, error: 'Falta reservaId' });

  const { data: r, error } = await db.from('reservas')
    .select(`${SEL}, created_at, notif_confirmacion_at, notif_resena_at`)
    .eq('id', reservaId).maybeSingle();
  const OK = { ok: true }; // respuesta genérica: no revela si existe/tiene email (audit I2)
  if (error || !r) return res.status(200).json(OK);
  if (!r.cliente_email) return res.status(200).json(OK);
  if (tipo === 'resena') {
    if (r.notif_resena_at) return res.status(200).json(OK);
    if (!['sentada', 'finalizada'].includes(r.estado)) return res.status(200).json(OK);
  } else {
    if (r.notif_confirmacion_at) return res.status(200).json(OK);
    if ((Date.now() - new Date(r.created_at).getTime()) / 60000 > 15) return res.status(200).json(OK);
  }
  const { data: stData } = await db.from('comanda_local_settings')
    .select('reservas_notif_confirmacion, reservas_tpl_confirmacion_titulo, reservas_tpl_confirmacion_subtitulo, reservas_tpl_recordatorio_titulo, reservas_tpl_recordatorio_subtitulo, reservas_tpl_resena_titulo, reservas_tpl_resena_subtitulo')
    .eq('local_id', r.local_id).maybeSingle();
  if (tipo === 'confirmacion' && stData && stData.reservas_notif_confirmacion === false) return res.status(200).json(OK);
  if (!apiKey || !fromEnv) return res.status(200).json({ ok: false, configured: false, error: 'Email sin credenciales.' });

  const tpls = stData || {};
  const ln = (await db.from('locales').select('nombre').eq('id', r.local_id).maybeSingle()).data?.nombre || 'el restaurante';
  const { asunto, html } = tipo === 'resena'
    ? tplResena(r, ln, resenaUrl(r), { titulo: tpls.reservas_tpl_resena_titulo, subtitulo: tpls.reservas_tpl_resena_subtitulo })
    : tplConfirmacion(r, ln, cancelUrl(r), { titulo: tpls.reservas_tpl_confirmacion_titulo, subtitulo: tpls.reservas_tpl_confirmacion_subtitulo });
  const s = await sendEmail(apiKey, fromHdr(ln), r.cliente_email, asunto, html);
  if (!s.ok) return res.status(200).json({ ok: false, configured: true, error: s.error });
  const markCol = tipo === 'resena' ? 'notif_resena_at' : 'notif_confirmacion_at';
  await db.from('reservas').update({ [markCol]: new Date().toISOString() }).eq('id', r.id);
  return res.status(200).json({ ok: true, id: s.id });
}
