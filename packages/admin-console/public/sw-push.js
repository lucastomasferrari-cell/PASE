// Service worker addon: handler de Web Push.
// Workbox (generado por vite-plugin-pwa) hace importScripts('/sw-push.js')
// según la config en vite.config.ts.

self.addEventListener('push', (event) => {
  const data = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return { title: 'PASE Admin', body: event.data ? event.data.text() : '' };
    }
  })();

  const title = data.title || 'PASE Admin Console';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: {
      url: data.url || '/soporte',
      ticket_id: data.ticket_id,
    },
    tag: data.tag || 'pase-admin',         // reemplaza notif previa con mismo tag
    requireInteraction: data.priority === 'critical',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/soporte';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      // Si hay tab abierta del admin console, le hacemos focus + navigate.
      for (const client of clientsArr) {
        if (client.url.includes('/admin') || client.url.includes(self.location.origin)) {
          client.focus();
          if ('navigate' in client) {
            return client.navigate(url);
          }
          return;
        }
      }
      // Si no hay tab abierta, abrimos una nueva.
      return self.clients.openWindow(url);
    })
  );
});
