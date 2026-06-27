// Cron de automatizaciones — corre cada hora (configurar en vercel.json /crons).
// Para cada flow activo: detecta el segmento target del trigger y dispara la
// acción usando los providers (WhatsApp Cloud API / Email). Idempotente:
// registra cada disparo en campana_envios (cuando esté la tabla) para no repetir.
//
// "Solo credenciales" para el envío: respeta cualquier provider sin token
// (devuelve "no configurada" silencioso). Para correr DEBE estar la migración
// 202606250600 aplicada (tabla automatizaciones).
//
// Seguridad: solo Vercel Cron lo invoca. CRON_SECRET en env + header.
// Fix audit 26-jun ALTO-7: el check de CRON_SECRET era condicional
// (`if (secret && auth !== ...)`) — si Lucas olvidaba setear la env var, el
// endpoint quedaba abierto. Ahora si la env var no está, falla 500.

import { createClient } from '@supabase/supabase-js';
import { checkCronAuth } from './_auth.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

function diasAtras(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }

export default async function handler(req, res) {
  if (!checkCronAuth(req, res)) return;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(200).json({ ok: false, configured: false, error: 'Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY.' });
  }
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1) Traer automatizaciones activas.
  const { data: flows, error: e1 } = await db.from('automatizaciones').select('*').eq('activa', true).is('deleted_at', null);
  if (e1) return res.status(200).json({ ok: false, error: e1.message });
  if (!flows?.length) return res.status(200).json({ ok: true, ran: 0, results: [] });

  const results = [];

  for (const flow of flows) {
    const tenantId = flow.tenant_id;
    const params = flow.trigger_params || {};
    const accion = flow.accion_params || {};
    let targets = [];

    // 2) Resolver target según el trigger (consultas mínimas).
    if (flow.trigger_tipo === 'sin_pedir_dias') {
      const dias = Number(params.dias || 60);
      const { data } = await db
        .from('clientes')
        .select('id, nombre, telefono, email')
        .eq('tenant_id', tenantId)
        .gte('total_pedidos', 1)
        .lt('ultimo_pedido_at', diasAtras(dias))
        .is('deleted_at', null)
        .limit(500);
      targets = data || [];
    } else if (flow.trigger_tipo === 'cumpleanos') {
      const hoy = new Date();
      const mm = String(hoy.getMonth() + 1).padStart(2, '0');
      const dd = String(hoy.getDate()).padStart(2, '0');
      const { data } = await db
        .from('clientes')
        .select('id, nombre, telefono, email, fecha_nacimiento')
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .not('fecha_nacimiento', 'is', null)
        .limit(2000);
      targets = (data || []).filter((c) => {
        if (!c.fecha_nacimiento) return false;
        return c.fecha_nacimiento.slice(5) === `${mm}-${dd}`;
      });
    } else if (flow.trigger_tipo === 'primera_compra') {
      const desde = diasAtras(1); // primer pedido en las últimas 24h
      const { data } = await db
        .from('clientes')
        .select('id, nombre, telefono, email')
        .eq('tenant_id', tenantId)
        .eq('total_pedidos', 1)
        .gte('primer_pedido_at', desde)
        .is('deleted_at', null)
        .limit(500);
      targets = data || [];
    } else if (flow.trigger_tipo === 'recurrente') {
      const min = Number(params.min_pedidos || 5);
      const { data } = await db
        .from('clientes')
        .select('id, nombre, telefono, email')
        .eq('tenant_id', tenantId)
        .gte('total_pedidos', min)
        .is('deleted_at', null)
        .limit(500);
      targets = data || [];
    } else if (flow.trigger_tipo === 'post_visita') {
      const horas = Number(params.horas || 3);
      const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();
      const { data } = await db
        .from('clientes')
        .select('id, nombre, telefono, email')
        .eq('tenant_id', tenantId)
        .gte('ultimo_pedido_at', desde)
        .is('deleted_at', null)
        .limit(500);
      targets = data || [];
    }

    // 3) Filtrar los que ya recibieron este flow (idempotencia best-effort vía campana_envios).
    if (targets.length) {
      const { data: prev } = await db
        .from('campana_envios')
        .select('cliente_id')
        .eq('tenant_id', tenantId)
        .in('cliente_id', targets.map((t) => t.id));
      const enviados = new Set((prev || []).map((p) => p.cliente_id));
      // Para flows recurrentes (cumpleaños) habría que limitar por fecha — futuro.
      targets = targets.filter((t) => !enviados.has(t.id));
    }

    // 4) Disparar la acción.
    const canal = accion.canal || 'whatsapp';
    const mensaje = accion.mensaje || '';
    let enviados = 0;
    let errores = 0;

    for (const t of targets) {
      const personal = mensaje.replace(/\{nombre\}/g, (t.nombre || '').split(' ')[0] || 'hola');
      let ok = false; let error = null;
      if (canal === 'whatsapp' && t.telefono) {
        const r = await fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/whatsapp-send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: t.telefono, texto: personal }),
        });
        const data = await r.json();
        ok = !!data.ok; error = data.error;
      } else if (canal === 'email' && t.email) {
        const r = await fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/email-send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: [t.email], asunto: 'Te extrañamos', texto: personal }),
        });
        const data = await r.json();
        ok = !!data.ok; error = data.error;
      }

      // Registrar el envío (idempotencia futura).
      await db.from('campana_envios').insert({
        campana_id: 0, tenant_id: tenantId, cliente_id: t.id, canal,
        destino: canal === 'whatsapp' ? t.telefono : t.email,
        estado: ok ? 'enviado' : 'error', enviado_at: new Date().toISOString(),
      }).select().single().catch(() => null);

      if (ok) enviados++; else errores++;
      if (!ok && /sin credenciales/i.test(error || '')) break; // no insistir si no hay creds
    }

    await db.from('automatizaciones').update({
      ultima_corrida_at: new Date().toISOString(),
      disparos: (flow.disparos || 0) + enviados,
    }).eq('id', flow.id);

    results.push({ flow: flow.nombre, targets: targets.length, enviados, errores });
  }

  return res.status(200).json({ ok: true, ran: flows.length, results });
}
