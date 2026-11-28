// TavyaOfflineFiles (wiki features/offline-files): the bytes of the files the
// console keeps offline, under the app's data folder. The console's engine
// (web/offline-files.js) decides what to keep; this only stores, serves and
// forgets bytes, the same interface as the phone apps' plugins:
//   download({url, version, size, blob?}) → {hash, size}
//   list() → {files: [{hash, size}], bytes, free} · remove({hashes}) · wipe()
//   url({hash}) → {url} (tavya-offline://file/<hash>, for the console only)
//   read({hash, offset, length}) → {data: base64, eof} · open({hash, name})
//   saveEdit({id, entry}) · edits() → {edits: [entry]} · dropEdit({id}) ·
//   openEdit({id, name}): the native copy of the outbox of edits made offline
//   (§ Offline edits), in <userData>/offline-edits — beside the bytes, not
//   among them, so wipe() (signing out) never takes an edit not uploaded yet.
// Downloads run here in main with the console session's cookies, so bytes
// never cross the bridge. Each lands in a temp file, is checked (its size, and
// its Git blob id when given), then renamed to its SHA-256, read-only. Two
// pins of the same content share one file.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const SCHEME = 'tavya-offline';
const HASH = /^[0-9a-f]{64}$/;
const READ_MAX = 1024 * 1024;

/** main.cjs calls this before the app is ready: the page may fetch the scheme (and its CSP allows it). */
function registerOfflineScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true, corsEnabled: true } }]);
}

const refuse = (code, message) => { throw { code, message }; };

/**
 * `dir`: where the bytes live (default <userData>/offline-files). `request`:
 * how a download is made (default: Electron's net with the session's cookies).
 */
function createOfflineStore({ dir, origin, request, editsDir = path.join(path.dirname(dir), 'offline-edits') }) {
  const blobs = path.join(dir, 'blobs');
  const temp = path.join(dir, 'tmp');
  const opened = path.join(dir, 'open');
  const blobPath = (hash) => {
    if (!HASH.test(String(hash))) refuse('invalid', 'Not a stored file.');
    return path.join(blobs, hash);
  };
  const ensure = () => { for (const folder of [blobs, temp]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); };

  async function download({ url, version, size, blob } = {}) {
    let target;
    try { target = new URL(String(url)); } catch { refuse('invalid', 'Not a URL.'); }
    // Only the console's own files/raw, with its cookies.
    if (target.origin !== origin || !/^\/api\/projects\/[^/]+\/files\/raw$/.test(target.pathname)) refuse('invalid', 'Not a file of this console.');
    ensure();
    const scratch = path.join(temp, `${crypto.randomBytes(8).toString('hex')}.part`);
    const sha256 = crypto.createHash('sha256');
    // A Git blob id is the SHA-1 of "blob <size>\0" and the bytes.
    const sha1 = blob ? crypto.createHash('sha1').update(`blob ${Number(size)}\0`) : null;
    let received = 0;
    try {
      const response = await request(target.href, { 'if-match': `"${version}"` });
      if (response.status === 412) refuse('changed', 'It changed on tavya meanwhile.');
      if (response.status === 401 || response.status === 403) refuse('forbidden', 'You can’t read this any more.');
      if (response.status === 404) refuse('missing', 'It is not on tavya any more.');
      if (response.status !== 200) refuse('http', `tavya answered ${response.status}.`);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(scratch, { mode: 0o600 });
        out.on('error', reject);
        response.body.on('data', (chunk) => {
          received += chunk.length;
          sha256.update(chunk);
          sha1?.update(chunk);
          if (!out.write(chunk)) { response.body.pause(); out.once('drain', () => response.body.resume()); }
        });
        response.body.on('error', reject);
        response.body.on('end', () => out.end(resolve));
      });
    } catch (error) {
      fs.rmSync(scratch, { force: true });
      if (error && typeof error.code === 'string' && !(error instanceof Error)) throw error;
      if (error?.code === 'ENOSPC') refuse('space', 'This computer is out of space.');
      refuse('network', error?.message || 'The download failed.');
    }
    if (size !== undefined && received !== Number(size)) { fs.rmSync(scratch, { force: true }); refuse('mismatch', `Got ${received} bytes, not ${size}.`); }
    if (sha1 && sha1.digest('hex') !== String(blob)) { fs.rmSync(scratch, { force: true }); refuse('mismatch', 'The download is not the version asked for.'); }
    const hash = sha256.digest('hex');
    const final = blobPath(hash);
    // Read-only; the old copy (another hash) stays readable until the console lets it go.
    if (fs.existsSync(final)) fs.rmSync(scratch, { force: true });
    else { fs.chmodSync(scratch, 0o444); fs.renameSync(scratch, final); }
    return { hash, size: received };
  }

  function list() {
    const files = [];
    let bytes = 0;
    for (const name of fs.existsSync(blobs) ? fs.readdirSync(blobs) : []) {
      if (!HASH.test(name)) continue;
      try { const size = fs.statSync(path.join(blobs, name)).size; files.push({ hash: name, size }); bytes += size; } catch { /* gone meanwhile */ }
    }
    let free;
    try { const stats = fs.statfsSync(fs.existsSync(dir) ? dir : path.dirname(dir)); free = Number(stats.bavail) * Number(stats.bsize); } catch { /* unknown */ }
    return { files, bytes, ...(free !== undefined ? { free } : {}) };
  }

  function remove({ hashes = [] } = {}) {
    for (const hash of hashes) {
      const file = blobPath(hash);
      try { fs.chmodSync(file, 0o600); fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    }
  }

  function wipe() { fs.rmSync(dir, { recursive: true, force: true }); }

  function read({ hash, offset = 0, length = READ_MAX } = {}) {
    const file = blobPath(hash);
    const size = fs.statSync(file).size;
    const start = Math.max(0, Number(offset) || 0);
    const count = Math.max(0, Math.min(READ_MAX, Number(length) || READ_MAX, size - start));
    const buffer = Buffer.alloc(count);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, count, start); } finally { fs.closeSync(fd); }
    return { data: buffer.toString('base64'), eof: start + count >= size };
  }

  /** A copy with its real name (the OS picks an app by it), read-only, for the default app. */
  function copyToOpen({ hash, name }) {
    const source = blobPath(hash);
    const safe = path.basename(String(name || 'file')).replace(/[\0/\\]/g, '_') || 'file';
    fs.rmSync(opened, { recursive: true, force: true });
    const folder = path.join(opened, crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, safe);
    fs.copyFileSync(source, file);
    fs.chmodSync(file, 0o444);
    return file;
  }

  /** The scheme's answer: a stored file, whole or one byte range, to the console only. */
  function serve(requestUrl, headers) {
    const url = new URL(requestUrl);
    const hash = url.pathname.replace(/^\/+/, '');
    const from = headers.get('origin') || (() => { try { return new URL(headers.get('referer') || '').origin; } catch { return ''; } })();
    if (url.host !== 'file' || !HASH.test(hash) || (from && from !== origin)) return new Response('', { status: 403 });
    const file = path.join(blobs, hash);
    let size;
    try { size = fs.statSync(file).size; } catch { return new Response('', { status: 404 }); }
    const cors = { 'access-control-allow-origin': origin, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(headers.get('range') || '');
    if (range && (range[1] || range[2]) && size > 0) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response('', { status: 416, headers: { ...cors, 'content-range': `bytes */${size}` } });
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206,
        headers: { ...cors, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...cors, 'content-length': String(size) } });
  }

  // ── the outbox's native copy: one JSON file per edit, written whole then renamed ──
  const editFile = (id) => path.join(editsDir, `${crypto.createHash('sha256').update(String(id)).digest('hex')}.json`);
  function saveEdit({ id, entry } = {}) {
    if (!id || typeof entry !== 'string') refuse('invalid', 'An edit needs an id and its entry.');
    fs.mkdirSync(editsDir, { recursive: true, mode: 0o700 });
    const scratch = `${editFile(id)}.${crypto.randomBytes(4).toString('hex')}.part`;
    fs.writeFileSync(scratch, entry, { mode: 0o600 });
    fs.renameSync(scratch, editFile(id));
  }
  function edits() {
    const out = [];
    for (const name of fs.existsSync(editsDir) ? fs.readdirSync(editsDir) : []) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      try { out.push(fs.readFileSync(path.join(editsDir, name), 'utf8')); } catch { /* gone meanwhile */ }
    }
    return { edits: out };
  }
  function dropEdit({ id } = {}) { fs.rmSync(editFile(id), { force: true }); }
  /** The edit's content as a named file, for the default app. */
  function editToOpen({ id, name }) {
    const entry = JSON.parse(fs.readFileSync(editFile(id), 'utf8'));
    const safe = path.basename(String(name || entry.name || 'file')).replace(/[\0/\\]/g, '_') || 'file';
    fs.rmSync(opened, { recursive: true, force: true });
    const folder = path.join(opened, crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, safe);
    fs.writeFileSync(file, String(entry.content ?? ''), { mode: 0o600 });
    return file;
  }

  return { download, list, remove, wipe, read, copyToOpen, serve, dir, saveEdit, edits, dropEdit, editToOpen };
}

/** A GET through the console session (its cookies), as {status, body: Readable}. */
function sessionRequest(net, ses) {
  return (url, headers) => new Promise((resolve, reject) => {
    const request = net.request({ url, session: ses, useSessionCookies: true, redirect: 'error' });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    request.on('response', (response) => resolve({ status: response.statusCode, body: response }));
    request.on('error', reject);
    request.end();
  });
}

// main.cjs calls it with {app, origin, session, net, protocol, shell}; without
// them (an old main) there is no plugin, and the console offers nothing.
function offlineFilesPlugin({ app, origin, session, net, shell, dir } = {}) {
  if (!app || !session || !net) return null;
  const store = createOfflineStore({ dir: dir || path.join(app.getPath('userData'), 'offline-files'), origin, request: sessionRequest(net, session) });
  session.protocol.handle(SCHEME, (request) => store.serve(request.url, request.headers));
  return {
    methods: {
      download: async (options) => store.download(options),
      list: async () => store.list(),
      remove: async (options) => { store.remove(options); },
      wipe: async () => { store.wipe(); },
      url: async ({ hash }) => ({ url: HASH.test(String(hash)) ? `${SCHEME}://file/${hash}` : null }),
      read: async (options) => store.read(options),
      open: async (options) => {
        const failure = await shell.openPath(store.copyToOpen(options));
        if (failure) refuse('failed', failure);
      },
      saveEdit: async (options) => { store.saveEdit(options); },
      edits: async () => store.edits(),
      dropEdit: async (options) => { store.dropEdit(options); },
      openEdit: async (options) => {
        const failure = await shell.openPath(store.editToOpen(options));
        if (failure) refuse('failed', failure);
      },
    },
  };
}

module.exports = { offlineFilesPlugin, createOfflineStore, registerOfflineScheme, SCHEME };
