// Installation support without caching authenticated krmax data or stale app
// code. The browser owns normal HTTP caching (every console asset carries an
// ETag); offline task mutation would be misleading for a live control plane.
//
// The offline shell (wiki features/offline-files): an app that keeps files
// offline registers this worker as `/service-worker.js?shell=1`. Then, and only
// then, the console's own static files (the page, its scripts, styles, fonts
// and icons; never /api) are fetched network-first and the last good copy kept,
// so the app opens without a network into what it keeps offline. Online, the
// network always answers first, so a deploy is never hidden behind a stale console.
const SHELL = new URL(self.location.href).searchParams.has('shell');
const SHELL_CACHE = 'tavya-shell-v1';
// The page itself is the same for every console route: kept once.
const SHELL_PAGE = '/__shell__';
const SHELL_ASSETS = /^\/(?:[\w.-]+\.(?:js|css|webmanifest)|(?:fonts|brand|vendor|media)\/.+)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  // A browser (no offline files) keeps nothing.
  if (!SHELL) await caches.delete(SHELL_CACHE);
  await self.clients.claim();
})()));

function shellKey(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return null;
  if (request.mode === 'navigate') return /^\/(?:api|oauth|share|preview|git|ws|mcp|download|\.well-known|_capacitor)/.test(url.pathname) ? null : SHELL_PAGE;
  return SHELL_ASSETS.test(url.pathname) && !url.pathname.endsWith('.test.cjs') ? url.pathname : null;
}

// Without the shell it deliberately never calls respondWith: proxying every
// request through the worker added a hop to each API call and asset load, and
// browsers skip an empty handler entirely.
self.addEventListener('fetch', (event) => {
  if (!SHELL) return;
  const key = shellKey(event.request);
  if (!key) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(key, copy)).catch(() => {}));
      }
      return response;
    } catch (error) {
      // No network: the last good copy, if there is one.
      const kept = await caches.match(key, { cacheName: SHELL_CACHE });
      if (kept) return kept;
      throw error;
    }
  })());
});

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
