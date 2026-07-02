// Service worker para Bot de Instagram — push notifications + PWA install.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ─── Push notification handler ─────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'IG Bot', body: '', url: '/', priority: 'normal' };
  try {
    if (event.data) {
      data = { ...data, ...event.data.json() };
    }
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    badge: '/icon-bot.svg',
    data: { url: data.url },
    requireInteraction: data.priority === 'critical',
    vibrate: [200, 100, 200, 100, 200],
    tag: data.tag || 'ig-bot-notif',
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
    for (const client of clientList) {
      if (client.url.includes(self.location.host)) {
        await client.focus();
        client.postMessage({ type: 'navigate', url: targetUrl });
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
