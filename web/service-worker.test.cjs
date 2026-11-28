const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// web/service-worker.js's offline shell (wiki features/offline-files): only an
// app that keeps files offline registers it (`?shell=1`); then the console's
// own files are network-first, the last good copy kept for a start without a
// network. Online the network always wins, so a deploy never hides behind a
// stale console; /api is never touched; a browser's worker proxies nothing.

function worker(scriptUrl, network) {
  const handlers = {};
  const cache = new Map();
  const ctx = vm.createContext({
    URL, Response, Request,
    self: { location: new URL(scriptUrl), addEventListener: (type, run) => { handlers[type] = run; }, skipWaiting() {}, clients: { claim: async () => {} },
      registration: { showNotification: async () => {} } },
    caches: {
      open: async () => ({ put: async (key, response) => { cache.set(key, await response.text()); } }),
      match: async (key) => cache.has(key) ? new Response(cache.get(key)) : undefined,
      delete: async () => { cache.clear(); return true; },
    },
    fetch: async (request) => network(request),
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/service-worker.js`, 'utf8'), ctx);
  const fetchEvent = async (url, mode = 'no-cors') => {
    let answer = null;
    const waits = [];
    handlers.fetch({ request: { url, method: 'GET', mode }, respondWith: (promise) => { answer = promise; }, waitUntil: (promise) => waits.push(promise) });
    if (!answer) return null;
    const response = await answer.catch((error) => ({ failed: error }));
    await Promise.all(waits);
    return response;
  };
  return { fetchEvent, cache };
}

const basic = (body) => Object.assign(new Response(body), {});

test('without the shell (a browser), the worker answers nothing itself', async () => {
  const { fetchEvent } = worker('https://tavya.test/service-worker.js', async () => basic('x'));
  assert.equal(await fetchEvent('https://tavya.test/app.js'), null);
  assert.equal(await fetchEvent('https://tavya.test/acme/site/files', 'navigate'), null);
});

test('in an app: network first, the last good copy kept, and served only without a network', async () => {
  let online = true, version = 'v1';
  const response = (body) => { const r = new Response(body); Object.defineProperty(r, 'type', { value: 'basic' }); return r; };
  const { fetchEvent, cache } = worker('https://tavya.test/service-worker.js?shell=1', async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return response(`app ${version}`);
  });
  assert.equal(await (await fetchEvent('https://tavya.test/app.js')).text(), 'app v1');
  assert.equal(cache.get('/app.js'), 'app v1');
  // A deploy: online, the new console at once (never the kept one).
  version = 'v2';
  assert.equal(await (await fetchEvent('https://tavya.test/app.js')).text(), 'app v2');
  // Every console route is the same page, kept once.
  await fetchEvent('https://tavya.test/acme/site/files/docs', 'navigate');
  assert.equal(cache.get('/__shell__'), 'app v2');
  online = false;
  assert.equal(await (await fetchEvent('https://tavya.test/app.js')).text(), 'app v2');
  assert.equal(await (await fetchEvent('https://tavya.test/acme/other/files', 'navigate')).text(), 'app v2');
  // Nothing kept: the failure stands (the app's own offline page then shows).
  assert.ok((await fetchEvent('https://tavya.test/styles.css')).failed);
  // Never the API, sign-in, or other origins.
  assert.equal(await fetchEvent('https://tavya.test/api/session'), null);
  assert.equal(await fetchEvent('https://tavya.test/oauth/authorize', 'navigate'), null);
  assert.equal(await fetchEvent('https://elsewhere.test/app.js'), null);
  assert.equal(await fetchEvent('https://tavya.test/_capacitor_file_/data/x'), null);
});
