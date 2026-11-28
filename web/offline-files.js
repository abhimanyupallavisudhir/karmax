// Offline files, read-only (wiki features/offline-files): the one sync engine
// every app shell runs (phones and desktop alike), behind the console's
// Files UI. It keeps the person's pins and what it knows of them in
// IndexedDB; the bytes are the native TavyaOfflineFiles plugin's, stored by
// their SHA-256 (two pins sharing a file store it once) and downloaded
// natively, never through the bridge as base64.
//
// A pin is (project, view: default or `branch:<name>`, path, file or folder).
// The server never learns what is pinned: one POST /api/offline-files/check
// says which pins changed; a changed folder reads its manifest; only changed
// files download. A newer copy replaces the old one only once every file of
// it is whole (`pending` → `files`), so what was readable stays readable.
//
// The plugin (same on Android, iOS and Electron):
//   download({url, version, size, blob?}) → {hash, size}: GET url with the
//     app's cookies and If-Match: "<version>", to a temp file, checked (size;
//     a Git blob id when `blob` is given), then renamed to its SHA-256.
//     Rejects {code: changed | forbidden | missing | mismatch | space | network | http}.
//   list() → {files: [{hash, size}], bytes, free}
//   remove({hashes}) · wipe()
//   url({hash}) → {url | null}: a URL the page can load the bytes from
//   read({hash, offset, length}) → {data: base64, eof}: ≤ 1 MiB, where there is no URL
//   open({hash, name}) → hands the file to the OS ("Open in…")
(() => {
  const MiB = 1024 * 1024, GiB = 1024 * MiB;
  const CHECK_BATCH = 2_000;
  const DOWNLOADS_AT_ONCE = 2;
  const READ_CHUNK = MiB;
  /** Default limit: phones keep less than computers. */
  const DEFAULT_LIMIT = { phone: 2 * GiB, desktop: 10 * GiB };

  // ── where pins live ───────────────────────────────────────────────────────
  // IndexedDB `tavya-offline`: `pins` (by id) and `meta` (owner, limit, checkedAt).
  function idbStore(name = 'tavya-offline') {
    let opened = null;
    const open = () => opened ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opened = null; reject(request.error); };
    });
    const run = async (store, mode, act) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        let result;
        const request = act(tx.objectStore(store));
        if (request) request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    };
    return {
      allPins: () => run('pins', 'readonly', (store) => store.getAll()),
      putPins: (pins) => run('pins', 'readwrite', (store) => { for (const pin of pins) store.put(pin); }),
      deletePin: (id) => run('pins', 'readwrite', (store) => store.delete(id)),
      getMeta: (key) => run('meta', 'readonly', (store) => store.get(key)),
      putMeta: (key, value) => run('meta', 'readwrite', (store) => store.put(value, key)),
      clear: async () => { await run('pins', 'readwrite', (store) => store.clear()); await run('meta', 'readwrite', (store) => store.clear()); },
    };
  }

  /** The same, in memory (tests). */
  function memoryStore() {
    const pins = new Map(), meta = new Map();
    const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    return {
      allPins: async () => [...pins.values()].map(copy),
      putPins: async (list) => { for (const pin of list) pins.set(pin.id, copy(pin)); },
      deletePin: async (id) => { pins.delete(id); },
      getMeta: async (key) => copy(meta.get(key)),
      putMeta: async (key, value) => { meta.set(key, copy(value)); },
      clear: async () => { pins.clear(); meta.clear(); },
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  const parts = (value) => String(value || '').split('/').filter(Boolean);
  const join = (a, b) => [...parts(a), ...parts(b)].join('/');
  const pinId = (projectId, view, path) => `${projectId}|${view || ''}|${parts(path).join('/')}`;
  const branchOf = (view) => String(view || '').startsWith('branch:') ? String(view).slice(7) : '';
  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = bytes, unit = -1;
    do { amount /= 1024; unit++; } while (amount >= 1024 && unit < units.length - 1);
    return `${amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10} ${units[unit]}`;
  }
  /** A request that never reached the server (offline, DNS, a dropped connection). */
  const unreachable = (error) => !error?.status && (error?.name === 'TypeError' || error?.code === 'network' || /fetch|network|offline/i.test(String(error?.message || '')));

  /**
   * The engine. `plugin`: TavyaOfflineFiles (null: nothing works, `available`
   * is false). `request(path, {method, body})` → parsed JSON or throws an
   * Error with `status` (the console's api()). `origin`: the console's own,
   * for the URLs the plugin downloads.
   */
  function create({ plugin, request, origin, store = idbStore(), now = () => Date.now(), kind = 'phone' } = {}) {
    let pins = null;
    let loading = null;
    let running = null, again = false;
    const updating = new Set();
    const listeners = new Set();
    const state = { checkedAt: 0, error: null, offline: false };
    const emit = () => { for (const listener of listeners) { try { listener(); } catch { /* a listener's own problem */ } } };

    const load = () => pins ? Promise.resolve(pins) : (loading ||= (async () => {
      const [list, checkedAt] = await Promise.all([store.allPins(), store.getMeta('checkedAt')]);
      pins = (list || []).map((pin) => ({ ...pin, state: pin.state === 'updating' ? 'stale' : pin.state }));
      state.checkedAt = checkedAt || 0;
      return pins;
    })().finally(() => { loading = null; }));
    const save = (list) => store.putPins(list.map((pin) => ({ ...pin })));

    const limit = async () => (await store.getMeta('limit')) || DEFAULT_LIMIT[kind] || DEFAULT_LIMIT.phone;

    // Every file each pin holds or is fetching, by version: what is on the device.
    const fileLists = (pin) => [pin.files || [], pin.pending?.files || []];
    function knownVersions() {
      const known = new Map();
      for (const pin of pins) for (const list of fileLists(pin)) for (const file of list) if (file.hash) known.set(file.version, { hash: file.hash, size: file.size });
      return known;
    }
    /** Bytes the pins' copies take: each stored file once. */
    function usedBytes() {
      const seen = new Map();
      for (const pin of pins) for (const list of fileLists(pin)) for (const file of list) if (file.hash) seen.set(file.hash, file.size);
      let total = 0;
      for (const size of seen.values()) total += size;
      return total;
    }

    function manifestPath(projectId, view, path) {
      const branch = branchOf(view);
      return `/api/projects/${encodeURIComponent(projectId)}/files/manifest?path=${encodeURIComponent(parts(path).join('/'))}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
    }
    function rawUrl(pin, file) {
      const branch = branchOf(pin.view);
      return `${origin}/api/projects/${encodeURIComponent(pin.projectId)}/files/raw?path=${encodeURIComponent(join(pin.path, file.path))}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
    }

    // ── pinning ─────────────────────────────────────────────────────────────
    /** What keeping `path` offline takes: its manifest, the bytes not on the
     * device yet, the room left, and whether it fits (else `message`). */
    async function prepare({ projectId, view = '', path }) {
      await load();
      const manifest = await request(manifestPath(projectId, view, path));
      const known = knownVersions();
      const fresh = new Map();
      for (const file of manifest.files) if (!known.has(file.version)) fresh.set(file.version, file.size);
      let needs = 0;
      for (const size of fresh.values()) needs += size;
      const [cap, listed] = await Promise.all([limit(), plugin.list().catch(() => null)]);
      let room = Math.max(0, cap - usedBytes());
      if (typeof listed?.free === 'number') room = Math.min(room, Math.max(0, listed.free));
      const fits = needs <= room;
      return { manifest, needs, room, fits, message: fits ? '' : `Needs ${formatBytes(needs)} · ${formatBytes(room)} free` };
    }

    /** Keep a place offline. `info`: what to show for it (project name, organization, link). */
    async function pin({ projectId, view = '', path, info = {} }, prepared) {
      await load();
      const ready = prepared || await prepare({ projectId, view, path });
      if (!ready.fits) throw Object.assign(new Error(ready.message), { code: 'limit' });
      const id = pinId(projectId, view, path);
      const at = now();
      const record = { id, projectId, view: view || '', path: parts(path).join('/'), kind: ready.manifest.kind, revision: null, files: [],
        pending: { revision: ready.manifest.revision, kind: ready.manifest.kind, files: ready.manifest.files.map((file) => ({ ...file, hash: null })) },
        ...(ready.manifest.kind === 'file' && ready.manifest.files[0]?.data ? { data: true } : {}),
        state: 'stale', reason: null, checkedAt: at, pinnedAt: at, ...info };
      pins = pins.filter((other) => other.id !== id).concat(record);
      await save([record]);
      emit();
      await runExclusive(() => downloadAll());
      return pins.find((other) => other.id === id);
    }

    /** Stop keeping a place: its bytes go at once, unless another pin holds them. */
    async function unpin(id) {
      await load();
      pins = pins.filter((pin) => pin.id !== id);
      await store.deletePin(id);
      emit();
      await collect();
      emit();
    }

    // ── checking and downloading ────────────────────────────────────────────
    /** One sync at a time; asked for while one runs, another follows it. */
    function runExclusive(job) {
      if (running) { again = true; return running; }
      running = (async () => {
        try { await job(); while (again) { again = false; await syncOnce(); } }
        finally { running = null; }
      })();
      return running;
    }
    function sync() { return plugin ? runExclusive(syncOnce) : Promise.resolve(); }

    async function syncOnce() {
      await load();
      // Copies the device no longer has (cleared by the OS) are fetched again.
      const listed = await plugin.list().catch(() => null);
      if (listed) {
        const present = new Set((listed.files || []).map((file) => file.hash));
        for (const pin of pins) for (const list of fileLists(pin)) for (const file of list) if (file.hash && !present.has(file.hash)) file.hash = null;
      }
      if (pins.length) {
        let answers = [];
        try {
          for (let at = 0; at < pins.length; at += CHECK_BATCH) {
            const batch = pins.slice(at, at + CHECK_BATCH);
            const answer = await request('/api/offline-files/check', { method: 'POST', body: JSON.stringify({ pins: batch.map((pin) => ({ projectId: pin.projectId,
              path: pin.path, ...(branchOf(pin.view) ? { branch: branchOf(pin.view) } : {}), revision: pin.pending?.revision ?? pin.revision ?? '' })) }) });
            answers = answers.concat(answer.results.map((result, index) => ({ pin: batch[index], result, checkedAt: answer.checkedAt })));
          }
          state.offline = false;
          state.error = null;
        } catch (error) {
          state.offline = unreachable(error);
          state.error = error;
          for (const pin of pins) if (needsBytes(pin)) pin.state = 'stale';
          emit();
          return;
        }
        const removed = [];
        for (const { pin, result, checkedAt } of answers) {
          pin.checkedAt = checkedAt;
          if (result.status === 'forbidden') { removed.push(pin); continue; }
          if (result.status === 'missing') { pin.state = 'gone'; pin.pending = null; continue; }
          // Not readable now: what it holds stays as it was.
          if (result.status === 'error') { if (needsBytes(pin)) { pin.state = 'stale'; pin.reason = 'failed'; } continue; }
          if (pin.state === 'gone') pin.state = 'stale';
          if (result.status === 'changed') {
            if (result.kind === 'file') pin.pending = { revision: result.revision, kind: 'file',
              files: [{ path: '', size: result.size ?? 0, version: result.revision, ...(pin.data ? { data: true } : {}), hash: null }] };
            else {
              try {
                const manifest = await request(manifestPath(pin.projectId, pin.view, pin.path));
                pin.pending = { revision: manifest.revision, kind: manifest.kind, files: manifest.files.map((file) => ({ ...file, hash: null })) };
              } catch (error) {
                if (error?.status === 404) { pin.state = 'gone'; pin.pending = null; continue; }
                if (error?.status === 403) { removed.push(pin); continue; }
                pin.state = 'stale'; pin.reason = error?.status === 413 ? 'limit' : unreachable(error) ? 'offline' : 'failed';
                continue;
              }
            }
          }
          if (!needsBytes(pin)) { pin.state = 'current'; pin.reason = null; }
        }
        if (removed.length) {
          pins = pins.filter((pin) => !removed.includes(pin));
          for (const pin of removed) await store.deletePin(pin.id);
        }
        state.checkedAt = Math.max(state.checkedAt, ...answers.map((answer) => answer.checkedAt || 0));
        await store.putMeta('checkedAt', state.checkedAt);
        await save(pins);
        emit();
      }
      await downloadAll();
      await collect();
      emit();
    }

    /** A pin waiting for bytes: a newer copy, or files its copy lost. */
    function needsBytes(pin) {
      if (pin.state === 'gone') return false;
      return !!pin.pending || (pin.files || []).some((file) => !file.hash);
    }

    async function downloadAll() {
      const cap = await limit();
      const listed = await plugin.list().catch(() => null);
      let free = typeof listed?.free === 'number' ? listed.free : Infinity;
      for (const pin of pins) {
        if (!needsBytes(pin)) continue;
        // A copy that lost files is fetched again as it was.
        if (!pin.pending) pin.pending = { revision: pin.revision, kind: pin.kind, files: pin.files.map((file) => ({ ...file })) };
        const known = knownVersions();
        for (const file of pin.pending.files) if (!file.hash && known.has(file.version)) file.hash = known.get(file.version).hash;
        const wanted = new Map();
        for (const file of pin.pending.files) if (!file.hash) wanted.set(file.version, file);
        let needs = 0;
        for (const file of wanted.values()) needs += file.size;
        if (usedBytes() + needs > cap || needs > free) { pin.state = 'stale'; pin.reason = 'limit'; await save([pin]); emit(); continue; }
        pin.state = 'updating';
        pin.reason = null;
        updating.add(pin.id);
        emit();
        const failure = await fetchFiles(pin, [...wanted.values()]);
        updating.delete(pin.id);
        if (failure) {
          if (failure.code === 'forbidden') { pins = pins.filter((other) => other !== pin); await store.deletePin(pin.id); emit(); continue; }
          // Newer than the check that asked for it, or gone meanwhile: check again.
          if (failure.code === 'changed' || failure.code === 'missing') again = true;
          if (failure.code === 'network') state.offline = true;
          pin.state = 'stale';
          pin.reason = failure.code === 'space' ? 'limit' : failure.code === 'network' ? 'offline' : 'failed';
          await save([pin]);
          emit();
          continue;
        }
        free -= needs;
        pin.files = pin.pending.files;
        pin.revision = pin.pending.revision;
        pin.kind = pin.pending.kind || pin.kind;
        pin.pending = null;
        pin.state = 'current';
        pin.reason = null;
        await save([pin]);
        emit();
      }
    }

    /** Download each wanted version once; every file of that version gets its hash. */
    async function fetchFiles(pin, wanted) {
      let failure = null;
      let next = 0, done = 0;
      const assign = (version, hash) => { for (const file of pin.pending.files) if (file.version === version) file.hash = hash; };
      const worker = async () => {
        while (!failure && next < wanted.length) {
          const file = wanted[next++];
          try {
            const got = await plugin.download({ url: rawUrl(pin, file), version: file.version, size: file.size,
              ...(file.data ? {} : { blob: file.version }) });
            assign(file.version, got.hash);
            // Progress survives an interruption: saved every so often.
            if (++done % 50 === 0) await save([pin]);
          } catch (error) { failure ||= { code: error?.code || 'failed', message: error?.message || String(error) }; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, wanted.length) }, worker));
      return failure;
    }

    /** Remove bytes no pin holds any more. */
    async function collect() {
      const listed = await plugin.list().catch(() => null);
      if (!listed) return;
      const referenced = new Set();
      for (const pin of pins) for (const list of fileLists(pin)) for (const file of list) if (file.hash) referenced.add(file.hash);
      const unused = (listed.files || []).map((file) => file.hash).filter((hash) => !referenced.has(hash));
      if (unused.length) await plugin.remove({ hashes: unused });
    }

    // ── reading ─────────────────────────────────────────────────────────────
    /** The pin holding `path` of a project's view: the place itself or a pinned folder above it. */
    function covering(projectId, view, path) {
      if (!pins) return null;
      const want = parts(path);
      let best = null;
      for (const pin of pins) {
        if (pin.projectId !== projectId || (pin.view || '') !== (view || '')) continue;
        const at = parts(pin.path);
        if (at.length > want.length || at.some((segment, i) => segment !== want[i])) continue;
        if (pin.kind !== 'directory' && at.length !== want.length) continue;
        if (!best || at.length > parts(best.pin.path).length) best = { pin, sub: want.slice(at.length).join('/'), exact: at.length === want.length };
      }
      return best;
    }

    /** What a pin holds at `sub`, as a Files node: a folder's entries or a file (with its `hash`). */
    function node(pin, sub = '') {
      const files = pin.files || [];
      const inside = parts(sub);
      const prefix = inside.join('/');
      const path = join(pin.path, prefix);
      const exact = files.find((file) => file.path === prefix && file.hash);
      if (exact) return { path, kind: 'file', size: exact.size, version: exact.version, hash: exact.hash };
      const entries = new Map();
      for (const file of files) {
        if (!file.hash) continue;
        const at = parts(file.path);
        if (at.length <= inside.length || inside.some((segment, i) => segment !== at[i])) continue;
        const name = at[inside.length];
        if (at.length === inside.length + 1) entries.set(name, { name, kind: 'file', size: file.size });
        else if (!entries.has(name)) entries.set(name, { name, kind: 'directory' });
      }
      if (!entries.size && inside.length) return null;
      const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
      const rank = (entry) => entry.kind === 'directory' ? 0 : 1;
      return { path, kind: 'directory', entries: [...entries.values()].sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name)) };
    }

    /** A stored file for the page: the plugin's URL for it, else its bytes read
     * (1 MiB at a time) into a Blob with a URL of its own, revoked when the next one is made. */
    let lastObjectUrl = null;
    async function bytes(hash) {
      const direct = await plugin.url?.({ hash }).catch(() => null);
      if (direct?.url) return { url: direct.url };
      const chunks = [];
      for (let offset = 0; ;) {
        const { data, eof } = await plugin.read({ hash, offset, length: READ_CHUNK });
        const chunk = Uint8Array.from(atob(data || ''), (c) => c.charCodeAt(0));
        chunks.push(chunk);
        offset += chunk.length;
        if (eof || !chunk.length) break;
      }
      const blob = new Blob(chunks);
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
      lastObjectUrl = URL.createObjectURL(blob);
      return { url: lastObjectUrl, blob };
    }

    // ── the person ──────────────────────────────────────────────────────────
    /** Forget every pin and its bytes (signing out, another account). */
    async function wipe() {
      pins = [];
      updating.clear();
      state.checkedAt = 0;
      await Promise.all([store.clear(), plugin?.wipe?.().catch(() => {})]);
      emit();
    }
    /** The copies are one person's: another account signing in starts empty. */
    async function ensureOwner(userId) {
      if (!userId) return;
      const owner = await store.getMeta('owner');
      if (owner && owner !== userId) await wipe();
      if (owner !== userId) await store.putMeta('owner', userId);
    }

    async function usage() {
      await load();
      return { used: usedBytes(), limit: await limit() };
    }

    return {
      available: !!plugin, load, prepare, pin, unpin, sync, wipe, ensureOwner, usage, covering, node, bytes,
      setLimit: async (bytes) => { await store.putMeta('limit', bytes); emit(); again = true; return sync(); },
      pins: () => pins || [],
      get: (id) => (pins || []).find((pin) => pin.id === id) || null,
      updating: (id) => updating.has(id),
      // When tavya was last asked: the latest check, or a pin made since.
      status: () => ({ ...state, checkedAt: Math.max(state.checkedAt, ...(pins || []).map((pin) => pin.checkedAt || 0)) }),
      hasPins: async () => (await load()).length > 0,
      open: (hash, name) => plugin.open({ hash, name }),
      on: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      formatBytes,
    };
  }

  globalThis.KarmaxOffline = { create, idbStore, memoryStore, pinId, branchOf, formatBytes, unreachable, DEFAULT_LIMIT };
})();
