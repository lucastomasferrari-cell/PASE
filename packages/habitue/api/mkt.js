// Endpoint de email marketing (Habitué) — dispatcher autenticado.
//
// Acciones (POST { action, ... }):
//   config-get                      → devuelve mkt_config del tenant (o defaults)
//   config-set { config }           → upsert mkt_config
//   test { campana_id, email }      → manda 1 mail de prueba (no toca destinatarios)
//   enviar { campana_id, cliente_ids? } → envía la campaña. Reanudable: procesa hasta
//                                    LOTE destinatarios por llamada; si quedan, done=false.
//   programadas                     → (cron) envía campañas 'programada' cuya hora llegó
//
// Motor: Resend (dominio mailing.comanda.lat). Respeta opt-in + supresiones.
// El envío es idempotente: los destinatarios ya 'enviado' no se re-mandan.

import { checkUserAuth, checkCronAuth } from './_auth.js';
import { renderTemplate, resendEnviar, urlBaja } from './_mkt.js';

// Resend permite 10 requests/segundo. Mandamos en grupos chicos con pausa para
// quedar bien por debajo (~6/seg) y no comernos 429. LOTE bajo para terminar cada
// invocación en <10s (compatible con timeout de Vercel Hobby); el front reintenta
// hasta done. Los 429 quedan 'pendiente' (reintento), no 'fallido'.
const LOTE = 40;             // destinatarios por invocación
const GRUPO = 5;             // envíos en paralelo por tanda
const PAUSA_MS = 800;        // pausa entre tandas → ~6 req/seg
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseUrl(req) {
  if (process.env.MKT_PUBLIC_URL) return process.env.MKT_PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}
function secretBaja() {
  return process.env.MKT_UNSUB_SECRET || process.env.CRON_SECRET || 'mkt-dev-secret';
}

// ¿Es un email válido? Acepta "algo@dominio.tld" o "Nombre <algo@dominio.tld>".
function emailValido(s) {
  if (!s || typeof s !== 'string') return false;
  const m = /<([^>]+)>/.exec(s);
  const addr = (m ? m[1] : s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

// Arma el remitente "Nombre <email>" desde la campaña, o mkt_config, o env.
// El reply_to solo se incluye si es un email válido (un typo no debe romper el envío).
function remitente(campana, cfg) {
  const nombre = campana.from_nombre || cfg?.from_nombre || 'Neko';
  const email = campana.from_email || cfg?.from_email || process.env.RESEND_FROM_MARKETING || 'hola@mailing.comanda.lat';
  const rt = campana.reply_to || cfg?.reply_to || null;
  return { from: `${nombre} <${email}>`, replyTo: emailValido(rt) ? rt : null };
}

// Inserta el link de baja: reemplaza {{unsubscribe}} si está, si no agrega footer.
function inyectarBaja(html, unsub) {
  const link = `<a href="${unsub}" style="color:#888">darte de baja</a>`;
  if (html.includes('{{unsubscribe}}')) return html.replace(/\{\{\s*unsubscribe\s*\}\}/g, unsub);
  return `${html}<div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#888;text-align:center">Recibís este mail porque sos cliente. Podés ${link} cuando quieras.</div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const action = req.body?.action;

  // La acción 'programadas' la dispara el cron; el resto, un usuario logueado.
  let db, tenantId, usuarioId = null;
  if (action === 'programadas') {
    if (!checkCronAuth(req, res)) return;
    const { createClient } = await import('@supabase/supabase-js');
    db = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  } else {
    const auth = await checkUserAuth(req, res);
    if (!auth) return;
    db = auth.db; tenantId = auth.row.tenant_id; usuarioId = auth.row.id;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey && action !== 'config-get' && action !== 'config-set') {
    return res.status(200).json({ ok: false, configured: false, error: 'Resend sin credenciales (RESEND_API_KEY).' });
  }

  try {
    // ── config ────────────────────────────────────────────────────────────
    if (action === 'config-get') {
      const { data } = await db.from('mkt_config').select('*').eq('tenant_id', tenantId).maybeSingle();
      return res.status(200).json({ ok: true, config: data || null });
    }
    if (action === 'config-set') {
      const c = req.body.config || {};
      const { data, error } = await db.from('mkt_config').upsert({
        tenant_id: tenantId,
        from_nombre: c.from_nombre, from_email: c.from_email, reply_to: c.reply_to || null,
        dominio_envio: c.dominio_envio || 'mailing.comanda.lat', updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id' }).select().single();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, config: data });
    }

    // ── test: 1 mail de prueba ──────────────────────────────────────────────
    if (action === 'test') {
      const { campana_id, email } = req.body;
      if (!email) return res.status(400).json({ ok: false, error: 'Falta email' });
      const { data: campana } = await db.from('mkt_campanas').select('*').eq('id', campana_id).eq('tenant_id', tenantId).maybeSingle();
      if (!campana) return res.status(404).json({ ok: false, error: 'Campaña no encontrada' });
      const { data: cfg } = await db.from('mkt_config').select('*').eq('tenant_id', tenantId).maybeSingle();
      const { from, replyTo } = remitente(campana, cfg);
      const unsub = urlBaja(baseUrl(req), email, tenantId, secretBaja());
      const html = inyectarBaja(renderTemplate(campana.html, { nombre: 'Prueba', email }), unsub);
      const { id, error } = await resendEnviar({ apiKey, from, replyTo, to: [email], subject: `[PRUEBA] ${campana.asunto}`, html, unsubUrl: unsub });
      if (error) return res.status(200).json({ ok: false, error });
      return res.status(200).json({ ok: true, id });
    }

    // ── enviar campaña (reanudable) ─────────────────────────────────────────
    if (action === 'enviar') {
      const { campana_id, cliente_ids } = req.body;
      const { data: campana } = await db.from('mkt_campanas').select('*').eq('id', campana_id).eq('tenant_id', tenantId).maybeSingle();
      if (!campana) return res.status(404).json({ ok: false, error: 'Campaña no encontrada' });
      if (['enviada', 'cancelada'].includes(campana.estado)) {
        return res.status(400).json({ ok: false, error: `La campaña está ${campana.estado}` });
      }
      const { data: cfg } = await db.from('mkt_config').select('*').eq('tenant_id', tenantId).maybeSingle();

      // Primera vez: materializar destinatarios (opt-in, con email, no suprimidos).
      const { count: yaHay } = await db.from('mkt_campana_destinatarios')
        .select('id', { count: 'exact', head: true }).eq('campana_id', campana_id);
      if (!yaHay) {
        let q = db.from('clientes').select('id, email, nombre')
          .eq('tenant_id', tenantId).eq('acepta_marketing', true).not('email', 'is', null).is('deleted_at', null);
        if (Array.isArray(cliente_ids) && cliente_ids.length) q = q.in('id', cliente_ids);
        const { data: contactos } = await q;
        const { data: sup } = await db.from('mkt_supresiones').select('email').eq('tenant_id', tenantId);
        const bloqueados = new Set((sup || []).map((s) => s.email.toLowerCase()));
        const vistos = new Set();
        const filas = [];
        for (const c of contactos || []) {
          const em = (c.email || '').trim().toLowerCase();
          if (!em || em.indexOf('@') < 1 || bloqueados.has(em) || vistos.has(em)) continue;
          vistos.add(em);
          filas.push({ tenant_id: tenantId, campana_id, cliente_id: c.id, email: em, nombre: c.nombre, estado: 'pendiente' });
        }
        if (filas.length) {
          // insertar en tandas para no exceder límites del cliente supabase
          for (let i = 0; i < filas.length; i += 500) {
            await db.from('mkt_campana_destinatarios').upsert(filas.slice(i, i + 500), { onConflict: 'campana_id,email', ignoreDuplicates: true });
          }
        }
        await db.from('mkt_campanas').update({
          estado: 'enviando', total_destinatarios: filas.length,
          segmento_criterio: cliente_ids ? { cliente_ids } : { todos_opt_in: true },
          updated_at: new Date().toISOString(),
        }).eq('id', campana_id);
      } else if (campana.estado !== 'enviando') {
        await db.from('mkt_campanas').update({ estado: 'enviando', updated_at: new Date().toISOString() }).eq('id', campana_id);
      }

      // Procesar un LOTE de pendientes.
      const { data: pendientes } = await db.from('mkt_campana_destinatarios')
        .select('id, email, nombre').eq('campana_id', campana_id).eq('estado', 'pendiente').limit(LOTE);

      const { from, replyTo } = remitente(campana, cfg);
      const bu = baseUrl(req), sec = secretBaja();
      let enviados = 0, fallidos = 0, reintentar = 0;
      const lista = pendientes || [];
      // Tandas de GRUPO en paralelo con pausa entre tandas (throttle anti-429).
      for (let i = 0; i < lista.length; i += GRUPO) {
        await Promise.all(lista.slice(i, i + GRUPO).map(async (d) => {
          const unsub = urlBaja(bu, d.email, tenantId, sec);
          const html = inyectarBaja(renderTemplate(campana.html, { nombre: d.nombre || '', email: d.email }), unsub);
          const { id, error, status } = await resendEnviar({
            apiKey, from, replyTo, to: [d.email], subject: campana.asunto, html, unsubUrl: unsub,
            tags: [{ name: 'campana_id', value: String(campana_id) }],
          });
          if (error) {
            if (status === 429) {
              // Límite de velocidad: NO es fallo real → queda pendiente para reintento.
              reintentar++;
              await db.from('mkt_campana_destinatarios').update({ error: 'rate_limit' }).eq('id', d.id);
            } else {
              fallidos++;
              await db.from('mkt_campana_destinatarios').update({ estado: 'fallido', error: error.slice(0, 300) }).eq('id', d.id);
            }
          } else {
            enviados++;
            await db.from('mkt_campana_destinatarios').update({ estado: 'enviado', resend_email_id: id, enviado_at: new Date().toISOString() }).eq('id', d.id);
          }
        }));
        if (i + GRUPO < lista.length) await sleep(PAUSA_MS);
      }

      // ¿Quedan pendientes?
      const { count: restan } = await db.from('mkt_campana_destinatarios')
        .select('id', { count: 'exact', head: true }).eq('campana_id', campana_id).eq('estado', 'pendiente');
      // Rollup de enviados.
      const { count: totEnv } = await db.from('mkt_campana_destinatarios')
        .select('id', { count: 'exact', head: true }).eq('campana_id', campana_id).in('estado', ['enviado', 'entregado']);
      const done = (restan || 0) === 0;
      await db.from('mkt_campanas').update({
        total_enviados: totEnv || 0,
        ...(done ? { estado: 'enviada', enviada_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', campana_id);

      return res.status(200).json({ ok: true, done, enviados, fallidos, restantes: restan || 0 });
    }

    // ── programadas (cron) ──────────────────────────────────────────────────
    if (action === 'programadas') {
      const ahora = new Date().toISOString();
      const { data: due } = await db.from('mkt_campanas').select('id')
        .eq('estado', 'programada').lte('programada_para', ahora).limit(20);
      return res.status(200).json({ ok: true, listas: (due || []).map((c) => c.id), nota: 'disparar enviar por cada id' });
    }

    return res.status(400).json({ ok: false, error: 'action_desconocida', action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
