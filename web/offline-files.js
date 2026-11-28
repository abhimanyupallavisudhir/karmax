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
//
// Offline edits (§ Offline edits): a text file saved while tavya can't be
// reached goes into an outbox, one entry per file {id, owner, projectId,
// view, path, base (the version it started from), content, device, at},
// kept in IndexedDB (`edits`) and, so a wipe of the WebView's storage can't
// lose it, in the plugin's own store:
//   saveEdit({id, entry: JSON}) · edits() → {edits: [JSON]} · dropEdit({id})
//   openEdit({id, name}) → hands the edit to the OS (phones: "Open in…")
// Every sync first uploads the outbox: one files/changes write with `expect`
// = base and `merge`, which the server saves, merges line by line, or keeps
// beside the file under a name saying whose and when. An entry leaves only by
// an upload or an explicit Discard: offline, refused (no write right) or
// failing, it stays and is tried again at the next sync. Signing out or
// another account leaves the outbox alone: it is its owner's, uploaded when
// they sign in again, and nobody else sees it.
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
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: 'id' });
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
      // The outbox is not cleared with the pins: only an upload or a Discard removes an edit.
      clear: async () => { await run('pins', 'readwrite', (store) => store.clear()); await run('meta', 'readwrite', (store) => store.clear()); },
      allEdits: () => run('edits', 'readonly', (store) => store.getAll()),
      putEdit: (edit) => run('edits', 'readwrite', (store) => { store.put(edit); }),
      deleteEdit: (id) => run('edits', 'readwrite', (store) => store.delete(id)),
    };
  }

  /** The same, in memory (tests). */
  function memoryStore() {
    const pins = new Map(), meta = new Map(), edits = new Map();
    const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    return {
      allEdits: async () => [...edits.values()].map(copy),
      putEdit: async (edit) => { edits.set(edit.id, copy(edit)); },
      deleteEdit: async (id) => { edits.delete(id); },
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
  function create({ plugin, request, origin, store = idbStore(), now = () => Date.now(), kind = 'phone', device = () => '', told = () => {} } = {}) {
    let pins = null;
    let loading = null;
    let running = null, again = false;
    const updating = new Set();
    const listeners = new Set();
    const state = { checkedAt: 0, error: null, offline: false };
    const emit = () => { for (const listener of listeners) { try { listener(); } catch { /* a listener's own problem */ } } };

    let edits = [];
    let owner = null;
    const load = () => pins ? Promise.resolve(pins) : (loading ||= (async () => {
      const [list, checkedAt, known] = await Promise.all([store.allPins(), store.getMeta('checkedAt'), store.getMeta('owner')]);
      owner ||= known || null;
      edits = await loadEdits();
      pins = (list || []).map((pin) => ({ ...pin, state: pin.state === 'updating' ? 'stale' : pin.state }));
      state.checkedAt = checkedAt || 0;
      return pins;
    })().finally(() => { loading = null; }));
    // The outbox from both of its homes: what one lost (a cleared WebView), the other gives back.
    async function loadEdits() {
      let local = [];
      try { local = (await store.allEdits?.()) || []; } catch { /* IndexedDB unusable: the plugin's copy still counts */ }
      const native = typeof plugin?.edits === 'function' ? await plugin.edits().then((answer) => (answer?.edits || []).map((json) => {
        try { return typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
      }).filter((edit) => edit?.id), () => null) : null;
      const byId = new Map();
      for (const edit of local || []) byId.set(edit.id, edit);
      for (const edit of native || []) {
        const have = byId.get(edit.id);
        if (!have || (edit.rev || 0) > (have.rev || 0)) { byId.set(edit.id, edit); await store.putEdit?.(edit).catch?.(() => {}); }
      }
      if (native) {
        const there = new Set(native.map((edit) => edit.id));
        for (const edit of byId.values()) if (!there.has(edit.id)) await plugin.saveEdit({ id: edit.id, entry: JSON.stringify(edit) }).catch(() => {});
      }
      return [...byId.values()].map((edit) => ({ ...edit, state: edit.state === 'uploading' ? 'queued' : edit.state || 'queued' }));
    }
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
      // What was edited offline reaches tavya first: the check then sees the result.
      await uploadEdits();
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

    // ── the outbox: edits made offline ──────────────────────────────────────
    const mine = (edit) => (edit.owner || null) === owner;
    /** Both homes, the plugin's first; throws only when neither kept it. */
    async function keepEdit(edit) {
      const results = await Promise.allSettled([
        typeof plugin?.saveEdit === 'function' ? plugin.saveEdit({ id: edit.id, entry: JSON.stringify(edit) }) : Promise.reject(new Error('no native store')),
        store.putEdit ? store.putEdit(edit) : Promise.reject(new Error('no outbox')),
      ]);
      if (results.every((result) => result.status === 'rejected')) throw results[1].reason || results[0].reason;
    }
    async function dropEdit(id) {
      edits = edits.filter((edit) => edit.id !== id);
      await Promise.allSettled([plugin?.dropEdit?.({ id }), store.deleteEdit?.(id)]);
      emit();
    }
    /** Keep an edit of a file on this device until it reaches tavya. `base`:
     * the version it was opened at (a second edit keeps the first's). */
    async function saveEdit({ projectId, view = '', path, base, content, data, name, projectName }) {
      await load();
      if (typeof base !== 'string' || !base) throw new Error('An offline edit needs the version it started from.');
      const id = pinId(projectId, view, path);
      const prior = edits.find((edit) => edit.id === id);
      const edit = { id, owner, projectId, view: view || '', path: parts(path).join('/'), base: prior?.base || base, content: String(content),
        device: device() || '', at: now(), rev: (prior?.rev || 0) + 1, state: 'queued', reason: null,
        name: name || parts(path).pop() || '', projectName: projectName || prior?.projectName || '', ...(data || prior?.data ? { data: true } : {}) };
      await keepEdit(edit);
      edits = edits.filter((other) => other.id !== id).concat(edit);
      emit();
      return edit;
    }
    function changesPath(edit) {
      const branch = branchOf(edit.view);
      return `/api/projects/${encodeURIComponent(edit.projectId)}/files/changes${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`;
    }
    let uploading = null;
    /** Each of this person's edits, one write each: saved, merged or kept beside (the server decides). */
    function uploadEdits() {
      return uploading ||= (async () => {
        for (const edit of edits.filter(mine)) {
          if (!edits.includes(edit)) continue;
          const at = new Date(edit.at), rev = edit.rev;
          let answer;
          try {
            answer = await request(changesPath(edit), { method: 'POST', body: JSON.stringify({ changes: [{ op: 'write', path: edit.path, text: edit.content,
              expect: edit.base, merge: { ...(edit.device ? { device: edit.device } : {}), at: edit.at, tz: -at.getTimezoneOffset() } }] }) });
          } catch (error) {
            if (unreachable(error)) { state.offline = true; edit.state = 'queued'; edit.reason = null; break; }
            // No right to write here (or the place is gone): it stays, with what can still be done.
            edit.state = error?.status === 403 || error?.status === 404 ? 'refused' : 'failed';
            edit.reason = String(error?.message || '') || null;
            if (edits.includes(edit)) await keepEdit(edit).catch(() => {});
            emit();
            continue;
          }
          // Saved again while it uploaded: the newer edit stays (merged next time with what this one became).
          if (edits.find((other) => other.id === edit.id)?.rev === rev) await dropEdit(edit.id);
          try { told(answer?.merge || { result: 'saved', path: edit.path }, edit); } catch { /* the page's own problem */ }
        }
      })().finally(() => { uploading = null; });
    }
    /** Write the edit as a new file at `path` (where you can write), instead of over the original. */
    async function saveEditCopy(id, path) {
      const edit = edits.find((other) => other.id === id);
      if (!edit) return null;
      const copy = { ...edit, path: parts(path).join('/') };
      const answer = await request(changesPath(copy), { method: 'POST', body: JSON.stringify({ changes: [{ op: 'write', path: copy.path, text: edit.content, expect: null }] }) });
      if (edits.find((other) => other.id === id)?.rev === edit.rev) await dropEdit(id);
      return answer;
    }
    /** The edit of `path` waiting on this device, if any. */
    function editFor(projectId, view, path) {
      return edits.find((edit) => mine(edit) && edit.id === pinId(projectId, view, path)) || null;
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
      // Edits stay (theirs alone): an expired session must never cost an edit.
      owner = null;
      updating.clear();
      state.checkedAt = 0;
      await Promise.all([store.clear(), plugin?.wipe?.().catch(() => {})]);
      emit();
    }
    /** The copies are one person's: another account signing in starts empty. */
    async function ensureOwner(userId) {
      if (!userId) return;
      const known = await store.getMeta('owner');
      if (known && known !== userId) await wipe();
      if (known !== userId) await store.putMeta('owner', userId);
      owner = userId;
      // Edits made before anyone was known (a first offline start) are this person's.
      await load();
      for (const edit of edits) if (!edit.owner) { edit.owner = userId; await keepEdit(edit).catch(() => {}); }
      emit();
    }

    async function usage() {
      await load();
      return { used: usedBytes(), limit: await limit() };
    }

    return {
      available: !!plugin, load, prepare, pin, unpin, sync, wipe, ensureOwner, usage, covering, node, bytes,
      saveEdit, editFor, saveEditCopy, discardEdit: dropEdit, edits: () => edits.filter(mine),
      openEdit: (id, name) => plugin.openEdit({ id, name }), canOpenEdit: () => typeof plugin?.openEdit === 'function',
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
