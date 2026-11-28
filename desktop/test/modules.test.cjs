// Unit tests of the main process's modules (no Electron needed): npm test.
// The app itself is driven end to end by tests/desktop-app.electron.test.ts at the repository root.
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { resolveServer, serverFromEnvironment } = require('../src/config.cjs');
const { linkTarget, argvTarget, consolePath } = require('../src/links.cjs');
const { loopbackSignIn } = require('../src/loopback.cjs');
const { Hotkey, validAccelerator, displayAccelerator, defaultAccelerator } = require('../src/hotkey.cjs');
const { autostartEntry, autostartFile, linuxExecutable } = require('../src/autostart.cjs');
const { appImageEntry } = require('../src/appimage.cjs');
const { Updates, updateKind, debDownloadUrl, noRelease } = require('../src/updates.cjs');
const { DeviceToken } = require('../src/device-token.cjs');
const { Bridge } = require('../src/bridge.cjs');
const { Settings } = require('../src/settings.cjs');

const ORIGIN = 'https://tavya.io';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-desktop-'));

test('the console URL is https, or http only for this machine or the local network', () => {
  assert.deepEqual(resolveServer('https://tavya.io'), { url: 'https://tavya.io', origin: 'https://tavya.io' });
  assert.deepEqual(resolveServer('https://tavya.io/'), { url: 'https://tavya.io', origin: 'https://tavya.io' });
  assert.equal(resolveServer('http://127.0.0.1:4173').origin, 'http://127.0.0.1:4173');
  assert.equal(resolveServer('http://192.168.1.20:4173').origin, 'http://192.168.1.20:4173');
  assert.equal(resolveServer('http://[::1]:4173').origin, 'http://[::1]:4173');
  assert.throws(() => resolveServer('http://tavya.io'), /must use https/);
  assert.throws(() => resolveServer('ftp://tavya.io'), /https URL/);
  assert.throws(() => resolveServer('https://me:pw@tavya.io'), /credentials/);
  assert.throws(() => resolveServer('tavya.io'), /absolute URL/);
  assert.equal(serverFromEnvironment({}, {}).url, 'https://tavya.io');
  assert.equal(serverFromEnvironment({}, { url: 'https://tavya.example.com' }).url, 'https://tavya.example.com');
  assert.equal(serverFromEnvironment({ TAVYA_URL: 'http://localhost:4173' }, { url: 'https://tavya.example.com' }).url, 'http://localhost:4173');
});

test('io.tavya.app links open a same-origin console path or Ask, nothing else', () => {
  assert.deepEqual(linkTarget('io.tavya.app://open?path=/acme/tasks/12', ORIGIN),
    { path: '/acme/tasks/12', url: 'io.tavya.app://open?path=/acme/tasks/12', ask: false });
  assert.equal(linkTarget('io.tavya.app://open?path=%2Facme%3Fq%3Dfor%3Ame%23x', ORIGIN).path, '/acme?q=for:me#x');
  assert.equal(linkTarget('io.tavya.app://open', ORIGIN).path, '/');
  assert.equal(linkTarget('io.tavya.app://ask', ORIGIN).ask, true);
  assert.equal(linkTarget('io.tavya.app://ask/', ORIGIN).ask, true);
  assert.equal(linkTarget('io.tavya.app://open?path=//evil.example/x', ORIGIN), null);
  assert.equal(linkTarget('io.tavya.app://open?path=/\\evil.example', ORIGIN), null);
  assert.equal(linkTarget('io.tavya.app://open?path=https://evil.example/', ORIGIN), null);
  assert.equal(linkTarget('io.tavya.app://open?path=javascript:alert(1)', ORIGIN), null);
  assert.equal(linkTarget('io.tavya.app://signed-in?code=x', ORIGIN), null);
  assert.equal(linkTarget('https://tavya.io/acme/tasks/3', ORIGIN).path, '/acme/tasks/3');
  assert.equal(linkTarget('https://evil.example/acme', ORIGIN), null);
  assert.equal(consolePath('/a/../b', ORIGIN), '/b');
  assert.equal(argvTarget(['/opt/tavya/tavya', '--no-sandbox', 'io.tavya.app://open?path=/x'], ORIGIN).path, '/x');
  assert.equal(argvTarget(['/opt/tavya/tavya', '--ask'], ORIGIN).ask, true);
  assert.equal(argvTarget(['/opt/tavya/tavya'], ORIGIN), null);
});

test('sign-in listens once on 127.0.0.1, puts its port in redirect_uri and resolves with the redirect', async () => {
  let opened;
  let returned = false;
  const authorize = `${ORIGIN}/oauth/authorize?client_id=tavya-desktop&redirect_uri=${encodeURIComponent('http://127.0.0.1/signed-in')}&state=s1`;
  const attempt = loopbackSignIn(authorize, { origin: ORIGIN, openExternal: async (url) => { opened = new URL(url); }, onReturn: () => { returned = true; } });
  while (!opened) await new Promise((resolve) => setTimeout(resolve, 5));
  const redirect = new URL(opened.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.pathname, '/signed-in');
  assert.ok(Number(redirect.port) > 0);
  assert.equal(opened.searchParams.get('state'), 's1');
  assert.equal(opened.searchParams.get('client_id'), 'tavya-desktop');
  // Another path is not the callback; the listener stays.
  assert.equal((await fetch(`${redirect.origin}/favicon.ico`)).status, 404);
  const page = await fetch(`${redirect.href}?code=c1&state=s1&iss=${encodeURIComponent(ORIGIN)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Signed in/);
  const { url } = await attempt.promise;
  assert.equal(url, `${redirect.href}?code=c1&state=s1&iss=${encodeURIComponent(ORIGIN)}`);
  assert.equal(returned, true);
  // One-shot: the port is closed.
  await assert.rejects(fetch(`${redirect.href}?code=again`));
});

test('sign-in refuses any URL but the console\'s authorize endpoint, and cancels', async () => {
  const openExternal = async () => { throw new Error('must not open'); };
  await assert.rejects(loopbackSignIn('https://evil.example/oauth/authorize', { origin: ORIGIN, openExternal }).promise, { code: 'invalid' });
  await assert.rejects(loopbackSignIn(`${ORIGIN}/logout`, { origin: ORIGIN, openExternal }).promise, { code: 'invalid' });
  const attempt = loopbackSignIn(`${ORIGIN}/oauth/authorize`, { origin: ORIGIN, openExternal: async () => {} });
  attempt.cancel();
  await assert.rejects(attempt.promise, { code: 'cancelled' });
  const slow = loopbackSignIn(`${ORIGIN}/oauth/authorize`, { origin: ORIGIN, openExternal: async () => {}, timeoutMs: 20 });
  await assert.rejects(slow.promise, { code: 'cancelled', message: /timed out/ });
  const noBrowser = loopbackSignIn(`${ORIGIN}/oauth/authorize`, { origin: ORIGIN, openExternal: async () => { throw new Error('no browser'); } });
  await assert.rejects(noBrowser.promise, { code: 'failed', message: /no browser/ });
});

test('a denied consent still returns to the app, for the console to read the error', async () => {
  let opened;
  const attempt = loopbackSignIn(`${ORIGIN}/oauth/authorize`, { origin: ORIGIN, openExternal: async (url) => { opened = new URL(url); } });
  while (!opened) await new Promise((resolve) => setTimeout(resolve, 5));
  const page = await fetch(`${opened.searchParams.get('redirect_uri')}?error=access_denied&state=s`);
  assert.match(await page.text(), /cancelled/);
  assert.match((await attempt.promise).url, /error=access_denied/);
});

test('shortcuts: valid accelerators, readable labels, plain reasons when they cannot register', () => {
  assert.equal(defaultAccelerator('darwin'), 'Alt+Command+Space');
  assert.equal(defaultAccelerator('linux'), 'Control+Alt+Space');
  for (const ok of ['Control+Alt+Space', 'Alt+Command+Space', 'CommandOrControl+Shift+K', 'F5', 'Super+Plus']) assert.ok(validAccelerator(ok), ok);
  for (const bad of ['', 'Space', 'K', 'Control+', 'Control+Control+K', 'Control+Alt', 'Hyper+K', 'Control+Foo']) assert.ok(!validAccelerator(bad), bad);
  assert.equal(displayAccelerator('Alt+Command+Space', 'darwin'), '⌥⌘Space');
  assert.equal(displayAccelerator('Control+Alt+Space', 'linux'), 'Ctrl+Alt+Space');

  const held = new Set(['Control+Alt+T']);
  const registered = new Map();
  const globalShortcut = {
    register: (accelerator, callback) => { if (held.has(accelerator) || registered.has(accelerator)) return false; registered.set(accelerator, callback); return true; },
    unregister: (accelerator) => registered.delete(accelerator),
  };
  let presses = 0;
  const hotkey = new Hotkey({ globalShortcut, onPress: () => presses++, platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' } });
  assert.deepEqual(hotkey.set('Control+Alt+Space'), { accelerator: 'Control+Alt+Space', registered: true, label: 'Ctrl+Alt+Space', default: 'Control+Alt+Space' });
  registered.get('Control+Alt+Space')();
  assert.equal(presses, 1);
  const taken = hotkey.set('Control+Alt+T');
  assert.equal(taken.registered, false);
  assert.equal(taken.reason, 'Ctrl+Alt+T is taken by another app. Choose another shortcut.');
  assert.ok(!registered.has('Control+Alt+Space'), 'the old shortcut is released');
  const invalid = hotkey.set('K');
  assert.match(invalid.reason, /isn't a shortcut/);
  assert.equal(hotkey.accelerator, 'Control+Alt+T', 'an invalid shortcut changes nothing');
  assert.deepEqual(hotkey.set(''), { accelerator: '', registered: false, label: '', default: 'Control+Alt+Space' });

  const wayland = new Hotkey({ globalShortcut: { register: () => false, unregister() {} }, onPress() {}, platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' }, portal: true });
  assert.match(wayland.set('Control+Alt+Space').reason, /xdg-open io\.tavya\.app:\/\/ask/);
  const noPortal = new Hotkey({ globalShortcut: { register: () => true, unregister() {} }, onPress() {}, platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' }, portal: false });
  const status = noPortal.set('Control+Alt+Space');
  assert.equal(status.registered, false);
  assert.match(status.reason, /only while tavya is in front/);
});

test('launch at login on Linux is an XDG autostart entry that starts in the tray', () => {
  const entry = autostartEntry({ exec: '/home/me/Apps/tavya 1.0.AppImage' });
  assert.match(entry, /^Exec="\/home\/me\/Apps\/tavya 1\.0\.AppImage" --hidden$/m);
  assert.match(autostartEntry({ exec: '/opt/tavya/tavya' }), /^Exec=\/opt\/tavya\/tavya --hidden$/m);
  assert.equal(autostartFile({ XDG_CONFIG_HOME: '/c' }), '/c/autostart/io.tavya.app.desktop');
  assert.equal(linuxExecutable({ APPIMAGE: '/a/t.AppImage' }, '/tmp/.mount/tavya'), '/a/t.AppImage');
  assert.equal(linuxExecutable({}, '/opt/tavya/tavya'), '/opt/tavya/tavya');
  const appImage = appImageEntry({ appImage: '/home/me/tavya.AppImage', icon: '/i.png' });
  assert.match(appImage, /^Exec="\/home\/me\/tavya\.AppImage" %U$/m);
  assert.match(appImage, /^MimeType=x-scheme-handler\/io\.tavya\.app;$/m);
});

test('settings persist across starts', () => {
  const dir = tmp();
  new Settings(dir).set('hotkey', 'Control+Alt+K');
  assert.equal(new Settings(dir).get('hotkey', 'x'), 'Control+Alt+K');
  assert.equal(new Settings(dir).get('missing', 'fallback'), 'fallback');
});

class FakeUpdater extends EventEmitter {
  constructor(result) { super(); this.result = result; this.feed = null; this.installed = 0; }
  setFeedURL(feed) { this.feed = feed; }
  async checkForUpdates() {
    this.emit('checking-for-update');
    const { result } = this;
    if (result instanceof Error) { this.emit('error', result); throw result; }
    if (!result) return this.emit('update-not-available', {});
    this.emit('update-available', { version: result });
    if (this.autoDownload) { this.emit('download-progress', { percent: 50 }); this.emit('update-downloaded', { version: result }); }
  }
  quitAndInstall() { this.installed++; }
}

test('updates: a Mac and an AppImage update themselves, a .deb links the new package, a dev run does not update', async () => {
  assert.equal(updateKind({ packaged: false, platform: 'darwin' }), 'none');
  assert.equal(updateKind({ packaged: true, platform: 'darwin' }), 'self');
  assert.equal(updateKind({ packaged: true, platform: 'linux', env: { APPIMAGE: '/a' } }), 'self');
  assert.equal(updateKind({ packaged: true, platform: 'linux', env: {}, packageType: 'deb' }), 'link');
  assert.equal(updateKind({ packaged: true, platform: 'linux', env: {}, packageType: 'rpm' }), 'none');
  assert.equal(debDownloadUrl(ORIGIN, 'arm64'), 'https://tavya.io/download/desktop/tavya-linux-arm64.deb');

  const seen = [];
  const self = new FakeUpdater('1.2.0');
  const updates = new Updates({ autoUpdater: self, kind: 'self', origin: ORIGIN, current: '1.0.0', onStatus: (status) => seen.push(status.state) });
  assert.deepEqual(self.feed, { provider: 'generic', url: 'https://tavya.io/download/desktop/' });
  assert.equal(self.autoDownload, true);
  assert.deepEqual(await updates.check(), { state: 'ready', version: '1.2.0', current: '1.0.0' });
  assert.deepEqual(seen, ['checking', 'downloading', 'downloading', 'ready']);
  self.result = null;
  assert.equal((await updates.check()).state, 'ready', 'a downloaded update stays ready');
  assert.equal(updates.install(), true);
  assert.equal(self.installed, 1);

  const deb = new FakeUpdater('1.2.0');
  const linked = new Updates({ autoUpdater: deb, kind: 'link', origin: ORIGIN, current: '1.0.0', arch: 'x64' });
  assert.equal(deb.autoDownload, false);
  assert.deepEqual(await linked.check(), { state: 'available', version: '1.2.0', url: 'https://tavya.io/download/desktop/tavya-linux-x64.deb', current: '1.0.0' });
  assert.equal(linked.install(), false);

  const none = new Updates({ autoUpdater: new FakeUpdater(new Error('HttpError: 404 Not Found "method: GET url: https://tavya.io/download/desktop/latest-linux.yml"')),
    kind: 'self', origin: ORIGIN, current: '1.0.0' });
  assert.equal((await none.check()).state, 'none', 'no release yet is not an error');
  const failing = new Updates({ autoUpdater: new FakeUpdater(new Error('net::ERR_INTERNET_DISCONNECTED')), kind: 'self', origin: ORIGIN, current: '1.0.0' });
  assert.equal((await failing.check()).state, 'error');
  assert.deepEqual(new Updates({ autoUpdater: null, kind: 'none', origin: ORIGIN, current: '1.0.0' }).status(), { state: 'unsupported', current: '1.0.0' });
  assert.ok(noRelease(new Error('Cannot find latest-mac.yml in the latest release artifacts')));
});

const fakeSafeStorage = (available = true, backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(String(buffer).replace(/^enc:/, ''), 'base64').toString(),
});

test('the device token is kept encrypted, refreshed one at a time, rotated, and forgotten when the grant is gone', async () => {
  const dir = tmp();
  const calls = [];
  let live = 'tvr_grant_a1.first0123456789abcdef';
  let active = 0;
  const fetcher = async (url, init) => {
    active++;
    assert.equal(active, 1, 'refreshes never overlap');
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    const body = new URLSearchParams(init.body);
    calls.push({ url, grant: body.get('grant_type'), client: body.get('client_id'), token: body.get('refresh_token') });
    if (body.get('refresh_token') !== live) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    live = `tvr_grant_a1.rotated${calls.length}0123456789abcdef`;
    return Response.json({ access_token: `tva_${calls.length}`, refresh_token: live, expires_in: 3600 });
  };
  const token = new DeviceToken({ dir, safeStorage: fakeSafeStorage(), origin: ORIGIN, fetch: fetcher, platform: 'linux' });
  await assert.rejects(token.save('not-a-token'), { code: 'invalid' });
  await assert.rejects(token.save('tva_grant_a1.0123456789abcdef0123'), { code: 'invalid' }, 'an access token is not a device token');
  await token.save('tvr_grant_a1.first0123456789abcdef');
  assert.ok(!fs.readFileSync(token.file, 'utf8').includes('tvr_grant'), 'never stored in plain text');
  const [a, b] = await Promise.all([token.accessToken(), token.accessToken()]);
  assert.equal(a, 'tva_1');
  assert.equal(b, 'tva_1', 'the second waits and reuses the fresh access token');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: 'https://tavya.io/oauth/token', grant: 'refresh_token', client: 'tavya-desktop', token: 'tvr_grant_a1.first0123456789abcdef' });
  token.access = null;
  assert.equal(await token.accessToken(), 'tva_2');
  assert.equal(calls[1].token, 'tvr_grant_a1.rotated10123456789abcdef', 'the rotated token is the one used next');
  live = 'revoked';
  token.access = null;
  assert.equal(await token.accessToken(), null);
  assert.equal(token.has(), false, 'invalid_grant deletes it');
  await token.save('tvr_grant_a1.again0123456789abcdef');
  await token.clear();
  assert.equal(token.has(), false);

  const noKeyring = new DeviceToken({ dir: tmp(), safeStorage: fakeSafeStorage(true, 'basic_text'), origin: ORIGIN, fetch: fetcher, platform: 'linux' });
  assert.equal(await noKeyring.save('tvr_grant_a1.first0123456789abcdef'), false);
  assert.equal(noKeyring.has(), false, 'not kept without a keychain');
});

test('the bridge answers only the console\'s top frame and passes {code, message} rejections through', async () => {
  const bridge = new Bridge({ origin: ORIGIN });
  bridge.register('TavyaDesktop', {
    methods: { setBadge: async ({ count }) => count * 2, fail: async () => { throw { code: 'cancelled', message: 'no' }; }, crash: async () => { throw new Error('boom'); } },
    events: ['open'],
  });
  bridge.register('TavyaOfflineFiles', null);
  const sent = [];
  const sender = { id: 1, isDestroyed: () => false, send: (...args) => sent.push(args) };
  const from = (url, parent = null) => ({ sender, senderFrame: { url, parent } });
  assert.deepEqual(bridge.manifest(), { plugins: { TavyaDesktop: { methods: ['setBadge', 'fail', 'crash'], events: ['open'] } } });
  assert.deepEqual(await bridge.call(from(`${ORIGIN}/acme`), 'TavyaDesktop', 'setBadge', { count: 2 }), { ok: true, value: 4 });
  assert.deepEqual(await bridge.call(from('https://evil.example/'), 'TavyaDesktop', 'setBadge', { count: 2 }), { ok: false, error: { code: 'forbidden', message: 'Not the console.' } });
  assert.equal((await bridge.call(from(`${ORIGIN}/`, {}), 'TavyaDesktop', 'setBadge', {})).error.code, 'forbidden', 'not from a frame inside the console');
  assert.deepEqual(await bridge.call(from(`${ORIGIN}/`), 'TavyaDesktop', 'fail'), { ok: false, error: { code: 'cancelled', message: 'no' } });
  assert.deepEqual(await bridge.call(from(`${ORIGIN}/`), 'TavyaDesktop', 'crash'), { ok: false, error: { code: 'failed', message: 'boom' } });
  assert.equal((await bridge.call(from(`${ORIGIN}/`), 'TavyaDesktop', 'toString')).error.code, 'unimplemented');
  assert.equal((await bridge.call(from(`${ORIGIN}/`), 'TavyaOfflineFiles', 'list')).error.code, 'unimplemented');
  assert.equal(bridge.emit(sender, 'TavyaDesktop', 'open', { path: '/' }), false, 'nothing listens yet');
  bridge.listen(from(`${ORIGIN}/`), 'TavyaDesktop', 'open', true);
  assert.equal(bridge.emit(sender, 'TavyaDesktop', 'open', { path: '/' }), true);
  assert.deepEqual(sent, [['tavya:event', 'TavyaDesktop', 'open', { path: '/' }]]);
  bridge.reset(sender);
  assert.equal(bridge.emit(sender, 'TavyaDesktop', 'open', { path: '/' }), false, 'a new document listens afresh');
});

// ── offline files (src/plugins/offline-files.cjs; wiki features/offline-files) ──
{
  const crypto = require('node:crypto');
  const os = require('node:os');
  const { Readable } = require('node:stream');
  const { createOfflineStore } = require('../src/plugins/offline-files.cjs');
  const ORIGIN = 'https://tavya.test';
  const raw = (file) => `${ORIGIN}/api/projects/p/files/raw?path=${encodeURIComponent(file)}`;
  const gitBlob = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
  const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
  function offlineStore(answers) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-offline-test-'));
    const seen = [];
    const store = createOfflineStore({ dir, origin: ORIGIN, request: async (url, headers) => {
      seen.push({ url, headers });
      const answer = answers[new URL(url).searchParams.get('path')] ?? { status: 404, body: '' };
      return { status: answer.status ?? 200, body: Readable.from([Buffer.from(answer.body)]) };
    } });
    return { dir, store, seen };
  }

  test('offline files: a download is checked, stored once by its SHA-256, read-only, and served to the console only', async () => {
    const text = 'hello offline\n';
    const { dir, store, seen } = offlineStore({ 'a.txt': { body: text }, 'b.txt': { body: text } });
    const got = await store.download({ url: raw('a.txt'), version: gitBlob(text), size: Buffer.byteLength(text), blob: gitBlob(text) });
    assert.deepEqual(got, { hash: sha256(text), size: Buffer.byteLength(text) });
    assert.equal(seen[0].headers['if-match'], `"${gitBlob(text)}"`);
    const file = path.join(dir, 'blobs', got.hash);
    assert.equal(fs.statSync(file).mode & 0o777, 0o444);
    // The same bytes again: one file.
    await store.download({ url: raw('b.txt'), version: 'data-identity', size: Buffer.byteLength(text) });
    assert.deepEqual(store.list().files, [{ hash: got.hash, size: Buffer.byteLength(text) }]);
    assert.equal(typeof store.list().free, 'number');
    assert.deepEqual(store.read({ hash: got.hash, offset: 6, length: 7 }), { data: Buffer.from('offline').toString('base64'), eof: false });
    // The scheme: the console, a range, and nobody else.
    const whole = store.serve(`tavya-offline://file/${got.hash}`, new Headers({ origin: ORIGIN }));
    assert.equal(whole.status, 200);
    assert.equal(await whole.text(), text);
    const part = store.serve(`tavya-offline://file/${got.hash}`, new Headers({ range: 'bytes=0-4' }));
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'hello');
    assert.equal(store.serve(`tavya-offline://file/${got.hash}`, new Headers({ origin: 'https://preview.example' })).status, 403);
    assert.equal(store.serve('tavya-offline://file/../../etc/passwd', new Headers()).status, 403);
    // Open in…: a read-only copy with its real name.
    const copy = store.copyToOpen({ hash: got.hash, name: '../notes.txt' });
    assert.equal(path.basename(copy), 'notes.txt');
    assert.ok(copy.startsWith(path.join(dir, 'open')));
    store.remove({ hashes: [got.hash] });
    assert.deepEqual(store.list().files, []);
    store.wipe();
    assert.equal(fs.existsSync(dir), false);
  });

  test('offline files: wrong bytes, a newer version or no access never become a stored file', async () => {
    const { dir, store } = offlineStore({ 'a.txt': { body: 'actual' }, 'moved.txt': { status: 412, body: '' }, 'gone.txt': { status: 403, body: '' } });
    await assert.rejects(store.download({ url: raw('a.txt'), version: 'v', size: 6, blob: gitBlob('expected') }), { code: 'mismatch' });
    await assert.rejects(store.download({ url: raw('a.txt'), version: 'v', size: 99 }), { code: 'mismatch' });
    await assert.rejects(store.download({ url: raw('moved.txt'), version: 'v', size: 1 }), { code: 'changed' });
    await assert.rejects(store.download({ url: raw('gone.txt'), version: 'v', size: 1 }), { code: 'forbidden' });
    await assert.rejects(store.download({ url: raw('nope.txt'), version: 'v', size: 1 }), { code: 'missing' });
    // Only this console's files/raw.
    await assert.rejects(store.download({ url: 'https://evil.example/api/projects/p/files/raw?path=a', version: 'v', size: 1 }), { code: 'invalid' });
    await assert.rejects(store.download({ url: `${ORIGIN}/api/user/export`, version: 'v', size: 1 }), { code: 'invalid' });
    assert.deepEqual(store.list().files, []);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
    assert.throws(() => store.read({ hash: '../x' }), { code: 'invalid' });
  });

  test('offline edits: the outbox’s copy outlives a wipe of the bytes, and leaves only when dropped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-offline-edits-test-'));
    const store = createOfflineStore({ dir: path.join(root, 'offline-files'), origin: ORIGIN, editsDir: path.join(root, 'offline-edits'), request: async () => ({}) });
    const entry = JSON.stringify({ id: 'p||site/a.md', name: 'a.md', content: 'mine\n', rev: 1 });
    store.saveEdit({ id: 'p||site/a.md', entry });
    store.saveEdit({ id: 'p||site/a.md', entry: entry.replace('"rev":1', '"rev":2') });
    assert.deepEqual(store.edits().edits.map((json) => JSON.parse(json).rev), [2]);
    store.wipe();
    assert.equal(store.edits().edits.length, 1);
    const opened = store.editToOpen({ id: 'p||site/a.md', name: 'a.md' });
    assert.equal(path.basename(opened), 'a.md');
    assert.equal(fs.readFileSync(opened, 'utf8'), 'mine\n');
    assert.ok(!(fs.statSync(path.join(root, 'offline-edits')).mode & 0o077));
    store.dropEdit({ id: 'p||site/a.md' });
    assert.deepEqual(store.edits().edits, []);
    assert.throws(() => store.saveEdit({ id: 'x' }), { code: 'invalid' });
    assert.ok(createOfflineStore({ dir: path.join(root, 'u', 'offline-files'), origin: ORIGIN, request: async () => ({}) }).edits().edits.length === 0);
  });
}
