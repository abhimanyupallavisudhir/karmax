// Installation support without caching authenticated krmax data or stale app
// code. The browser owns normal HTTP caching (every console asset carries an
// ETag); offline task mutation would be misleading for a live control plane.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// Present for installability only. It deliberately never calls respondWith:
// proxying every request through the worker added a hop to each API call and
// asset load, and browsers skip an empty handler entirely.
self.addEventListener('fetch', () => {});

// Web Push (wiki features/push-and-voice): the server sends {title, body, url,
// tag, urgency}, encrypted for this browser. Every push must show a
// notification (userVisibleOnly). The tag is the inbox item's, the same as the
// console's own popup for it, so the two never stack.
self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(message.title || 'tavya', {
    body: message.body || '',
    tag: message.tag || undefined,
    data: { url: sameOrigin(message.url) },
    icon: '/brand/icon-192.png',
    requireInteraction: message.urgency === 'critical',
  }));
});

// Opens only this console's own pages, whatever a payload says.
function sameOrigin(url) {
  try {
    const target = new URL(url || '/inbox', self.location.origin);
    return target.origin === self.location.origin ? target.href : `${self.location.origin}/inbox`;
  } catch { return `${self.location.origin}/inbox`; }
}

// A tap focuses an open console and routes it there in place; with none open, opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameOrigin(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'push-open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
