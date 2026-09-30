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
 *
 * Layout: one file per handle under `entries/`, each `v2.` ciphertext bound to
 * its handle (AU-27), with up to five earlier revisions. Releases before data
 * epoch 3 kept every secret, unbound, in one `secrets.json` map; the first
 * boot of this one moves and binds them (`migrate`). That is one-way, and the
 * way back is the pre-update backup (deploy/README.md, "Rollback compatibility").
 */
const CANARY = 'karmax-vault-canary';
/** Not a storable handle, so the canary's ciphertext cannot stand in for an entry. */
const CANARY_HANDLE = '\0canary';
const boundTo = (handle: string) => Buffer.from(`karmax-vault:v2\0${handle}`, 'utf8');
const ENTRY_FILE = /^[a-f0-9]{64}\.json$/;
/** How long quarantined entries are kept for someone to recover them. */
const QUARANTINE_RETENTION_MS = 30 * 86_400_000;
/** Secrets a write may not exceed, unless it shrinks one already stored. */
const SECRET_LIMIT = 65_536;
/** What `secrets.json` holds once its secrets have moved to `entries/`: not a
 * map, so a release before data epoch 3 refuses it ("not a secret map")
 * instead of starting on an empty vault and writing secrets this one ignores. */
const MOVED = ['karmax-vault-moved-to-entries',
  'The secrets moved to vault/entries/ (data epoch 3). To run an earlier release, restore the pre-update backup with its code.'];
const isMoved = (parsed: unknown) => Array.isArray(parsed) && parsed[0] === MOVED[0];

/** The vault key is not the vault's (as opposed to a vault that cannot be read). */
export class VaultKeyRefused extends Error {}

/** An entry `migrate` moved to `entries/quarantine/` because it would not open. */
export interface QuarantinedEntry { file: string; handle?: string; reason: string }

/** What opening and migrating a vault would do, found without writing (`inspectVault`). */
export interface VaultInspection {
  /** `unchecked`: the vault could not be opened far enough to check the key (`fatal` says why). */
  key: 'accepted' | 'refused' | 'unchecked';
  refusal?: string;
  fatal?: string;
  /** Binding still to run: unbound ciphertext is accepted until it does. */
  bound: boolean;
  /** Secrets binding would re-encrypt (from `secrets.json` or `entries/`). */
  rebind: number;
  /** Entries binding would move (or, for a damaged older revision, copy) to quarantine. */
  quarantine: QuarantinedEntry[];
  /** Files that cannot be read (permissions, I/O): binding stops on them. */
  unreadable: Array<{ file: string; error: string }>;
  /** Secrets over the 64 KiB write limit (a previous release set none): kept,
   * and only ever rewritten smaller, as the CVC split does. */
  oversized?: string[];
}

/** One secret as binding sees it: from the pre-epoch-3 map, or an entry file. */
type PlannedEntry =
  | { kind: 'unreadable'; file: string; error: string }
  | { kind: 'damaged'; file: string; raw?: string; handle?: string; reason: string; fromMap: boolean }
  | { kind: 'entry'; file: string; handle: string; current: string; kept: string[]; dropped: number; fromMap: boolean; changed: boolean; bytes: number }
  /** A bound entry an interrupted move wrote for a secret no longer in the map. */
  | { kind: 'stale'; file: string };

/** Open the vault in `dir` read-only and report what `migrate` would do. */
export function inspectVault(dir: string): VaultInspection {
  let vault: Vault;
  try { vault = new Vault(dir, { readOnly: true }); }
  catch (error) {
    const message = (error as Error).message;
    return { ...(error instanceof VaultKeyRefused ? { key: 'refused', refusal: message } : { key: 'unchecked', fatal: message }),
      bound: false, rebind: 0, quarantine: [], unreadable: [] };
  }
  try { return vault.inspect(); }
  catch (error) { return { key: 'accepted', fatal: (error as Error).message, bound: false, rebind: 0, quarantine: [], unreadable: [] }; }
}

/** Append each quarantined entry to the audit log, and acknowledge it right
 * after: a crash between the two audits at most that one entry again. */
export async function recordQuarantine(vault: Vault, append: (entry: QuarantinedEntry) => Promise<unknown>): Promise<void> {
  for (const entry of (await vault.migrate()).quarantined) {
    await append(entry);
    vault.acknowledgeQuarantine([entry]);
  }
}

/** Write `data` to a synced temporary beside `file` and rename it into place;
 * `syncDir` (default) also makes the rename durable. */
function writeDurably(file: string, data: string | Buffer, syncDir = true): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  if (syncDir) syncDirectory(path.dirname(file));
}
function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r');
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
  private reported = new Set<string>();
  private readOnly: boolean;
  /** A well-formed canary failed to authenticate (for the wording of a refusal). */
  private canaryFailed = false;

  /** `readOnly` opens without creating or recording anything (a preflight, a
   * restore drill); anything that would write throws. */
  constructor(dir: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly === true;
    // The vault holds encrypted secrets and its key; keep the directory private
    // (0700) so the 0600 files inside aren't reachable via a traversable dir.
    if (!this.readOnly) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.keyPath = path.join(dir, 'vault.key');
    this.dbPath = path.join(dir, 'secrets.json');
    this.key = this.loadOrCreateKey();
    this.entriesPath = path.join(dir, 'entries');
    if (!this.readOnly) fs.mkdirSync(this.entriesPath, { recursive: true, mode: 0o700 });
    this.canaryPath = path.join(dir, 'vault.canary');
    this.checkCanary();
    this.checkLegacyMap();
  }

  /** Names this key without revealing it, for `KARMAX_VAULT_ACCEPT_KEY`. */
  private keyId(): string {
    return `vk-${crypto.createHash('sha256').update('karmax-vault-key-id\0').update(this.key).digest('hex').slice(0, 16)}`;
  }
  /** The operator's explicit word that this key is the vault's. It never
   * accepts a key that opens none of the vault's secrets. */
  private overridden(): boolean {
    return process.env.KARMAX_VAULT_ACCEPT_KEY === this.keyId();
  }
  private refuse(detail: string, overridable: boolean): Error {
    return new VaultKeyRefused(`the vault key does not open this vault: ${detail}. Restore the key the vault was created with`
      + (overridable ? `. If you are certain this key is the vault's, start once with KARMAX_VAULT_ACCEPT_KEY=${this.keyId()}; `
        + 'secrets it cannot open are then quarantined (deploy/README.md, "Rollback compatibility")' : ''));
  }

  /**
   * A known ciphertext under the vault key (AU-27). A wrong `KARMAX_VAULT_KEY`
   * otherwise surfaces only as per-secret authentication failures, while every
   * new secret is quietly written under the wrong key, splitting the vault in
   * two. The canary also records, authenticated, whether the vault is bound;
   * once it says so, that is final: no file in the vault can make it accept
   * unbound ciphertext again.
   *
   * Only a well-formed canary that fails authentication refuses the key. A
   * missing or damaged one (a vault from before the canary, a crash, a bad
   * disk) is re-derived from the secrets. The key must open at least one, and
   * no other key this vault knows (`vault.key` beside `KARMAX_VAULT_KEY`) may
   * open more; secrets no known key opens are stale or damaged, not votes.
   */
  private checkCanary(): void {
    const recorded = this.readCanary();
    if (recorded !== undefined) { this.bound = recorded; return; }
    const secrets = this.snapshot();
    const others = this.otherKnownKeys();
    let opened = 0, elsewhere = 0;
    for (const { handle, blob } of secrets) {
      if (this.opens(blob, handle, this.key)) opened++;
      else if (others.some((key) => this.opens(blob, handle, key))) elsewhere++;
    }
    if (secrets.length && !opened)
      throw this.refuse(this.canaryFailed
        ? `vault/vault.canary fails to authenticate, and KARMAX_VAULT_ACCEPT_KEY cannot override that: the key opens none of the ${secrets.length} entries`
        : `vault/vault.canary is missing or damaged, and the key opens none of the ${secrets.length} entries`, false);
    if (elsewhere > opened) {
      if (!this.overridden())
        throw this.refuse(`vault/vault.canary is missing or damaged, and the key opens ${opened} of ${secrets.length} entries `
          + `while vault/vault.key opens ${elsewhere}`, true);
      console.error(`[vault] KARMAX_VAULT_ACCEPT_KEY: accepting a key that opens ${opened} of ${secrets.length} entries`);
    }
    // Bound secrets, or a moved secrets.json, mean this vault was bound: its
    // canary was lost, not absent, and unbound ciphertext in it is planted.
    // Not while secrets.json is still the source of truth: bound entries then
    // come from an interrupted move, and the map may have changed since.
    const mapIsSource = !this.migrated() && fs.existsSync(this.dbPath);
    this.bound = this.moved() || (!mapIsSource && secrets.some(({ blob }) => blob.startsWith('v2.')));
    this.writeCanary();
  }

  /** Has `secrets.json` been replaced by the moved sentinel? */
  private moved(): boolean {
    try { return isMoved(JSON.parse(fs.readFileSync(this.dbPath, 'utf8'))); } catch { return false; }
  }
  /** Have the secrets moved out of `secrets.json` (the sentinel, or an earlier build's marker)? */
  private migrated(): boolean {
    return this.moved() || fs.existsSync(path.join(this.entriesPath, '.migrated'));
  }

  /** After the move to `entries/`, `secrets.json` stays empty. Secrets there
   * now were written by a previous release run against this vault; binding
   * them would accept unbound ciphertext, ignoring them would lose them. */
  private checkLegacyMap(): void {
    if (!this.migrated()) return;
    const count = Object.keys(this.readDb()).length;
    if (count) throw new Error(`vault/secrets.json holds ${count} secret${count === 1 ? '' : 's'} although the vault moved to `
      + 'vault/entries/: a previous release ran against it after the upgrade. Restore the pre-update backup with its code '
      + '(deploy/README.md, "Rollback compatibility"), or move secrets.json aside to start without those secrets');
  }

  /** Every secret's current blob, reading `secrets.json` once. */
  private snapshot(): Array<{ handle: string; blob: string }> {
    const secrets = new Map<string, string>();
    for (const file of this.entryFiles()) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this.entriesPath, file), 'utf8'));
        if (typeof entry?.handle === 'string' && typeof entry.blob === 'string') secrets.set(entry.handle, entry.blob);
      } catch { /* unreadable: counted by neither side */ }
    }
    if (!this.migrated())
      for (const [handle, blob] of Object.entries(this.readDb())) if (typeof blob === 'string') secrets.set(handle, blob);
    return [...secrets].map(([handle, blob]) => ({ handle, blob }));
  }

  /** `vault.key` when `KARMAX_VAULT_KEY` supplies another key. */
  private otherKnownKeys(): Buffer[] {
    if (!process.env.KARMAX_VAULT_KEY) return [];
    try {
      const file = fs.readFileSync(this.keyPath);
      return file.equals(this.key) ? [] : [file];
    } catch { return []; }
  }

  private opens(blob: string, handle: string, key: Buffer): boolean {
    try { this.decrypt(blob, handle, key, true); return true; } catch { return false; }
  }

  /** The recorded bound state, or undefined when there is no usable canary. */
  private readCanary(): boolean | undefined {
    let blob: unknown;
    try { blob = JSON.parse(fs.readFileSync(this.canaryPath, 'utf8')).blob; } catch { return undefined; }
    const parts = typeof blob === 'string' ? blob.split('.') : [];
    if (parts.length !== 4 || parts[0] !== 'v2' || Buffer.from(parts[1]!, 'base64').length !== 12
      || Buffer.from(parts[2]!, 'base64').length !== 16) return undefined;
    let state: { canary?: string; bound?: unknown } | undefined;
    try { state = JSON.parse(this.decrypt(blob as string, CANARY_HANDLE)); } catch { state = undefined; }
    if (state?.canary !== CANARY) {
      this.canaryFailed = true;
      // Overridden, the secrets decide as for a missing canary: the key must still open some.
      if (this.overridden()) { console.error('[vault] KARMAX_VAULT_ACCEPT_KEY: replacing a canary this key does not open'); return undefined; }
      const opensAny = this.snapshot().some(({ handle, blob }) => this.opens(blob, handle, this.key));
      throw this.refuse('vault/vault.canary fails to authenticate under KARMAX_VAULT_KEY (or vault.key)', opensAny);
    }
    return state.bound === true;
  }

  /** Best effort: a vault it cannot write (a restore drill) is checked, not recorded. */
  private writeCanary(): void {
    if (this.readOnly) return;
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
    if (this.readOnly) throw new Error('the vault has no key: set KARMAX_VAULT_KEY (or KARMAX_VAULT_KEY_FILE) or restore vault/vault.key');
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
    if (isMoved(parsed)) return {};
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
  /** Unbound (pre-v2) ciphertext opens only until `migrate` has bound the vault
   * (or, `anyFormat`, to recognise which key wrote it). */
  private decrypt(blob: string, handle: string, key = this.key, anyFormat = false): string {
    const parts = typeof blob === 'string' ? blob.split('.') : [];
    const bound = parts[0] === 'v2';
    if (bound) parts.shift();
    else if (this.bound && !anyFormat)
      throw new Error(`vault entry for ${handle} is not bound to its handle; restore it from a backup`);
    const iv = parts.length === 3 ? Buffer.from(parts[0]!, 'base64') : Buffer.alloc(0);
    const tag = parts.length === 3 ? Buffer.from(parts[1]!, 'base64') : Buffer.alloc(0);
    if (iv.length !== 12 || tag.length !== 16) throw new Error('vault entry is corrupt (malformed ciphertext)');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
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
  /** Entry files; none before the first boot of this release created `entries/`. */
  private entryFiles(): string[] {
    try { return fs.readdirSync(this.entriesPath).filter(file => ENTRY_FILE.test(file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  /** An entry file's text, or undefined when there is none. Anything but a
   * missing file (a directory it cannot read, an I/O error) throws: taking it
   * for an absent secret would make every secret look deleted. */
  private readEntryFile(handle: string): string | undefined {
    try { return fs.readFileSync(this.entryPath(handle), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  private readEntry(handle: string): string | undefined {
    const raw = this.readEntryFile(handle);
    if (raw !== undefined) {
      let entry: { handle?: unknown; blob?: unknown };
      try { entry = JSON.parse(raw); }
      catch { throw new Error(`vault entry for ${handle} is unreadable; restore it from a backup`); }
      if (entry?.handle !== handle || typeof entry.blob !== 'string') throw new Error('vault entry is corrupt');
      return entry.blob as string;
    }
    if (this.migrated()) return undefined;
    return this.readDb()[handle];
  }

  private history(handle: string): string[] {
    const raw = this.readEntryFile(handle);
    if (raw === undefined) return [];
    const previous = JSON.parse(raw).previous ?? [];
    if (!Array.isArray(previous) || previous.length > 5 || previous.some(blob => typeof blob !== 'string'))
      throw new Error('vault history is corrupt');
    return previous;
  }

  private writeEntry(handle: string, blob: string, previous: string[] = [], syncDir = true): void {
    writeDurably(this.entryPath(handle), JSON.stringify({ handle, blob, ...(previous.length ? { previous } : {}) }), syncDir);
  }

  private validateSecret(secret: string): void {
    if (Buffer.byteLength(secret, 'utf8') > SECRET_LIMIT) throw new Error('vault secret exceeds size limit (64 KiB)');
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    if (this.readOnly) throw new Error('this vault was opened read-only');
    const release = process.platform === 'linux'
      ? await acquireFileLock(`${this.dbPath}.lock`) : undefined;
    try {
      if (!this.bound || !this.moved()) this.bind();
      return operation();
    } finally { release?.(); }
  }

  /**
   * What binding would do to each secret, read once: the `secrets.json` map
   * of a release before data epoch 3 (until `.migrated` records the move),
   * then the entry files. A file that cannot be read (permissions, I/O) is
   * reported, never taken for corruption; a secret that does not parse, is
   * not an entry, or does not authenticate under the proven key is damaged or
   * foreign.
   */
  private plan(): PlannedEntry[] {
    const planned: PlannedEntry[] = [];
    const fromMap = new Set<string>();
    const fromMapSource = !this.migrated() && fs.existsSync(this.dbPath);
    if (fromMapSource) {
      let db: Record<string, unknown>;
      try { db = this.readDb(); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return [{ kind: 'unreadable', file: 'secrets.json', error: code ?? (error as Error).message }];
      }
      for (const [handle, blob] of Object.entries(db)) {
        const file = path.basename(this.entryPath(handle));
        fromMap.add(file);
        try {
          if (typeof blob !== 'string') throw new Error('not a ciphertext');
          const plain = this.decrypt(blob, handle);
          planned.push({ kind: 'entry', file, handle, current: blob.startsWith('v2.') ? blob : this.encrypt(plain, handle),
            kept: [], dropped: 0, fromMap: true, changed: true, bytes: Buffer.byteLength(plain, 'utf8') });
        } catch (error) {
          planned.push({ kind: 'damaged', file, raw: JSON.stringify({ handle, blob }), handle, reason: (error as Error).message, fromMap: true });
        }
      }
    }
    for (const file of this.entryFiles()) {
      // The map is the source of truth until the move is recorded (a crash midway).
      if (fromMap.has(file)) continue;
      let raw: string;
      try { raw = fs.readFileSync(path.join(this.entriesPath, file), 'utf8'); }
      catch (error) { planned.push({ kind: 'unreadable', file, error: (error as NodeJS.ErrnoException).code ?? (error as Error).message }); continue; }
      let entry: { handle?: unknown; blob?: unknown; previous?: unknown };
      try { entry = JSON.parse(raw); }
      catch { planned.push({ kind: 'damaged', file, raw, reason: 'unreadable entry file', fromMap: false }); continue; }
      // While secrets.json is still the source of truth, a bound entry for a
      // secret it no longer holds was written by an interrupted move, and the
      // previous release has since deleted that secret.
      if (fromMapSource && typeof entry?.blob === 'string' && entry.blob.startsWith('v2.')) { planned.push({ kind: 'stale', file }); continue; }
      if (typeof entry?.handle !== 'string' || typeof entry.blob !== 'string' || this.entryPath(entry.handle) !== path.join(this.entriesPath, file)) {
        planned.push({ kind: 'damaged', file, raw, reason: 'not a vault entry', fromMap: false });
        continue;
      }
      const handle = entry.handle;
      const rebind = (blob: unknown) => {
        if (typeof blob !== 'string') throw new Error('not a ciphertext');
        const plain = this.decrypt(blob, handle);
        return blob.startsWith('v2.') ? blob : this.encrypt(plain, handle);
      };
      let current: string;
      let bytes = 0;
      try { current = rebind(entry.blob); bytes = Buffer.byteLength(this.decrypt(current, handle), 'utf8'); }
      catch (error) { planned.push({ kind: 'damaged', file, raw, handle, reason: (error as Error).message, fromMap: false }); continue; }
      const history = Array.isArray(entry.previous) ? entry.previous : [];
      const kept = history.flatMap(blob => { try { return [rebind(blob)]; } catch { return []; } });
      planned.push({ kind: 'entry', file, handle, current, kept, dropped: history.length - kept.length, fromMap: false, bytes,
        changed: current !== entry.blob || kept.some((blob, i) => blob !== history[i]) || kept.length < history.length });
    }
    return planned;
  }

  /** What `migrate` would do, without writing (see `inspectVault`). */
  inspect(): VaultInspection {
    const migrated = this.moved();
    const planned = this.bound && migrated ? [] : this.plan();
    const report: VaultInspection = { key: 'accepted', bound: this.bound && migrated, rebind: 0, quarantine: [], unreadable: [] };
    // A bound vault is not rewritten, but an unreadable entry still fails its reads.
    if (report.bound) for (const file of this.entryFiles()) {
      try { fs.accessSync(path.join(this.entriesPath, file), fs.constants.R_OK); }
      catch (error) { report.unreadable.push({ file, error: (error as NodeJS.ErrnoException).code ?? String(error) }); }
    }
    for (const entry of planned) {
      if (entry.kind === 'unreadable') report.unreadable.push({ file: entry.file, error: entry.error });
      else if (entry.kind === 'damaged') report.quarantine.push({ file: entry.file, ...(entry.handle ? { handle: entry.handle } : {}), reason: entry.reason });
      else if (entry.kind === 'entry') {
        if (entry.changed) report.rebind++;
        if (entry.bytes > SECRET_LIMIT) (report.oversized ??= []).push(entry.handle);
        if (entry.dropped) report.quarantine.push({ file: entry.file, handle: entry.handle, reason: `${entry.dropped} earlier revision(s) would not open` });
      }
    }
    return report;
  }

  /**
   * Move a pre-epoch-3 `secrets.json` into `entries/`, re-encrypt every secret
   * and its history under its handle (AU-27), then record in the canary that
   * unbound ciphertext is no longer accepted. This is one-way: the previous
   * release reads only `secrets.json`, which is left empty; the way back is
   * the pre-update backup. Every file is read before anything changes: one
   * that cannot be read stops binding with a report, leaving the vault as it
   * was. A secret that will not open under the proven key is damaged or
   * foreign; it moves to `entries/quarantine/` instead of refusing every other
   * secret. Each step is repeatable, so a crash midway redoes the rest.
   */
  private bind(): void {
    // Another process may have bound the vault while this one waited.
    if (this.readCanary() && this.moved()) { this.bound = true; return; }
    const planned = this.plan();
    const unreadable = planned.filter((entry): entry is Extract<PlannedEntry, { kind: 'unreadable' }> => entry.kind === 'unreadable');
    if (unreadable.length)
      throw new Error(`cannot read ${unreadable.length} vault entr${unreadable.length === 1 ? 'y' : 'ies'} in ${path.dirname(this.entriesPath)} `
        + `(${unreadable.map(entry => `${entry.file}: ${entry.error}`).join(', ')}); nothing was changed. `
        + 'Make them readable by the app, or restore them from a backup, then restart');
    for (const entry of planned) {
      if (entry.kind === 'stale') fs.rmSync(path.join(this.entriesPath, entry.file), { force: true });
      else if (entry.kind === 'damaged') this.quarantine(entry);
      else if (entry.kind === 'entry') {
        if (entry.dropped) this.quarantine({ kind: 'damaged', file: entry.file, handle: entry.handle,
          reason: `${entry.dropped} earlier revision(s) would not open`, fromMap: false }, true);
        if (entry.changed) this.writeEntry(entry.handle, entry.current, entry.kept, false);
      }
    }
    syncDirectory(this.entriesPath);
    // One atomic step retires secrets.json: from here the previous release
    // refuses the vault instead of starting on it empty.
    if (!this.moved()) writeDurably(this.dbPath, `${JSON.stringify(MOVED)}\n`);
    if (!fs.existsSync(path.join(this.entriesPath, '.migrated'))) writeDurably(path.join(this.entriesPath, '.migrated'), '');
    this.bound = true;
    this.writeCanary();
  }

  /**
   * Move an entry aside (or copy it, when its current secret survives), synced.
   * Its reason goes in a `.why` sidecar first, so `migrate` reports it for the
   * audit log until `acknowledgeQuarantine`, even across a crash. The file's
   * time is reset: the 30 days run from now.
   */
  private quarantine(entry: Extract<PlannedEntry, { kind: 'damaged' }>, copy = false): void {
    const dir = path.join(this.entriesPath, 'quarantine');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${entry.file}.${Date.now()}.${crypto.randomUUID()}`);
    writeDurably(`${target}.why`, JSON.stringify({ ...(entry.handle === undefined ? {} : { handle: entry.handle }), reason: entry.reason }), false);
    if (entry.fromMap) writeDurably(target, entry.raw!, false);
    else if (copy) { fs.copyFileSync(path.join(this.entriesPath, entry.file), target); syncFile(target); }
    else fs.renameSync(path.join(this.entriesPath, entry.file), target);
    const now = new Date();
    fs.utimesSync(target, now, now);
    syncDirectory(dir);
    syncDirectory(this.entriesPath);
    console.error(`[vault] QUARANTINED ${entry.handle === undefined ? entry.file : `the entry for ${entry.handle}`}: ${entry.reason}. `
      + `It is kept at ${target} for 30 days; restore it from a backup if it is needed.`);
  }

  /** Quarantined entries not yet in the audit log (see `acknowledgeQuarantine`). */
  private unaudited(): QuarantinedEntry[] {
    const dir = path.join(this.entriesPath, 'quarantine');
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((name) => name.endsWith('.why')).sort().flatMap((why): QuarantinedEntry[] => {
      const file = why.slice(0, -'.why'.length);
      if (!names.includes(file)) { fs.rmSync(path.join(dir, why), { force: true }); return []; } // crashed before the move
      let detail: { handle?: unknown; reason?: unknown } = {};
      try { detail = JSON.parse(fs.readFileSync(path.join(dir, why), 'utf8')); } catch { /* reason lost */ }
      return [{ file: path.relative(path.dirname(this.entriesPath), path.join(dir, file)),
        ...(typeof detail.handle === 'string' ? { handle: detail.handle } : {}),
        reason: typeof detail.reason === 'string' ? detail.reason : 'quarantined' }];
    });
  }

  /** Record that `entries` reached the audit log: `migrate` stops reporting them. */
  acknowledgeQuarantine(entries: QuarantinedEntry[]): void {
    for (const entry of entries) fs.rmSync(path.join(path.dirname(this.entriesPath), `${entry.file}.why`), { force: true });
  }

  /** Bind the vault (AU-27) without waiting for its next write, and tidy what
   * a crash or an earlier build left. Returns what it quarantined, for the
   * audit log. */
  async migrate(): Promise<{ quarantined: QuarantinedEntry[] }> {
    await this.mutate(() => {
      // A crash between writing a temporary and renaming it leaves the whole
      // secret (a card with its CVC, say), or a previous release's whole map,
      // beside the files; backups would carry it. Entry writers hold this lock;
      // the vault directory's own temporaries are swept once they are a minute old.
      const vaultDir = path.dirname(this.entriesPath);
      const quarantine = path.join(this.entriesPath, 'quarantine');
      const sweep = (dir: string, minAgeMs: number) => {
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) if (name.endsWith('.tmp')) {
          const file = path.join(dir, name);
          try { if (Date.now() - fs.statSync(file).mtimeMs >= minAgeMs) fs.rmSync(file, { force: true }); } catch { /* gone */ }
        }
      };
      sweep(this.entriesPath, 0);
      sweep(quarantine, 0);
      sweep(vaultDir, 60_000);
      let held: string[] = [];
      try { held = fs.readdirSync(quarantine); } catch { /* none */ }
      for (const file of held.filter((name) => !name.endsWith('.why')))
        if (Date.now() - fs.statSync(path.join(quarantine, file)).mtimeMs > QUARANTINE_RETENTION_MS)
          for (const stale of [file, `${file}.why`]) fs.rmSync(path.join(quarantine, stale), { force: true });
      // Rollback copies an earlier build of this release kept.
      for (const name of fs.readdirSync(vaultDir))
        if (name.startsWith('entries.pre-v2')) fs.rmSync(path.join(vaultDir, name), { recursive: true, force: true });
    });
    return { quarantined: this.unaudited() };
  }

  /** `history: false` replaces the secret and forgets its earlier revisions,
   * for a value that must not survive in them (a card's CVC, AU-31). */
  async put(handle: string, secret: string, options: { history?: boolean } = {}): Promise<void> {
    await this.mutate(() => {
      const prior = this.readEntry(handle);
      // A rewrite that strictly shrinks a stored secret is always allowed: the previous
      // release stored card billing fields with no limit, and their CVC must
      // still come out (AU-31). Anything else keeps the limit.
      const bytes = Buffer.byteLength(secret, 'utf8');
      if (bytes > SECRET_LIMIT && !(prior !== undefined && bytes < Buffer.byteLength(this.decrypt(prior, handle), 'utf8')))
        this.validateSecret(secret);
      if (options.history === false) return this.writeEntry(handle, this.encrypt(secret, handle));
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
    for (const file of this.entryFiles()) {
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
    if (!this.migrated()) handles.push(...Object.keys(this.readDb()));
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
