import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireFileLock } from '../util/file-lock.js';

/**
 * A local, file-backed secret vault (SPEC §8.4). This is the pluggable backend
 * behind the credential broker — in production it would be HashiCorp Vault, a
 * cloud secret manager, or 1Password. Secrets are encrypted at rest with
 * AES-256-GCM under a key kept in the vault dir (chmod 600).
 *
 * Stored values are SECRETS resolved only by the broker; everything else in the
 * system holds opaque handles (pointers), never raw keys.
 */
const CANARY = 'karmax-vault-canary';
/** Not a storable handle, so the canary's ciphertext cannot stand in for an entry. */
const CANARY_HANDLE = '\0canary';
const boundTo = (handle: string) => Buffer.from(`karmax-vault:v2\0${handle}`, 'utf8');

export class Vault {
  private keyPath: string;
  private dbPath: string;
  private key: Buffer;
  private entriesPath: string;

  constructor(dir: string) {
    // The vault holds encrypted secrets and its key; keep the directory private
    // (0700) so the 0600 files inside aren't reachable via a traversable dir.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.keyPath = path.join(dir, 'vault.key');
    this.dbPath = path.join(dir, 'secrets.json');
    this.key = this.loadOrCreateKey();
    this.entriesPath = path.join(dir, 'entries');
    fs.mkdirSync(this.entriesPath, { recursive: true, mode: 0o700 });
    this.checkCanary(path.join(dir, 'vault.canary'));
  }

  /**
   * A known ciphertext under the vault key (AU-27). A wrong `KARMAX_VAULT_KEY`
   * otherwise surfaces only as per-entry authentication failures, while every
   * new secret is quietly written under the wrong key, splitting the vault in
   * two. A vault from before the canary is checked against one of its own
   * entries before one is recorded.
   */
  private checkCanary(file: string): void {
    const mismatch = () => new Error('the vault key does not open this vault: KARMAX_VAULT_KEY (or vault.key) '
      + 'differs from the key it was created with; restore the original key');
    if (fs.existsSync(file)) {
      try { if (this.decrypt(fs.readFileSync(file, 'utf8'), CANARY_HANDLE) === CANARY) return; } catch {}
      throw mismatch();
    }
    // One entry that opens proves the key; one damaged entry must not refuse the rest.
    const handles = this.list();
    if (handles.length && !handles.some(handle => {
      try { this.decrypt(this.readEntry(handle)!, handle); return true; } catch { return false; }
    })) throw mismatch();
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, this.encrypt(CANARY, CANARY_HANDLE), { mode: 0o600, flag: 'wx' });
    try {
      try { fs.linkSync(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { fs.unlinkSync(temporary); }
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
  /** Write-to-temp + rename so a crash mid-write can never leave a truncated
   *  vault behind; the mode is applied explicitly because `writeFileSync`'s
   *  `mode` only affects a file it creates. */
  private writeDb(db: Record<string, string>) {
    const tmp = `${this.dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.dbPath);
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
    else if (fs.existsSync(path.join(this.entriesPath, '.bound')))
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
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry.handle !== handle || typeof entry.blob !== 'string') throw new Error('vault entry is corrupt');
      return entry.blob;
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
    const file = this.entryPath(handle);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ handle, blob, ...(previous.length ? { previous } : {}) }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
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
          this.decrypt(blob, handle);
          this.writeEntry(handle, blob);
        }
        this.writeDb({});
        fs.writeFileSync(marker, '', { mode: 0o600 });
      }
      const bound = path.join(this.entriesPath, '.bound');
      if (!fs.existsSync(bound)) {
        // Re-encrypt every entry and its history under its handle, then stop
        // accepting unbound ciphertext. Rewriting a bound blob is harmless, so
        // a crash midway simply redoes the rest.
        for (const handle of this.list()) {
          const rebind = (blob: string) => blob.startsWith('v2.') ? blob : this.encrypt(this.decrypt(blob, handle), handle);
          this.writeEntry(handle, rebind(this.readEntry(handle)!), this.history(handle).map(rebind));
        }
        fs.writeFileSync(bound, '', { mode: 0o600 });
      }
      return operation();
    } finally { release?.(); }
  }

  /** Bind an existing vault (AU-27) without waiting for its next write. */
  async migrate(): Promise<void> {
    await this.mutate(() => {});
  }

  async put(handle: string, secret: string): Promise<void> {
    this.validateSecret(secret);
    await this.mutate(() => {
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
    const handles = fs.readdirSync(this.entriesPath).filter(file => /^[a-f0-9]{64}\.json$/.test(file))
      .map(file => JSON.parse(fs.readFileSync(path.join(this.entriesPath, file), 'utf8')).handle as string);
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
