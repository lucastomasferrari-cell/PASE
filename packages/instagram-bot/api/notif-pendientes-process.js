// Cron worker: procesa la cola `notificaciones_pendientes` de PASE.
//
// Trigger: GitHub Actions cron cada 5 minutos hace POST acá con
// Bearer del CRON_BEARER. Lee notificaciones pendientes (enviado_at IS NULL),
// manda push web según el tipo, y marca como enviadas.
//
// Tipos soportados:
//   - stock_posible_fuga: cuando un conteo finaliza con pérdida >$5k (trigger
//     SQL en stock_conteos lo inserta automático).
//   - [próximamente] cashbox_negative, daily_closing_summary, etc.
//
// Env vars requeridas:
//   - SUPABASE_URL, SUPABASE_SERVICE_KEY
//   - VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//   - CRON_BEARER (mismo secret usado para los crons MP)

import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@pase.local';
const CRON_BEARER = process.env.CRON_BEARER;

// Máximo de notifs a procesar por invocación. Si la cola se infló mucho,
// el siguiente cron sigue. 50 es un buen compromiso (no timeout en 10s
// de Vercel + suficiente para casos reales).
const MAX_POR_RUN = 50;
// Max retries antes de dar por muerta una notif (la marca enviado_at=
// epoch antiguo + intentos=999 para que NO vuelva a aparecer en pendientes).
const MAX_INTENTOS = 5;

function vapidReady() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  return true;
}

export default async function handler(req, res) {
  // Auth: bearer del cron. Solo GitHub Actions debería invocar este endpoint.
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!CRON_BEARER || auth !== `Bearer ${CRON_BEARER}`) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  if (!vapidReady()) {
    return res.status(500).json({ error: 'VAPID_NOT_CONFIGURED' });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Levanta pendientes ordenadas por antiguedad. Limit defensivo.
  const { data: pendientes, error: pendErr } = await db
    .from('notificaciones_pendientes')
    .select('id, tenant_id, tipo, payload, intentos')
    .is('enviado_at', null)
    .lt('intentos', MAX_INTENTOS)
    .order('created_at', { ascending: true })
    .limit(MAX_POR_RUN);

  if (pendErr) {
    return res.status(500).json({ error: 'FETCH_PENDIENTES_FAILED', detail: pendErr.message });
  }

  if (!pendientes || pendientes.length === 0) {
    return res.status(200).json({ ok: true, procesadas: 0 });
  }

  const resultado = { ok: true, procesadas: 0, fallidas: 0, sin_subs: 0, sin_pref: 0 };

  for (const notif of pendientes) {
    try {
      const r = await procesarNotif(db, notif);
      if (r.ok) {
        await db.from('notificaciones_pendientes')
          .update({ enviado_at: new Date().toISOString(), enviado_count: r.sent ?? 0 })
          .eq('id', notif.id);
        resultado.procesadas++;
        if (r.sent === 0) resultado.sin_subs++;
      } else if (r.skipped_by_pref) {
        // Todos los users del tenant tienen el tipo desactivado → marcar
        // enviada (no reintentar). No es error, es decisión explícita.
        await db.from('notificaciones_pendientes')
          .update({ enviado_at: new Date().toISOString(), enviado_count: 0, error_msg: 'skipped_by_user_pref' })
          .eq('id', notif.id);
        resultado.sin_pref++;
      } else {
        // Falló por error transitorio (network, etc.) → incrementar intentos
        await db.from('notificaciones_pendientes')
          .update({ intentos: notif.intentos + 1, error_msg: r.error ?? 'unknown' })
          .eq('id', notif.id);
        resultado.fallidas++;
      }
    } catch (e) {
      await db.from('notificaciones_pendientes')
        .update({ intentos: notif.intentos + 1, error_msg: String(e?.message || e) })
        .eq('id', notif.id);
      resultado.fallidas++;
    }
  }

  return res.status(200).json(resultado);
}

/**
 * Procesa una notificación según su tipo. Retorna shape:
 *   { ok: true, sent: N }          → mandó push a N devices, marcar enviada
 *   { ok: false, error: "msg" }     → falló, retry
 *   { ok: false, skipped_by_pref }  → todos los users desactivaron → no retry
 */
async function procesarNotif(db, notif) {
  if (notif.tipo === 'stock_posible_fuga') {
    return procesarPosibleFuga(db, notif);
  }
  // Tipo desconocido → marcar como procesada con error para no loop
  return { ok: true, sent: 0, error: 'unknown_type' };
}

async function procesarPosibleFuga(db, notif) {
  const p = notif.payload || {};
  const localNombre = p.local_nombre || 'el local';
  const monto = Math.abs(Number(p.valor_diferencia || 0));
  const ajustes = p.total_ajustes || 0;
  const movsDurante = p.movs_durante_conteo || 0;

  const montoTxt = monto >= 1000
    ? `$${Math.round(monto / 1000)}k`
    : `$${Math.round(monto)}`;

  // Buscar subs de todos los users del tenant. Patrón mismo que push.js
  // del bot IG: superadmin con tenant_id=NULL recibe push de TODOS los tenants.
  const { data: subs } = await db.from('admin_push_subscriptions')
    .select('endpoint, p256dh, auth, user_id, usuarios!inner(tenant_id)')
    .or(`tenant_id.eq.${notif.tenant_id},tenant_id.is.null`, { foreignTable: 'usuarios' });

  if (!subs || subs.length === 0) {
    return { ok: true, sent: 0 };
  }

  // Filtrar por preferencias del user: solo manda a quienes tienen
  // 'stock_posible_fuga' enabled (default ON).
  const userIds = Array.from(new Set(subs.map(s => s.user_id)));
  const { data: prefsRows } = await db
    .from('notification_preferences')
    .select('user_id, enabled')
    .eq('notification_type', 'stock_posible_fuga')
    .in('user_id', userIds);
  const disabled = new Set((prefsRows || []).filter(r => r.enabled === false).map(r => r.user_id));
  const subsToNotify = subs.filter(s => !disabled.has(s.user_id));

  if (subsToNotify.length === 0) {
    return { ok: false, skipped_by_pref: true };
  }

  const body = movsDurante > 0
    ? `Pérdida ${montoTxt} en ${ajustes} ajustes. Hubo ${movsDurante} movs durante el conteo — verificar.`
    : `Pérdida ${montoTxt} en ${ajustes} ajustes. Posible fuga (porcionado, mermas no declaradas, etc.).`;

  const payload = JSON.stringify({
    title: `🚨 Posible fuga en ${localNombre}`,
    body,
    url: `/rentabilidad?tab=stock`,
    priority: 'high',
    tag: `fuga-${p.conteo_id}`,
  });

  let sent = 0;
  const toDelete = [];
  for (const sub of subsToNotify) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        toDelete.push(sub.endpoint);
      }
    }
  }
  if (toDelete.length > 0) {
    await db.from('admin_push_subscriptions').delete().in('endpoint', toDelete);
  }

  return { ok: true, sent };
}
