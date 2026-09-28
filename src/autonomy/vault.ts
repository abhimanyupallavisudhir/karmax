import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireFileLock } from '../util/file-lock.js';

/**
 * A local, file-backed secret vault (SPEC §1, §8.4): the credential broker's
 * storage on every deployment, hosted included. Secrets are encrypted at rest
 * with AES-256-GCM under `KARMAX_VAULT_KEY` when set (hosted requires it),
 * otherwise under a key kept in the vault dir (chmod 600). External password
 * stores are connectors that integrate with it, not replacement backends.
 *
 * Stored values are SECRETS resolved only by the broker; everything else in the
 * system holds opaque handles (pointers), never raw keys.
 */
const CANARY = 'karmax-vault-canary';
/** Not a storable handle, so the canary's ciphertext cannot stand in for an entry. */
const CANARY_HANDLE = '\0canary';
const boundTo = (handle: string) => Buffer.from(`karmax-vault:v2\0${handle}`, 'utf8');
const ENTRY_FILE = /^[a-f0-9]{64}\.json$/;
/** The unbound entries as they were before binding, kept for a manual rollback. */
const PRE_V2 = 'entries.pre-v2';
const PRE_V2_RETENTION_MS = 14 * 86_400_000;

/** An entry `migrate` moved to `entries/quarantine/` because it would not open. */
export interface QuarantinedEntry { file: string; handle?: string; reason: string }

/** Publish `data` at `file` only once it and the rename are on disk. */
function writeDurably(file: string, data: string | Buffer): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  syncDirectory(path.dirname(file));
}
function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const cannotWrite = (error: unknown) => ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException)?.code ?? '');

export class Vault {
  private keyPath: string;
  private dbPath: string;
  private key: Buffer;
  private entriesPath: string;
  private canaryPath: string;
  /** Recorded in the authenticated canary: unbound ciphertext is refused. */
  private bound = false;
  private quarantined: QuarantinedEntry[] = [];
  private reported = new Set<string>();

  constructor(dir: string) {
    // The vault holds encrypted secrets and its key; keep the directory private
    // (0700) so the 0600 files inside aren't reachable via a traversable dir.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.keyPath = path.join(dir, 'vault.key');
    this.dbPath = path.join(dir, 'secrets.json');
    this.key = this.loadOrCreateKey();
    this.entriesPath = path.join(dir, 'entries');
    fs.mkdirSync(this.entriesPath, { recursive: true, mode: 0o700 });
    this.canaryPath = path.join(dir, 'vault.canary');
    this.checkCanary();
  }

  private mismatch(detail = ''): Error {
    return new Error(`the vault key does not open this vault${detail}: KARMAX_VAULT_KEY (or vault.key) `
      + 'differs from the key it was created with; restore the original key');
  }

  /**
   * A known ciphertext under the vault key (AU-27). A wrong `KARMAX_VAULT_KEY`
   * otherwise surfaces only as per-entry authentication failures, while every
   * new secret is quietly written under the wrong key, splitting the vault in
   * two. The canary also records, authenticated, whether the vault is bound,
   * so deleting a file cannot make it accept unbound ciphertext again.
   *
   * Only a well-formed canary that fails authentication refuses the key. A
   * missing one (a vault from before the canary) or a damaged one (a crash, a
   * bad disk) is re-derived from the entries: the key must open most of them,
   * so a key that wrote only a few entries of a split vault is not recorded.
   */
  private checkCanary(): void {
    const recorded = this.readCanary();
    if (recorded !== undefined) { this.bound = recorded; return; }
    let opened = 0, refused = 0, bound = false;
    for (const handle of this.list()) {
      let blob: string | undefined;
      try { blob = this.readEntry(handle); } catch { continue; }
      if (blob === undefined) continue;
      try { this.decrypt(blob, handle); opened++; bound ||= blob.startsWith('v2.'); } catch { refused++; }
    }
    if (refused && opened <= refused) throw this.mismatch(` (it opens ${opened} of ${opened + refused} entries)`);
    // Bound entries mean this vault was bound; its canary was lost, not absent.
    this.bound = bound;
    this.writeCanary();
  }

  /** The recorded bound state, or undefined when there is no usable canary. */
  private readCanary(): boolean | undefined {
    let blob: unknown;
    try { blob = JSON.parse(fs.readFileSync(this.canaryPath, 'utf8')).blob; } catch { return undefined; }
    const parts = typeof blob === 'string' ? blob.split('.') : [];
    if (parts.length !== 4 || parts[0] !== 'v2' || Buffer.from(parts[1]!, 'base64').length !== 12
      || Buffer.from(parts[2]!, 'base64').length !== 16) return undefined;
    let state: { canary?: string; bound?: unknown };
    try { state = JSON.parse(this.decrypt(blob as string, CANARY_HANDLE)); } catch { throw this.mismatch(); }
    if (state?.canary !== CANARY) throw this.mismatch();
    return state.bound === true;
  }

  /** Best effort: a vault opened read-only (a restore drill) is checked, not recorded. */
  private writeCanary(): void {
    const blob = this.encrypt(JSON.stringify({ canary: CANARY, bound: this.bound }), CANARY_HANDLE);
    try { writeDurably(this.canaryPath, `${JSON.stringify({ format: CANARY, blob })}\n`); }
    catch (error) { if (!cannotWrite(error)) throw error; }
  }

  /**
   * `KARMAX_VAULT_KEY` overrides the on-disk key so a redeployed instance can
   * reopen an existing vault (a container with no persistent vault dir, a
   * restore onto a new host).
   *
   * INTENDED: the value is hashed, NOT stretched. It is key *material*, not a
   * password — it must be high-entropy random (`openssl rand -base64 32`). A
   * KDF here would only buy resistance to guessing a human-chosen phrase, and
   * would silently change the derived key, making every existing vault
   * undecryptable — so the hash stays. A short value is warned about rather than
   * refused: hosted deployments already fail preflight on it
   * (`config/deployment.ts`), and hard-failing here would lock an existing
   * self-hosted user out of a vault that opens fine.
   */
  private loadOrCreateKey(): Buffer {
    const supplied = process.env.KARMAX_VAULT_KEY;
    if (supplied) {
      if (supplied.length < 32) {
        console.warn(
          '[vault] KARMAX_VAULT_KEY is shorter than 32 characters. It is raw key material, '
          + 'not a password, and is not stretched — generate one with `openssl rand -base64 32`.',
        );
      }
      return crypto.createHash('sha256').update(supplied).digest();
    }
    if (fs.existsSync(this.keyPath)) return fs.readFileSync(this.keyPath);
    const key = crypto.randomBytes(32);
    // Publish only a complete key, without replacing a concurrently created one.
    const temporary = `${this.keyPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, key, { mode: 0o600, flag: 'wx' });
    try {
      try { fs.linkSync(temporary, this.keyPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return fs.readFileSync(this.keyPath);
    } finally { fs.unlinkSync(temporary); }
  }

  private readDb(): Record<string, string> {
    if (!fs.existsSync(this.dbPath)) return {};
    // A corrupt or truncated file must surface, not read as an empty vault: the
    // next `put` would rewrite the file with one secret and lose all the others.
    const raw = fs.readFileSync(this.dbPath, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw new Error(`vault ${this.dbPath} is unreadable (${(error as Error).message}); restore it from a backup`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`vault ${this.dbPath} is not a secret map; restore it from a backup`);
    return parsed as Record<string, string>;
  }
  /** Write-to-temp + fsync + rename so a crash mid-write can never leave a
   *  truncated vault behind. */
  private writeDb(db: Record<string, string>) {
    writeDurably(this.dbPath, JSON.stringify(db));
  }

  /** `v2.` ciphertext authenticates its handle as additional data (AU-27), so
   * a blob copied onto another handle's entry fails to open instead of
   * handing that handle's reader a different secret. */
  private encrypt(plain: string, handle: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(boundTo(handle));
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v2.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }
  /** Unbound (pre-v2) ciphertext opens only until `migrate` has bound the vault. */
  private decrypt(blob: string, handle: string): string {
    const parts = typeof blob === 'string' ? blob.split('.') : [];
    const bound = parts[0] === 'v2';
    if (bound) parts.shift();
    else if (this.bound)
      throw new Error(`vault entry for ${handle} is not bound to its handle; restore it from a backup`);
    const iv = parts.length === 3 ? Buffer.from(parts[0]!, 'base64') : Buffer.alloc(0);
    const tag = parts.length === 3 ? Buffer.from(parts[1]!, 'base64') : Buffer.alloc(0);
    if (iv.length !== 12 || tag.length !== 16) throw new Error('vault entry is corrupt (malformed ciphertext)');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    if (bound) decipher.setAAD(boundTo(handle));
    try {
      return Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`vault entry for ${handle} failed authentication (altered, moved from another handle, or a different key)`);
    }
  }

  private entryPath(handle: string): string {
    return path.join(this.entriesPath, crypto.createHash('sha256').update(handle).digest('hex') + '.json');
  }

  private readEntry(handle: string): string | undefined {
    const file = this.entryPath(handle);
    if (fs.existsSync(file)) {
      let entry: { handle?: unknown; blob?: unknown };
      try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new Error(`vault entry for ${handle} is unreadable; restore it from a backup`); }
      if (entry?.handle !== handle || typeof entry.blob !== 'string') throw new Error('vault entry is corrupt');
      return entry.blob as string;
    }
    if (fs.existsSync(path.join(this.entriesPath, '.migrated'))) return undefined;
    return this.readDb()[handle];
  }

  private history(handle: string): string[] {
    const file = this.entryPath(handle);
    if (!fs.existsSync(file)) return [];
    const previous = JSON.parse(fs.readFileSync(file, 'utf8')).previous ?? [];
    if (!Array.isArray(previous) || previous.length > 5 || previous.some(blob => typeof blob !== 'string'))
      throw new Error('vault history is corrupt');
    return previous;
  }

  private writeEntry(handle: string, blob: string, previous: string[] = []): void {
    writeDurably(this.entryPath(handle), JSON.stringify({ handle, blob, ...(previous.length ? { previous } : {}) }));
  }

  private validateSecret(secret: string): void {
    if (Buffer.byteLength(secret, 'utf8') > 65_536) throw new Error('vault secret exceeds size limit (64 KiB)');
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    const release = process.platform === 'linux'
      ? await acquireFileLock(`${this.dbPath}.lock`) : undefined;
    try {
      const marker = path.join(this.entriesPath, '.migrated');
      if (!fs.existsSync(marker)) {
        // Publish all entries before retiring the legacy map. A crash retries
        // this migration while readers can still use the original ciphertext.
        for (const [handle, blob] of Object.entries(this.readDb())) {
          try { this.decrypt(blob, handle); }
          catch (error) {
            // Keep it for recovery, but one damaged secret must not stop the rest.
            const file = `${crypto.createHash('sha256').update(handle).digest('hex')}.json`;
            writeDurably(path.join(this.entriesPath, file), JSON.stringify({ handle, blob }));
            this.quarantine(file, handle, (error as Error).message);
            continue;
          }
          this.writeEntry(handle, blob);
        }
        this.writeDb({});
        writeDurably(marker, '');
      }
      if (!this.bound) this.bind();
      return operation();
    } finally { release?.(); }
  }

  /**
   * Re-encrypt every entry and its history under its handle (AU-27), then
   * record in the canary that unbound ciphertext is no longer accepted. This
   * is one-way: the previous release cannot read `v2.` entries, so the
   * unbound ones are first copied to `entries.pre-v2/` (deploy/README.md,
   * "Rollback compatibility"). An entry that will not open under the proven
   * key is damaged or foreign; it moves to `entries/quarantine/` instead of
   * refusing every other secret. Rewriting a bound blob is harmless, so a
   * crash midway simply redoes the rest.
   */
  private bind(): void {
    // Another process may have bound the vault while this one waited.
    if (this.readCanary()) { this.bound = true; return; }
    const aside = path.join(path.dirname(this.entriesPath), PRE_V2);
    if (!fs.existsSync(aside)) {
      const staging = `${aside}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.mkdirSync(staging, { mode: 0o700 });
      for (const file of fs.readdirSync(this.entriesPath).filter(file => ENTRY_FILE.test(file))) {
        fs.copyFileSync(path.join(this.entriesPath, file), path.join(staging, file));
        const fd = fs.openSync(path.join(staging, file), 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      syncDirectory(staging);
      fs.renameSync(staging, aside);
      syncDirectory(path.dirname(aside));
    }
    for (const file of fs.readdirSync(this.entriesPath).filter(file => ENTRY_FILE.test(file))) {
      let entry: { handle: string; blob: string; previous?: unknown };
      try {
        entry = JSON.parse(fs.readFileSync(path.join(this.entriesPath, file), 'utf8'));
        if (typeof entry?.handle !== 'string' || typeof entry.blob !== 'string'
          || this.entryPath(entry.handle) !== path.join(this.entriesPath, file)) throw new Error('not a vault entry');
      } catch { this.quarantine(file, undefined, 'unreadable entry file'); continue; }
      const { handle } = entry;
      const rebind = (blob: unknown) => {
        if (typeof blob !== 'string') throw new Error('not a ciphertext');
        const plain = this.decrypt(blob, handle);
        return blob.startsWith('v2.') ? blob : this.encrypt(plain, handle);
      };
      let current: string;
      try { current = rebind(entry.blob); }
      catch (error) { this.quarantine(file, handle, (error as Error).message); continue; }
      const history = Array.isArray(entry.previous) ? entry.previous : [];
      const kept = history.flatMap(blob => { try { return [rebind(blob)]; } catch { return []; } });
      if (kept.length < history.length)
        this.quarantine(file, handle, `${history.length - kept.length} earlier revision(s) would not open`, true);
      this.writeEntry(handle, current, kept);
    }
    this.bound = true;
    this.writeCanary();
  }

  /** Move an entry aside, or copy it when its current secret survives. */
  private quarantine(file: string, handle: string | undefined, reason: string, copy = false): void {
    const dir = path.join(this.entriesPath, 'quarantine');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${file}.${Date.now()}.${crypto.randomUUID()}`);
    if (copy) fs.copyFileSync(path.join(this.entriesPath, file), target);
    else fs.renameSync(path.join(this.entriesPath, file), target);
    syncDirectory(dir);
    syncDirectory(this.entriesPath);
    this.quarantined.push({ file: path.relative(path.dirname(this.entriesPath), target), ...(handle === undefined ? {} : { handle }), reason });
    console.error(`[vault] QUARANTINED ${handle === undefined ? file : `the entry for ${handle}`}: ${reason}. `
      + `It is kept at ${target}; restore it from a backup if it is needed.`);
  }

  /** Bind an existing vault (AU-27) without waiting for its next write.
   * Returns what it quarantined, for the audit log. */
  async migrate(): Promise<{ quarantined: QuarantinedEntry[] }> {
    await this.mutate(() => {
      // The pre-binding copy exists for a rollback. Past the backup retention
      // window it only keeps deleted secrets alive.
      const aside = path.join(path.dirname(this.entriesPath), PRE_V2);
      try { if (Date.now() - fs.statSync(aside).mtimeMs > PRE_V2_RETENTION_MS) fs.rmSync(aside, { recursive: true, force: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
    return { quarantined: this.quarantined.splice(0) };
  }

  /** `history: false` replaces the secret and forgets its earlier revisions,
   * for a value that must not survive in them (a card's CVC, AU-31). */
  async put(handle: string, secret: string, options: { history?: boolean } = {}): Promise<void> {
    this.validateSecret(secret);
    await this.mutate(() => {
      if (options.history === false) return this.writeEntry(handle, this.encrypt(secret, handle));
      const prior = this.readEntry(handle);
      if (prior !== undefined && this.decrypt(prior, handle) === secret) return;
      const previous = prior === undefined ? [] : [prior, ...this.history(handle)].slice(0, 5);
      this.writeEntry(handle, this.encrypt(secret, handle), previous);
    });
  }

  async putIfAbsent(handle: string, secret: string): Promise<void> {
    this.validateSecret(secret);
    await this.mutate(() => { if (!this.has(handle)) this.writeEntry(handle, this.encrypt(secret, handle)); });
  }

  async move(handle: string, nextHandle: string, replacement?: string): Promise<void> {
    if (replacement !== undefined) this.validateSecret(replacement);
    await this.mutate(() => {
      const secret = replacement ?? this.reveal(handle);
      if (secret === undefined) throw new Error(`credential broker: no secret for handle ${handle}`);
      const prior = this.readEntry(handle);
      const previous = prior !== undefined && this.decrypt(prior, handle) !== secret
        ? [prior, ...this.history(handle)].slice(0, 5) : this.history(handle);
      // History is bound to the old handle; carry it across re-encrypted.
      this.writeEntry(nextHandle, this.encrypt(secret, nextHandle),
        previous.map(blob => nextHandle === handle ? blob : this.encrypt(this.decrypt(blob, handle), nextHandle)));
      if (nextHandle !== handle) fs.rmSync(this.entryPath(handle), { force: true });
    });
  }
  has(handle: string): boolean {
    return this.readEntry(handle) !== undefined;
  }
  /** Internal: only the broker should call this. */
  reveal(handle: string, revision = 0): string | undefined {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid vault revision');
    const blob = revision === 0 ? this.readEntry(handle) : this.history(handle)[revision - 1];
    return blob === undefined ? undefined : this.decrypt(blob, handle);
  }
  list(): string[] {
    const handles: string[] = [];
    for (const file of fs.readdirSync(this.entriesPath).filter(file => ENTRY_FILE.test(file))) {
      try {
        const handle = JSON.parse(fs.readFileSync(path.join(this.entriesPath, file), 'utf8')).handle;
        if (typeof handle !== 'string') throw new Error('no handle');
        handles.push(handle);
      } catch {
        // One damaged file (a power loss mid-write) must not hide every other secret.
        if (!this.reported.has(file)) console.error(`[vault] skipping unreadable entry ${path.join(this.entriesPath, file)}`);
        this.reported.add(file);
      }
    }
    if (!fs.existsSync(path.join(this.entriesPath, '.migrated'))) handles.push(...Object.keys(this.readDb()));
    return [...new Set(handles)];
  }
  async delete(handle: string): Promise<void> {
    await this.mutate(() => fs.rmSync(this.entryPath(handle), { force: true }));
  }

  async deleteIfEqual(handle: string, observed: string): Promise<boolean> {
    return this.mutate(() => {
      if (this.reveal(handle) !== observed) return false;
      fs.rmSync(this.entryPath(handle), { force: true });
      return true;
    });
  }
}
