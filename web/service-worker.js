// Installation support without caching authenticated krmax data or stale app
// code. The browser owns normal HTTP caching (every console asset carries an
// ETag); offline task mutation would be misleading for a live control plane.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// Present for installability only. It deliberately never calls respondWith:
// proxying every request through the worker added a hop to each API call and
// asset load, and browsers skip an empty handler entirely.
self.addEventListener('fetch', () => {});
