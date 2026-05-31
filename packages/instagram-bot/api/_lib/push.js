// Helper: enviar notificación push a superadmins suscriptos.
//
// Llamado desde webhook.js cuando llega un DM nuevo del cliente. Le pega a
// todas las suscripciones de admin_push_subscriptions del tenant del bot
// (filtradas por usuarios con rol superadmin).
//
// Cooldown: si ya se envió push de esa conversación en los últimos 5 minutos,
// skip — evita spam si el cliente manda 10 mensajes seguidos.
//
// Env vars requeridas en Vercel del bot:
//   - VAPID_PUBLIC_KEY
//   - VAPID_PRIVATE_KEY
//   - VAPID_SUBJECT (ej: mailto:lucastomasferrari@gmail.com)
//
// Si VAPID no está configurado, hace no-op silencioso (bot sigue funcionando).

import webpush from 'web-push';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@pase.local';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min — anti-spam por conversación

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return true;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  vapidConfigured = true;
  return true;
}

/**
 * Manda push a todos los superadmins suscriptos cuando llega DM nuevo.
 *
 * @param {object} args
 * @param {object} args.db — supabase client (service_role)
 * @param {object} args.cfg — fila ig_config del tenant
 * @param {object} args.cliente — { ig_username, nombre opcional }
 * @param {string} args.texto — texto del mensaje (truncado)
 * @param {object} args.conv — fila ig_conversaciones
 * @returns {Promise<{sent: number, skipped: number}>}
 */
export async function notificarDMNuevo({ db, cfg, cliente, texto, conv }) {
  if (!ensureVapid()) {
    return { sent: 0, skipped: 0, reason: 'vapid_no_config' };
  }

  // Cooldown: si esta conversación notificó en los últimos 5 min, skip.
  const cooldownAt = new Date(Date.now() - COOLDOWN_MS).toISOString();
  const { data: lastNotif } = await db.from('ig_eventos')
    .select('id, created_at')
    .eq('tipo', 'push_enviado')
    .eq('conversacion_id', conv.id)
    .gte('created_at', cooldownAt)
    .order('created_at', { ascending: false })
    .limit(1);

  if (lastNotif && lastNotif.length > 0) {
    return { sent: 0, skipped: 1, reason: 'cooldown' };
  }

  // Buscar suscripciones de cualquier user del tenant del bot.
  // Ajustado 22-may noche por Lucas: sin filtro de rol. Si el user se suscribió
  // (vía el toggle en /mensajeria al que solo accede gente con permiso del
  // módulo) → ya pasó el gate, recibe push.
  // Superadmin con tenant_id=NULL recibe push de TODOS los tenants (Lucas global).
  const { data: subs } = await db.from('admin_push_subscriptions')
    .select('endpoint, p256dh, auth, user_id, usuarios!inner(tenant_id)')
    .or(`tenant_id.eq.${cfg.tenant_id},tenant_id.is.null`, { foreignTable: 'usuarios' });

  if (!subs || subs.length === 0) {
    return { sent: 0, skipped: 0, reason: 'no_subs' };
  }

  // Pedido Lucas 31-may: en el celu se cortaba el title y no se veía quién
  // mandaba. Cambio a formato más compacto:
  //   title: "@username → Cuenta" (el "→ Cuenta" se cae si hay solo una cuenta)
  //   body: "💬 Texto del mensaje" (emoji en body, no en title, así no roba espacio)
  // Multi-cuenta: agrego nombre de la cuenta IG receptora para distinguir
  // (Maneki vs Neko cuando ambas reciben).
  const clienteUser = cliente?.ig_username ? `@${cliente.ig_username}` : 'cliente';
  const clienteNombre = cliente?.nombre || clienteUser;
  const cuentaReceptora = cfg?.ig_username ? ` → @${cfg.ig_username}` : '';
  const textoTruncado = (texto || '[adjunto]').substring(0, 140);
  const payload = JSON.stringify({
    title: `${clienteNombre}${cuentaReceptora}`,
    body: `💬 ${textoTruncado}`,
    url: `/mensajeria?conv=${conv.id}`,
    priority: 'normal',
    tag: `ig-conv-${conv.id}`, // mismo tag → reemplaza notif anterior
  });

  // Filtrar subs cuyo dueño desactivó `ig_dm_new` en /ajustes/notificaciones.
  // Default ON: si el user no tocó la pantalla, recibe push. Solo skip si
  // explícitamente está enabled=false.
  const userIds = Array.from(new Set(subs.map((s) => s.user_id)));
  const { data: prefsRows } = await db
    .from('notification_preferences')
    .select('user_id, enabled')
    .eq('notification_type', 'ig_dm_new')
    .in('user_id', userIds);
  const disabledUserIds = new Set(
    (prefsRows || []).filter((r) => r.enabled === false).map((r) => r.user_id),
  );
  const subsToNotify = subs.filter((s) => !disabledUserIds.has(s.user_id));
  const skippedByPref = subs.length - subsToNotify.length;

  let sent = 0;
  let failed = 0;
  const toDelete = [];

  for (const sub of subsToNotify) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (e) {
      failed++;
      // 410 Gone / 404 = sub muerta del lado del browser
      if (e.statusCode === 410 || e.statusCode === 404) {
        toDelete.push(sub.endpoint);
      }
    }
  }

  // Cleanup subs muertas
  if (toDelete.length > 0) {
    await db.from('admin_push_subscriptions').delete().in('endpoint', toDelete);
  }

  // Log para idempotency del cooldown
  if (sent > 0) {
    await db.from('ig_eventos').insert({
      tenant_id: cfg.tenant_id,
      conversacion_id: conv.id,
      tipo: 'push_enviado',
      payload: { sent, failed, deleted: toDelete.length, skipped_by_pref: skippedByPref },
    });
  }

  return { sent, skipped: failed, skippedByPref, reason: 'ok' };
}
