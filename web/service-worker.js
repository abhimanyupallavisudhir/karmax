// Installation support without caching authenticated Karmax data or stale app
// code. Every request remains network-first and the browser owns normal HTTP
// caching; offline task mutation would be misleading for a live control plane.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
