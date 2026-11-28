const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

// The apps' offline-files engine (web/offline-files.js; wiki
// features/offline-files) against a fake server and a fake native plugin:
// pins, shared bytes, refresh, staleness, the storage limit, access loss.

function load() {
  const ctx = vm.createContext({ globalThis: {}, Intl, URL, Blob, atob, btoa, Uint8Array, Map, Set, Promise, JSON, Math, Number, String, Error, Object, Array, setTimeout });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(`${__dirname}/offline-files.js`, 'utf8'), ctx);
  return ctx.KarmaxOffline;
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** A server with files per path (default view), and a plugin storing bytes by hash. */
function world({ free = Infinity } = {}) {
  const tree = new Map(); // path → content
  let revisionSalt = 0;
  const version = (content) => crypto.createHash('sha1').update(`v:${content}`).digest('hex');
  const filesUnder = (place) => [...tree].filter(([file]) => file === place || file.startsWith(`${place}/`) || place === '')
    .map(([file, content]) => ({ path: file === place ? '' : file.slice(place ? place.length + 1 : 0), size: Buffer.byteLength(content), version: version(content), ...(file.startsWith('data/') ? { data: true } : {}) }));
  const manifestOf = (place) => {
    const files = filesUnder(place);
    if (!files.length) throw Object.assign(new Error('Nothing there'), { status: 404 });
    const kind = files.length === 1 && files[0].path === '' ? 'file' : 'directory';
    const revision = kind === 'file' ? files[0].version : sha(JSON.stringify(files) + revisionSalt).slice(0, 40);
    return { path: place, kind, revision, files, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  };
  const server = { forbidden: false, down: false, requests: [], writes: [], refuse: null, merge: null, during: null };
  const request = async (path, opts = {}) => {
    server.requests.push(path);
    if (server.down) throw new TypeError('Failed to fetch');
    if (/\/files\/changes/.test(path)) {
      const { changes } = JSON.parse(opts.body);
      server.writes.push({ path, change: changes[0] });
      if (server.during) { const during = server.during; server.during = null; await during(); }
      if (server.refuse) throw Object.assign(new Error(server.refuse.message), { status: server.refuse.status });
      return { commits: [], ...(changes[0].merge ? { merge: server.merge || { result: 'saved', path: changes[0].path } } : {}) };
    }
    if (path.startsWith('/api/offline-files/check')) {
      const { pins } = JSON.parse(opts.body);
      return { checkedAt: 1000, results: pins.map((pin) => {
        if (server.forbidden) return { status: 'forbidden' };
        try {
          const now = manifestOf(pin.path);
          return now.revision === pin.revision ? { status: 'current' } : { status: 'changed', kind: now.kind, revision: now.revision, ...(now.kind === 'file' ? { size: now.files[0].size } : {}) };
        } catch { return { status: 'missing' }; }
      }) };
    }
    const manifest = /files\/manifest\?path=([^&]*)/.exec(path);
    if (manifest) return manifestOf(decodeURIComponent(manifest[1]));
    throw new Error(`unexpected ${path}`);
  };
  const stored = new Map(); // hash → bytes
  const plugin = {
    downloads: [], failNext: null,
    async download({ url, version: wanted, size, blob }) {
      plugin.downloads.push({ url, blob });
      if (server.down) throw { code: 'network', message: 'offline' };
      if (plugin.failNext) { const code = plugin.failNext; plugin.failNext = null; throw { code, message: code }; }
      const place = decodeURIComponent(/path=([^&]*)/.exec(url)[1]);
      const content = tree.get(place);
      if (content === undefined) throw { code: 'missing' };
      if (version(content) !== wanted) throw { code: 'changed' };
      if (Buffer.byteLength(content) !== size) throw { code: 'mismatch' };
      const hash = sha(content);
      stored.set(hash, content);
      return { hash, size };
    },
    async list() { return { files: [...stored].map(([hash, content]) => ({ hash, size: Buffer.byteLength(content) })), bytes: [...stored.values()].reduce((sum, c) => sum + Buffer.byteLength(c), 0), free }; },
    async remove({ hashes }) { for (const hash of hashes) stored.delete(hash); },
    async wipe() { stored.clear(); },
    async url({ hash }) { return { url: stored.has(hash) ? `local://${hash}` : null }; },
    // The native copy of the outbox.
    nativeEdits: new Map(),
    async saveEdit({ id, entry }) { plugin.nativeEdits.set(id, entry); },
    async edits() { return { edits: [...plugin.nativeEdits.values()] }; },
    async dropEdit({ id }) { plugin.nativeEdits.delete(id); },
  };
  const told = [];
  let store = load().memoryStore();
  const make = () => load().create({ plugin, request, origin: 'https://tavya.test', store, now: () => 500, kind: 'phone', device: () => 'Pixel 8',
    told: (result, edit) => told.push({ result, path: edit.path }) });
  const w = { tree, stored, plugin, server, engine: make(), told, bump: () => { revisionSalt++; },
    // The app starts again; `wiped`: with its WebView's storage cleared.
    restart: (wiped = false) => { if (wiped) store = load().memoryStore(); w.engine = make(); return w.engine; } };
  return w;
}

test('a pinned folder downloads each file once, and two pins share what they have in common', async () => {
  const w = world();
  w.tree.set('site/a.txt', 'alpha').set('site/b/c.txt', 'gamma').set('site/b/same.txt', 'alpha').set('data/raw/x.csv', 'x,y');
  const pinned = await w.engine.pin({ projectId: 'p', path: 'site', info: { name: 'site' } });
  assert.equal(pinned.state, 'current');
  // a.txt and same.txt hold the same bytes: one download, one stored copy.
  assert.equal(w.plugin.downloads.length, 2);
  assert.equal(w.stored.size, 2);
  assert.ok(w.plugin.downloads.every((d) => d.url.startsWith('https://tavya.test/api/projects/p/files/raw?path=site%2F')));
  // Git files are checked against their blob id; data files (content identities) are not.
  assert.ok(w.plugin.downloads.every((d) => typeof d.blob === 'string'));
  await w.engine.pin({ projectId: 'p', path: 'data/raw/x.csv' });
  assert.equal(w.plugin.downloads.at(-1).blob, undefined);
  // A file inside the folder is held by the folder's pin.
  assert.equal(w.engine.covering('p', '', 'site/b/c.txt').pin.id, 'p||site');
  assert.equal(w.engine.covering('p', '', 'site/b/c.txt').sub, 'b/c.txt');
  assert.equal(w.engine.covering('p', 'branch:x', 'site/b/c.txt'), null);
  const listing = w.engine.node(pinned, 'b');
  assert.equal(JSON.stringify(listing.entries.map((e) => [e.name, e.kind])), JSON.stringify([['c.txt', 'file'], ['same.txt', 'file']]));
  assert.equal(w.engine.node(pinned, 'b/c.txt').hash, sha('gamma'));

  // A second pin of a file the folder already holds stores nothing new.
  const before = w.plugin.downloads.length;
  await w.engine.pin({ projectId: 'p', path: 'site/a.txt' });
  assert.equal(w.plugin.downloads.length, before);
  // Unpinning the folder keeps what the file pin still holds, and frees the rest at once.
  await w.engine.unpin('p||site');
  assert.deepEqual([...w.stored.keys()].sort(), [sha('alpha'), sha('x,y')].sort());
  await w.engine.unpin('p||site/a.txt');
  await w.engine.unpin('p||data/raw/x.csv');
  assert.equal(w.stored.size, 0);
});

test('a change downloads only what changed; the old copy stays readable until the new one is whole', async () => {
  const w = world();
  w.tree.set('site/a.txt', 'alpha').set('site/b.txt', 'beta');
  await w.engine.pin({ projectId: 'p', path: 'site' });
  const first = w.plugin.downloads.length;
  w.tree.set('site/b.txt', 'beta 2');
  // The download fails half-way: still the old copy, marked out of date.
  w.plugin.failNext = 'network';
  await w.engine.sync();
  let pin = w.engine.get('p||site');
  assert.equal(pin.state, 'stale');
  assert.equal(w.engine.node(pin, 'b.txt').hash, sha('beta'));
  assert.ok(w.stored.has(sha('beta')));
  // Next time it completes: only b.txt was fetched, and the old bytes are gone.
  await w.engine.sync();
  pin = w.engine.get('p||site');
  assert.equal(pin.state, 'current');
  assert.equal(w.plugin.downloads.length - first, 2);
  assert.ok(w.plugin.downloads.slice(first).every((d) => d.url.endsWith('site%2Fb.txt')));
  assert.equal(w.engine.node(pin, 'b.txt').hash, sha('beta 2'));
  assert.ok(!w.stored.has(sha('beta')));
  assert.equal(pin.checkedAt, 1000);
});

test('offline, nothing is lost: the check fails quietly and what waits for bytes shows as out of date', async () => {
  const w = world();
  w.tree.set('site/a.txt', 'alpha');
  await w.engine.pin({ projectId: 'p', path: 'site' });
  w.server.down = true;
  await w.engine.sync();
  assert.equal(w.engine.status().offline, true);
  assert.equal(w.engine.get('p||site').state, 'current');
  assert.ok(w.stored.has(sha('alpha')));
  w.server.down = false;
  w.tree.set('site/a.txt', 'alpha 2');
  await w.engine.sync();
  assert.equal(w.engine.node(w.engine.get('p||site'), 'a.txt').hash, sha('alpha 2'));
  assert.equal(w.engine.status().offline, false);
});

test('a folder past the limit is refused with what it needs; a refresh past it stays out of date', async () => {
  const w = world();
  w.tree.set('big/a.bin', 'x'.repeat(3000)).set('small/a.txt', 'tiny');
  await w.engine.setLimit(2048);
  const prepared = await w.engine.prepare({ projectId: 'p', path: 'big' });
  assert.equal(prepared.fits, false);
  assert.equal(prepared.message, 'Needs 2.9 KB · 2 KB free');
  await assert.rejects(w.engine.pin({ projectId: 'p', path: 'big' }), /Needs 2.9 KB/);
  await w.engine.pin({ projectId: 'p', path: 'small' });
  w.tree.set('small/a.txt', 'y'.repeat(2500));
  await w.engine.sync();
  const small = w.engine.get('p||small');
  assert.equal(small.state, 'stale');
  assert.equal(small.reason, 'limit');
  assert.equal(w.engine.node(small, 'a.txt').hash, sha('tiny'));
  assert.equal(JSON.stringify(await w.engine.usage()), JSON.stringify({ used: 4, limit: 2048 }));
});

test('a path gone from tavya is kept and marked; access lost removes the copy', async () => {
  const w = world();
  w.tree.set('site/a.txt', 'alpha').set('other/b.txt', 'beta');
  await w.engine.pin({ projectId: 'p', path: 'site' });
  await w.engine.pin({ projectId: 'p', path: 'other' });
  w.tree.delete('site/a.txt');
  await w.engine.sync();
  assert.equal(w.engine.get('p||site').state, 'gone');
  assert.ok(w.stored.has(sha('alpha')));
  w.server.forbidden = true;
  await w.engine.sync();
  assert.equal(w.engine.pins().length, 0);
  assert.equal(w.stored.size, 0);
});

test('the copies are one person’s: another account starts empty', async () => {
  const w = world();
  w.tree.set('site/a.txt', 'alpha');
  await w.engine.ensureOwner('u1');
  await w.engine.pin({ projectId: 'p', path: 'site' });
  await w.engine.ensureOwner('u1');
  assert.equal(w.engine.pins().length, 1);
  await w.engine.ensureOwner('u2');
  assert.equal(w.engine.pins().length, 0);
  assert.equal(w.stored.size, 0);
});

test('a file the device lost is fetched again', async () => {
  const w = world();
  w.tree.set('site/a.txt', 'alpha');
  await w.engine.pin({ projectId: 'p', path: 'site' });
  w.stored.clear();
  await w.engine.sync();
  assert.ok(w.stored.has(sha('alpha')));
  assert.equal(w.engine.get('p||site').state, 'current');
});

test('an edit saved offline waits in both homes, survives a restart and a wiped WebView, and uploads with its base', async () => {
  const w = world();
  await w.engine.ensureOwner('u1');
  w.server.down = true;
  const edit = await w.engine.saveEdit({ projectId: 'p', path: 'site/notes.md', base: 'v1', content: 'mine\n', name: 'notes.md' });
  assert.equal(edit.device, 'Pixel 8');
  await w.engine.sync();
  assert.equal(w.engine.edits().length, 1);
  assert.equal(w.plugin.nativeEdits.size, 1);
  // Started again, and again with IndexedDB gone: the native copy brings it back.
  await w.restart().ensureOwner('u1');
  assert.equal(w.engine.editFor('p', '', 'site/notes.md').content, 'mine\n');
  await w.restart(true).ensureOwner('u1');
  assert.equal(w.engine.editFor('p', '', 'site/notes.md').content, 'mine\n');
  // Edited again offline: one entry, the first base kept.
  await w.engine.saveEdit({ projectId: 'p', path: 'site/notes.md', base: 'v-other', content: 'mine, more\n' });
  assert.equal(w.engine.edits().length, 1);
  assert.equal(w.engine.edits()[0].base, 'v1');
  // Back online: one write with expect = base and merge; then gone from both homes, told once.
  w.server.down = false;
  w.server.merge = { result: 'merged', path: 'site/notes.md' };
  await w.engine.sync();
  assert.equal(w.server.writes.length, 1);
  const { change } = w.server.writes[0];
  assert.equal(change.text, 'mine, more\n');
  assert.equal(change.expect, 'v1');
  assert.equal(change.merge.device, 'Pixel 8');
  assert.equal(change.merge.at, 500);
  assert.equal(w.engine.edits().length, 0);
  assert.equal(w.plugin.nativeEdits.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(w.told)), [{ result: { result: 'merged', path: 'site/notes.md' }, path: 'site/notes.md' }]);
  await w.engine.sync();
  assert.equal(w.told.length, 1);
});

test('an edit tavya refuses stays until it is saved as a copy or discarded', async () => {
  const w = world();
  await w.engine.ensureOwner('u1');
  w.server.refuse = { status: 403, message: 'Changing main needs permission to land work on it (merge-into:main).' };
  await w.engine.saveEdit({ projectId: 'p', view: 'branch:dev', path: 'site/a.md', base: 'v1', content: 'a' });
  await w.engine.saveEdit({ projectId: 'p', path: 'site/b.md', base: 'v1', content: 'b' });
  await w.engine.sync();
  assert.equal(w.engine.edits().map((edit) => edit.state).join(), 'refused,refused');
  assert.match(w.server.writes[0].path, /files\/changes\?branch=dev$/);
  // Tried again at every sync (a right may be granted meanwhile), never dropped.
  await w.restart().ensureOwner('u1');
  await w.engine.sync();
  assert.equal(w.engine.edits().length, 2);
  assert.equal(w.engine.edits()[0].state, 'refused');
  // Save a copy: a new file where one may write.
  w.server.refuse = null;
  w.server.writes.length = 0;
  await w.engine.saveEditCopy('p|branch:dev|site/a.md', 'mine/a.md');
  assert.deepEqual(JSON.parse(JSON.stringify(w.server.writes[0].change)), { op: 'write', path: 'mine/a.md', text: 'a', expect: null });
  await w.engine.discardEdit('p||site/b.md');
  assert.equal(w.engine.edits().length, 0);
  assert.equal(w.plugin.nativeEdits.size, 0);
});

test('edits are their owner’s: kept through sign-out and another account, uploaded only as them', async () => {
  const w = world();
  await w.engine.ensureOwner('u1');
  w.server.down = true;
  await w.engine.saveEdit({ projectId: 'p', path: 'site/a.md', base: 'v1', content: 'a' });
  await w.engine.wipe();
  assert.equal(w.engine.edits().length, 0);
  w.server.down = false;
  await w.engine.ensureOwner('u2');
  await w.engine.sync();
  assert.equal(w.server.writes.length, 0);
  assert.equal(w.engine.edits().length, 0);
  await w.engine.ensureOwner('u1');
  assert.equal(w.engine.edits().length, 1);
  await w.engine.sync();
  assert.equal(w.server.writes.length, 1);
  assert.equal(w.engine.edits().length, 0);
});

test('an edit saved again while the last one uploads is kept for the next upload', async () => {
  const w = world();
  await w.engine.ensureOwner('u1');
  w.server.down = true;
  await w.engine.saveEdit({ projectId: 'p', path: 'site/a.md', base: 'v1', content: 'first' });
  w.server.down = false;
  w.server.during = () => w.engine.saveEdit({ projectId: 'p', path: 'site/a.md', base: 'v1', content: 'second' });
  await w.engine.sync();
  assert.equal(w.engine.edits().length, 1);
  assert.equal(w.engine.edits()[0].content, 'second');
  await w.engine.sync();
  assert.equal(w.server.writes.at(-1).change.text, 'second');
  assert.equal(w.engine.edits().length, 0);
});
