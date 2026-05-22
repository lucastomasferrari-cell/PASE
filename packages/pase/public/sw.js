// Service worker para PASE — push notifications + PWA install.
//
// Web Push: cuando el bot IG recibe un DM nuevo, el server invoca webpush
// y el browser muestra la notificación nativa del SO (incluso con app cerrada
// y celular bloqueado, si el browser tiene permiso).

self.addEventListener('install', (event) => {
  // Activar el SW inmediatamente (no esperar a que se cierren las tabs viejas).
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ─── Push notification handler ─────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'PASE', body: '', url: '/', priority: 'normal' };
  try {
    if (event.data) {
      data = { ...data, ...event.data.json() };
    }
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    // icon comentado: SVG da problemas en algunos Android Chrome y la notif
    // falla silenciosamente. Sin icon usa el del manifest (más confiable).
    // icon: '/icon-pwa.svg',
    badge: '/favicon.svg',
    data: { url: data.url, ticket_id: data.ticket_id || null },
    // requireInteraction: la notif se queda hasta que el user la cierra
    // (sin esto Android la oculta en ~10s).
    requireInteraction: data.priority === 'critical',
    // vibrate: pattern explícito en ms — Android lo respeta para todas las
    // notif "high priority". Sin esto puede salir silenciosa.
    vibrate: [200, 100, 200, 100, 200],
    // tag: si llega otra notif del mismo tag mientras la anterior está
    // visible, la reemplaza (no se acumulan 10 notif).
    tag: data.tag || 'pase-notif',
    // renotify: si el tag es el mismo pero hay actualización, vuelve a
    // hacer sonido/vibrar (sin esto, la 2da llegada del mismo tag es silenciosa).
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// ─── Click en la notif → abrir/foco a la URL ───────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Si ya hay una ventana de PASE abierta, focuseamos y navegamos.
    for (const client of clientList) {
      if (client.url.includes(self.location.host)) {
        await client.focus();
        client.postMessage({ type: 'navigate', url: targetUrl });
        return;
      }
    }
    // Sino, abrimos nueva.
    await self.clients.openWindow(targetUrl);
  })());
});
