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
const SUPABASE_SERVICE_KEY_ENV = process.env.SUPABASE_SERVICE_KEY;

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
  // Auth: aceptamos 3 paths (mismo patrón que packages/pase/api/_cron-auth.js):
  //   1. CRON_BEARER env var del bot (si está seteada y matchea).
  //   2. SUPABASE_SERVICE_KEY env var del bot (si matchea, atajo común).
  //   3. JWT Supabase válido + user role superadmin/dueno/admin. Este
  //      path es el que SIEMPRE funciona: el secret MP_CRON_BEARER de
  //      GitHub contiene un JWT firmado de un service account; lo
  //      validamos pidiéndole a Supabase Auth getUser() + chequeando
  //      el rol del user en la tabla `usuarios`.
  const auth = (req.headers.authorization || req.headers.Authorization || '').replace(/^Bearer /, '');
  let authorized = false;
  if (CRON_BEARER && auth === CRON_BEARER) authorized = true;
  else if (SUPABASE_SERVICE_KEY_ENV && auth === SUPABASE_SERVICE_KEY_ENV) authorized = true;
  else if (auth && process.env.SUPABASE_URL && SUPABASE_SERVICE_KEY_ENV) {
    // Path 3: validar JWT con Supabase Admin
    try {
      const admin = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_KEY_ENV, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: userData, error: userErr } = await admin.auth.getUser(auth);
      if (!userErr && userData?.user) {
        const { data: row } = await admin.from('usuarios')
          .select('rol, activo').eq('auth_id', userData.user.id).maybeSingle();
        if (row && row.activo !== false && ['superadmin', 'dueno', 'admin'].includes(row.rol)) {
          authorized = true;
        }
      }
    } catch (e) {
      console.warn('[notif-cron] JWT validation threw:', e?.message);
    }
  }
  if (!authorized) {
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

  const resultado = { ok: true, procesadas: 0, fallidas: 0, sin_subs: 0, sin_pref: 0 };

  if (pendientes && pendientes.length > 0) {
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
          await db.from('notificaciones_pendientes')
            .update({ enviado_at: new Date().toISOString(), enviado_count: 0, error_msg: 'skipped_by_user_pref' })
            .eq('id', notif.id);
          resultado.sin_pref++;
        } else {
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // F5 Chunk E (2026-06-02): wrapper de crons F5.
  //
  // Las 3 RPCs server (fn_cron_*) consumen filas que matchean su ventana
  // de tiempo + marcan timestamp idempotente + retornan lista. Acá tomamos
  // la lista y disparamos email/push según el caso.
  //
  // Importante: no programar estas RPCs con pg_cron — si pg_cron las llama
  // antes que el wrapper, marca las filas pero no manda email. Sólo este
  // wrapper debe llamarlas (idempotencia natural por timestamp).
  // ═══════════════════════════════════════════════════════════════════════════
  resultado.f5_crons = { recordatorios: 0, resenas: 0, cumples: 0 };

  // 1. Recordatorio reservas 1h antes → push a admins del tenant
  try {
    const { data: reservas } = await db.rpc('fn_cron_recordatorio_reservas');
    for (const r of (reservas || [])) {
      await mandarPushAdminsTenant(db, r.tenant_id, {
        title: `🍽️ Reserva en 1h`,
        body: `${r.cliente_nombre} · ${r.personas} personas · ${formatHora(r.fecha_hora)}`,
        url: `/reservas?focus=${r.reserva_id}`,
        tag: `reserva-${r.reserva_id}`,
      });
      resultado.f5_crons.recordatorios++;
    }
  } catch (e) {
    console.warn('[f5-recordatorios] fail:', e?.message);
  }

  // 2. Solicitar reseñas post-entrega → SKIP por ahora.
  //    La RPC marca el timestamp al consumir las filas. Si la llamamos sin
  //    tener canal email funcionando, las filas quedan marcadas pero el
  //    cliente nunca recibe el link. Mejor no llamarla hasta que email
  //    esté wireado en este endpoint (sub-deuda — necesita SMTP / Resend /
  //    similar configurado en env vars del bot Vercel).
  resultado.f5_crons.resenas = 'SKIPPED — email no configurado en este endpoint';

  // 3. Cupón cumpleaños diario → cupón se crea en DB. El cliente lo verá
  //    al entrar al checkout próximo (la UI consulta cupones activos para
  //    el cliente). Email proactivo es sub-deuda — sin email también
  //    funciona porque el cliente eventualmente entra al menos al menú.
  try {
    const { data: cupones } = await db.rpc('fn_cron_emitir_cupones_cumple');
    resultado.f5_crons.cumples = (cupones || []).length;
  } catch (e) {
    console.warn('[f5-cumples] fail:', e?.message);
  }

  return res.status(200).json(resultado);
}

// Helper: formatea hora corta AR (HH:mm) desde ISO timestamptz
function formatHora(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
  } catch {
    return '';
  }
}

// Helper: manda push web a TODOS los admins suscriptos de un tenant.
// Reusa el patrón de procesarPosibleFuga (filtra por preferencia desactivada,
// limpia subs muertas).
async function mandarPushAdminsTenant(db, tenantId, { title, body, url, tag }) {
  const { data: subs } = await db.from('admin_push_subscriptions')
    .select('endpoint, p256dh, auth, user_id, usuarios!inner(tenant_id, rol)')
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`, { foreignTable: 'usuarios' });

  if (!subs || subs.length === 0) return { sent: 0 };

  const subsAdmins = subs.filter(s =>
    s.usuarios && ['dueno', 'admin', 'superadmin', 'encargado'].includes(s.usuarios.rol),
  );
  if (subsAdmins.length === 0) return { sent: 0 };

  const payload = JSON.stringify({ title, body, url, priority: 'normal', tag });
  let sent = 0;
  const toDelete = [];
  for (const sub of subsAdmins) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) toDelete.push(sub.endpoint);
    }
  }
  if (toDelete.length > 0) {
    await db.from('admin_push_subscriptions').delete().in('endpoint', toDelete);
  }
  return { sent };
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
  if (notif.tipo === 'manager_solicitud_nueva') {
    return procesarSolicitudManager(db, notif);
  }
  // Tipo desconocido → marcar como procesada con error para no loop
  return { ok: true, sent: 0, error: 'unknown_type' };
}

// ─── Solicitud nueva de autorización (sprint 27-may noche) ────────────
// Empleado pidió autorización al dueño para una acción gated. Push al
// celu con deeplink a /aprobar-solicitud/:id.
async function procesarSolicitudManager(db, notif) {
  const p = notif.payload || {};
  const solicitudId = p.solicitud_id;
  const accion = p.accion || 'acción';
  const creador = p.creador_nombre || 'Alguien';
  const context = p.context || {};

  // Texto humano según la acción.
  const ACCION_LABEL = {
    anular_factura: 'anular una factura',
    anular_gasto: 'anular un gasto',
    anular_movimiento: 'anular un movimiento',
    descuento_pos: 'aplicar un descuento',
    merma_robo: 'registrar una merma',
    cortesia: 'dar una cortesía',
  };
  const accionTxt = ACCION_LABEL[accion] || `hacer "${accion}"`;

  // Detalle compacto del contexto, mostrado en el body.
  let detalle = '';
  if (context.factura_nro || context.nro) detalle = ` Fact ${context.factura_nro || context.nro}`;
  if (context.total) detalle += ` $${Math.round(Number(context.total)).toLocaleString('es-AR')}`;
  if (context.proveedor_nombre) detalle += ` · ${context.proveedor_nombre}`;
  if (context.local_nombre) detalle += ` · ${context.local_nombre}`;
  if (context.motivo) detalle += ` · "${context.motivo}"`;

  // Buscar dueño/admins suscriptos del tenant.
  const { data: subs } = await db.from('admin_push_subscriptions')
    .select('endpoint, p256dh, auth, user_id, usuarios!inner(tenant_id, rol)')
    .or(`tenant_id.eq.${notif.tenant_id},tenant_id.is.null`, { foreignTable: 'usuarios' });

  // Filtrar solo dueño/admin (encargado no tiene que aprobarse a sí mismo).
  const subsDueno = (subs || []).filter(s =>
    s.usuarios && ['dueno', 'admin', 'superadmin'].includes(s.usuarios.rol),
  );

  if (subsDueno.length === 0) {
    return { ok: true, sent: 0 };
  }

  // Respetar preferencias del user (default ON).
  const userIds = Array.from(new Set(subsDueno.map(s => s.user_id)));
  const { data: prefsRows } = await db
    .from('notification_preferences')
    .select('user_id, enabled')
    .eq('notification_type', 'manager_solicitud_nueva')
    .in('user_id', userIds);
  const disabled = new Set((prefsRows || []).filter(r => r.enabled === false).map(r => r.user_id));
  const subsToNotify = subsDueno.filter(s => !disabled.has(s.user_id));

  if (subsToNotify.length === 0) {
    return { ok: false, skipped_by_pref: true };
  }

  const payload = JSON.stringify({
    title: `🔐 ${creador} pide autorización`,
    body: `Quiere ${accionTxt}.${detalle}`,
    url: `/aprobar-solicitud/${solicitudId}`,
    priority: 'high',
    tag: `solicitud-${solicitudId}`,
    requireInteraction: true,  // que el push no desaparezca automáticamente
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
