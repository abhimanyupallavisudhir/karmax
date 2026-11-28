// The phone app's native side for browser tests of offline files (wiki
// features/offline-files): window.Capacitor with TavyaOfflineFiles played by
// an in-memory stand-in that downloads with fetch and keeps bytes by SHA-256
// in localStorage (so they outlive a reload, as a phone's files do), and the
// outbox's native copy under a key of its own. Passed to addInitScript, so it
// must stay self-contained.

declare const localStorage: any;

/** The app's native side as the page sees it (runs in the page). */
export function fakeOfflineApp() {
  const w = globalThis as any;
  const KEY = 'fake-offline-files';
  const stored = (): Record<string, string> => JSON.parse(localStorage.getItem(KEY) || '{}');
  const keep = (map: Record<string, string>) => localStorage.setItem(KEY, JSON.stringify(map));
  const edits = (): Record<string, string> => JSON.parse(localStorage.getItem('fake-offline-edits') || '{}');
  const keepEdits = (map: Record<string, string>) => localStorage.setItem('fake-offline-edits', JSON.stringify(map));
  const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const base64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
  const fail = (code: string, message = code) => { throw { code, message }; };
  w.__offline = { downloads: [] as string[], failNetwork: false, opened: null };
  const TavyaOfflineFiles = {
    async download({ url, version, size, blob }: { url: string; version: string; size: number; blob?: string }) {
      w.__offline.downloads.push(url);
      if (w.__offline.failNetwork) fail('network', 'The Internet connection appears to be offline.');
      let response: Response;
      try { response = await fetch(url, { headers: { 'if-match': `"${version}"` } }); } catch (error) { return fail('network', String(error)); }
      if (response.status === 412) fail('changed');
      if (response.status === 403) fail('forbidden');
      if (response.status === 404) fail('missing');
      if (!response.ok) fail('http');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== size) fail('mismatch');
      if (blob) {
        const head = new TextEncoder().encode(`blob ${size}\0`);
        const all = new Uint8Array(head.length + bytes.length);
        all.set(head); all.set(bytes, head.length);
        if (hex(await crypto.subtle.digest('SHA-1', all)) !== blob) fail('mismatch');
      }
      const hash = hex(await crypto.subtle.digest('SHA-256', bytes));
      const map = stored(); map[hash] = base64(bytes); keep(map);
      return { hash, size: bytes.length };
    },
    async list() {
      const files = Object.entries(stored()).map(([hash, data]) => ({ hash, size: atob(data).length }));
      return { files, bytes: files.reduce((sum, file) => sum + file.size, 0), free: 64 * 1024 ** 3 };
    },
    async remove({ hashes }: { hashes: string[] }) { const map = stored(); for (const hash of hashes) delete map[hash]; keep(map); },
    async wipe() { localStorage.removeItem(KEY); },
    // Like iOS: no local URL, so the page reads the bytes in chunks.
    async url() { return { url: null }; },
    async read({ hash, offset = 0, length = 1 << 20 }: { hash: string; offset?: number; length?: number }) {
      const binary = atob(stored()[hash] ?? '');
      const part = binary.slice(offset, offset + length);
      return { data: btoa(part), eof: offset + part.length >= binary.length };
    },
    async open({ hash, name }: { hash: string; name: string }) { w.__offline.opened = { hash, name }; },
    // The outbox's native copy (§ Offline edits): its own key, which a wipe leaves alone.
    async saveEdit({ id, entry }: { id: string; entry: string }) { const map = edits(); map[id] = entry; keepEdits(map); },
    async edits() { return { edits: Object.values(edits()) }; },
    async dropEdit({ id }: { id: string }) { const map = edits(); delete map[id]; keepEdits(map); },
    async openEdit({ id, name }: { id: string; name: string }) { w.__offline.opened = { edit: id, name }; },
  };
  const Plugins = { TavyaOfflineFiles };
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: (name: string) => name in Plugins, Plugins };
}
