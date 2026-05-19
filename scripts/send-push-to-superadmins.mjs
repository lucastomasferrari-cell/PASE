// Envía Web Push a todos los superadmins suscritos.
// Invocado desde el workflow auto-fix-bug.yml cuando termina una corrida.
//
// Args (process.argv):
//   1. title    — texto principal de la notificación
//   2. body     — texto secundario
//   3. url      — path donde abrir al hacer click (ej. /soporte)
//   4. priority — 'critical' / 'normal' (opcional)
//
// Env requeridas:
//   - VAPID_PUBLIC_KEY
//   - VAPID_PRIVATE_KEY
//   - VAPID_SUBJECT (ej. mailto:lucastomasferrari@gmail.com)
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_KEY
//
// Si una suscripción devuelve 410 Gone (expirada), la borramos de la DB.

import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const [title = 'PASE Admin', body = '', url = '/soporte', priority = 'normal', ticketId = null] = process.argv.slice(2);

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.warn('[push] VAPID keys no configuradas. Saltando envío.');
  process.exit(0);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:noreply@pase.local',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: subs, error } = await sb.from('admin_push_subscriptions').select('*');
if (error) {
  console.error('[push] Error leyendo subs:', error.message);
  process.exit(1);
}
if (!subs || subs.length === 0) {
  console.log('[push] No hay subs activas.');
  process.exit(0);
}

const payload = JSON.stringify({ title, body, url, priority, ticket_id: ticketId });
let sent = 0;
let failed = 0;
const toDelete = [];

for (const sub of subs) {
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      payload,
    );
    sent++;
  } catch (e) {
    failed++;
    console.warn(`[push] Falló envío a ${sub.device_label || sub.endpoint.slice(0, 60)}: ${e.statusCode || e.message}`);
    // 410 Gone o 404 Not Found = la subscripción ya no existe del lado del navegador.
    if (e.statusCode === 410 || e.statusCode === 404) {
      toDelete.push(sub.endpoint);
    }
  }
}

if (toDelete.length > 0) {
  console.log(`[push] Borrando ${toDelete.length} suscripciones expiradas.`);
  await sb.from('admin_push_subscriptions').delete().in('endpoint', toDelete);
}

console.log(`[push] ${sent} enviadas, ${failed} fallidas.`);
