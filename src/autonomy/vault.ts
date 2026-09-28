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

/** Which entries directory the canary bound, authenticated under the vault
 * key: `bound` for the directory binding produced, `pre-v2` for the copy kept
 * for a manual rollback. Putting that copy back is recognised from its marker. */
const GENERATION_FILE = '.generation';
const GENERATION_HANDLE = '\0generation';
/** A card's secret half (payments.ts `cardSecretHandle`) and its separate CVC. */
const CARD_SECRET = /^payment:card:[^:]+$/;
const CARD_CVC = /^payment:card:[^:]+:cvc$/;

/** An entry `migrate` moved to `entries/quarantine/` because it would not open. */
export interface QuarantinedEntry { file: string; handle?: string; reason: string }

/** What opening and migrating a vault would do, found without writing (`inspectVault`). */
export interface VaultInspection {
  key: 'accepted' | 'refused';
  refusal?: string;
  /** Binding still to run: unbound ciphertext is accepted until it does. */
  bound: boolean;
  /** Entries binding would re-encrypt. */
  rebind: number;
  /** Entries binding would move (or, for a damaged older revision, copy) to quarantine. */
  quarantine: QuarantinedEntry[];
  /** Entry files that cannot be read (permissions, I/O): binding stops on them. */
  unreadable: Array<{ file: string; error: string }>;
}

/** One entry file as binding sees it. */
type PlannedEntry =
  | { kind: 'unreadable'; file: string; error: string }
  | { kind: 'damaged'; file: string; raw: string; handle?: string; reason: string }
  | { kind: 'entry'; file: string; raw: string; handle: string; current: string; kept: string[]; dropped: number };

/** Open the vault in `dir` read-only and report what `migrate` would do. */
export function inspectVault(dir: string): VaultInspection {
  let vault: Vault;
  try { vault = new Vault(dir, { readOnly: true }); }
  catch (error) { return { key: 'refused', refusal: (error as Error).message, bound: false, rebind: 0, quarantine: [], unreadable: [] }; }
  return vault.inspect();
}

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
  private readOnly: boolean;

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
  }

  /** Names this key without revealing it, for `KARMAX_VAULT_ACCEPT_KEY`. */
  private keyId(): string {
    return `vk-${crypto.createHash('sha256').update('karmax-vault-key-id\0').update(this.key).digest('hex').slice(0, 16)}`;
  }
  /** The operator's explicit word that this key is the vault's, whatever the checks found. */
  private overridden(): boolean {
    return process.env.KARMAX_VAULT_ACCEPT_KEY === this.keyId();
  }
  private refuse(detail: string): Error {
    return new Error(`the vault key does not open this vault: ${detail}. Restore the key the vault was created with. `
      + `If you are certain this key is the vault's, start once with KARMAX_VAULT_ACCEPT_KEY=${this.keyId()}; `
      + 'entries it cannot open are then quarantined (deploy/README.md, "Rollback compatibility")');
  }

  /**
   * A known ciphertext under the vault key (AU-27). A wrong `KARMAX_VAULT_KEY`
   * otherwise surfaces only as per-entry authentication failures, while every
   * new secret is quietly written under the wrong key, splitting the vault in
   * two. The canary also records, authenticated, whether the vault is bound and
   * which entries directory it bound, so neither deleting a file nor swapping
   * `entries/` makes it accept unbound ciphertext again.
   *
   * Only a well-formed canary that fails authentication refuses the key. A
   * missing or damaged one (a vault from before the canary, a crash, a bad
   * disk) is re-derived from the entries. The key must open at least one, and
   * no other key this vault knows (`vault.key` beside `KARMAX_VAULT_KEY`) may
   * open more; entries no known key opens are stale or damaged, not votes.
   * `KARMAX_VAULT_ACCEPT_KEY` overrides either refusal.
   */
  private checkCanary(): void {
    const recorded = this.readCanary();
    const generation = this.readGeneration();
    if (recorded && (!recorded.bound || generation?.kind === 'bound' && generation.id === recorded.generation)) {
      this.bound = recorded.bound;
      return;
    }
    if (!recorded) this.checkKeyAgainstEntries();
    // The canary is missing, or bound another entries directory (a restored,
    // swapped or copied-over entries/). The pre-binding copy, put back for a
    // rollback, is bound again, entries the previous release wrote included;
    // anything else is bound if it holds bound entries.
    this.bound = generation?.kind === 'pre-v2' ? false : this.holdsBoundEntries();
    if (this.bound) this.recordGeneration();
    else this.writeCanary();
  }

  private checkKeyAgainstEntries(): void {
    const others = this.otherKnownKeys();
    let opened = 0, total = 0, elsewhere = 0;
    for (const handle of this.list()) {
      let blob: string | undefined;
      try { blob = this.readEntry(handle); } catch { continue; }
      if (blob === undefined) continue;
      total++;
      if (this.opens(blob, handle, this.key)) opened++;
      else if (others.some((key) => this.opens(blob!, handle, key))) elsewhere++;
    }
    if (this.overridden()) {
      if (total && (!opened || elsewhere > opened))
        console.error(`[vault] KARMAX_VAULT_ACCEPT_KEY: accepting a key that opens ${opened} of ${total} entries`);
      return;
    }
    if (total && !opened) throw this.refuse(`vault/vault.canary is missing or damaged, and the key opens none of the ${total} entries`);
    if (elsewhere > opened)
      throw this.refuse(`vault/vault.canary is missing or damaged, and the key opens ${opened} of ${total} entries while vault/vault.key opens ${elsewhere}`);
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

  private holdsBoundEntries(): boolean {
    return this.list().some((handle) => { try { return this.readEntry(handle)?.startsWith('v2.') === true; } catch { return false; } });
  }

  /** The recorded state, or undefined when there is no usable canary. */
  private readCanary(): { bound: boolean; generation?: string } | undefined {
    let blob: unknown;
    try { blob = JSON.parse(fs.readFileSync(this.canaryPath, 'utf8')).blob; } catch { return undefined; }
    const parts = typeof blob === 'string' ? blob.split('.') : [];
    if (parts.length !== 4 || parts[0] !== 'v2' || Buffer.from(parts[1]!, 'base64').length !== 12
      || Buffer.from(parts[2]!, 'base64').length !== 16) return undefined;
    let state: { canary?: string; bound?: unknown; generation?: unknown } | undefined;
    try { state = JSON.parse(this.decrypt(blob as string, CANARY_HANDLE)); } catch { state = undefined; }
    if (state?.canary !== CANARY) {
      if (this.overridden()) { console.error('[vault] KARMAX_VAULT_ACCEPT_KEY: replacing a canary this key does not open'); return undefined; }
      throw this.refuse('vault/vault.canary fails to authenticate under KARMAX_VAULT_KEY (or vault.key)');
    }
    return { bound: state.bound === true, ...(typeof state.generation === 'string' ? { generation: state.generation } : {}) };
  }

  /** The authenticated marker in `entries/`, if there is one this key opens. */
  private readGeneration(): { id: string; kind: 'bound' | 'pre-v2' } | undefined {
    try {
      const marker = JSON.parse(this.decrypt(JSON.parse(fs.readFileSync(path.join(this.entriesPath, GENERATION_FILE), 'utf8')).blob, GENERATION_HANDLE));
      return typeof marker?.id === 'string' && ['bound', 'pre-v2'].includes(marker.kind) ? marker : undefined;
    } catch { return undefined; }
  }
  private generationMarker(id: string, kind: 'bound' | 'pre-v2'): string {
    return `${JSON.stringify({ format: 'karmax-vault-generation', blob: this.encrypt(JSON.stringify({ id, kind }), GENERATION_HANDLE) })}\n`;
  }

  /** Mark `entries/` as the directory this canary binds. */
  private recordGeneration(): void {
    if (this.readOnly) return;
    const id = crypto.randomUUID();
    try { writeDurably(path.join(this.entriesPath, GENERATION_FILE), this.generationMarker(id, 'bound')); }
    catch (error) { if (cannotWrite(error)) return; throw error; }
    this.writeCanary(id);
  }

  /** Best effort: a vault it cannot write (a restore drill) is checked, not recorded. */
  private writeCanary(generation?: string): void {
    if (this.readOnly) return;
    const blob = this.encrypt(JSON.stringify({ canary: CANARY, bound: this.bound, ...(generation ? { generation } : {}) }), CANARY_HANDLE);
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
    if (this.readOnly) throw new Error('the vault has no key: set KARMAX_VAULT_KEY or restore vault/vault.key');
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
  private encrypt(plain: string, handle: string, unbound = false): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    if (!unbound) cipher.setAAD(boundTo(handle));
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${unbound ? '' : 'v2.'}${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
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
    if (this.readOnly) throw new Error('this vault was opened read-only');
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
   * What binding would do to each entry file, read once. A file that cannot be
   * read (permissions, I/O) is reported, never taken for corruption; one that
   * does not parse, is not an entry, or does not authenticate under the proven
   * key is damaged or foreign.
   */
  private plan(): PlannedEntry[] {
    let files: string[];
    try { files = fs.readdirSync(this.entriesPath).filter(file => ENTRY_FILE.test(file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return files.map((file): PlannedEntry => {
      let raw: string;
      try { raw = fs.readFileSync(path.join(this.entriesPath, file), 'utf8'); }
      catch (error) { return { kind: 'unreadable', file, error: (error as NodeJS.ErrnoException).code ?? (error as Error).message }; }
      let entry: { handle?: unknown; blob?: unknown; previous?: unknown };
      try { entry = JSON.parse(raw); } catch { return { kind: 'damaged', file, raw, reason: 'unreadable entry file' }; }
      if (typeof entry?.handle !== 'string' || typeof entry.blob !== 'string' || this.entryPath(entry.handle) !== path.join(this.entriesPath, file))
        return { kind: 'damaged', file, raw, reason: 'not a vault entry' };
      const handle = entry.handle;
      const rebind = (blob: unknown) => {
        if (typeof blob !== 'string') throw new Error('not a ciphertext');
        const plain = this.decrypt(blob, handle);
        return blob.startsWith('v2.') ? blob : this.encrypt(plain, handle);
      };
      let current: string;
      try { current = rebind(entry.blob); }
      catch (error) { return { kind: 'damaged', file, raw, handle, reason: (error as Error).message }; }
      const history = Array.isArray(entry.previous) ? entry.previous : [];
      const kept = history.flatMap(blob => { try { return [rebind(blob)]; } catch { return []; } });
      return { kind: 'entry', file, raw, handle, current, kept, dropped: history.length - kept.length };
    });
  }

  /** What `migrate` would do, without writing (see `inspectVault`). */
  inspect(): VaultInspection {
    const planned = this.bound ? [] : this.plan();
    const report: VaultInspection = { key: 'accepted', bound: this.bound, rebind: 0, quarantine: [], unreadable: [] };
    // A bound vault is not rewritten, but an unreadable entry still fails its reads.
    if (this.bound) for (const file of fs.readdirSync(this.entriesPath).filter(file => ENTRY_FILE.test(file))) {
      try { fs.accessSync(path.join(this.entriesPath, file), fs.constants.R_OK); }
      catch (error) { report.unreadable.push({ file, error: (error as NodeJS.ErrnoException).code ?? String(error) }); }
    }
    for (const entry of planned) {
      if (entry.kind === 'unreadable') report.unreadable.push({ file: entry.file, error: entry.error });
      else if (entry.kind === 'damaged') report.quarantine.push({ file: entry.file, ...(entry.handle ? { handle: entry.handle } : {}), reason: entry.reason });
      else {
        if (!entry.raw.includes('"v2.') || entry.kept.length || entry.dropped) report.rebind++;
        if (entry.dropped) report.quarantine.push({ file: entry.file, handle: entry.handle, reason: `${entry.dropped} earlier revision(s) would not open` });
      }
    }
    return report;
  }

  /**
   * Re-encrypt every entry and its history under its handle (AU-27), then
   * record in the canary that unbound ciphertext is no longer accepted. This
   * is one-way: the previous release cannot read `v2.` entries, so the
   * unbound ones are first copied to `entries.pre-v2/` (deploy/README.md,
   * "Rollback compatibility"). Every file is read before anything changes: one
   * that cannot be read stops binding with a report, leaving the vault as it
   * was. An entry that will not open under the proven key is damaged or
   * foreign; it moves to `entries/quarantine/` instead of refusing every other
   * secret. Rewriting a bound blob is harmless, so a crash midway simply
   * redoes the rest.
   */
  private bind(): void {
    // Another process may have bound the vault while this one waited.
    const recorded = this.readCanary();
    const generation = this.readGeneration();
    if (recorded?.bound && generation?.kind === 'bound' && generation.id === recorded.generation) { this.bound = true; return; }
    const planned = this.plan();
    const unreadable = planned.filter((entry): entry is Extract<PlannedEntry, { kind: 'unreadable' }> => entry.kind === 'unreadable');
    if (unreadable.length)
      throw new Error(`cannot read ${unreadable.length} vault entr${unreadable.length === 1 ? 'y' : 'ies'} in ${this.entriesPath} `
        + `(${unreadable.map(entry => `${entry.file}: ${entry.error}`).join(', ')}); nothing was changed. `
        + 'Make them readable by the app, or restore them from a backup, then restart');
    const parent = path.dirname(this.entriesPath);
    for (const name of fs.readdirSync(parent))
      if (name.startsWith(`${PRE_V2}.`) && name.endsWith('.tmp')) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    const aside = path.join(parent, PRE_V2);
    if (!fs.existsSync(aside)) this.copyAside(planned, aside);
    for (const entry of planned) {
      if (entry.kind === 'damaged') this.quarantine(entry.file, entry.handle, entry.reason);
      else if (entry.kind === 'entry') {
        if (entry.dropped) this.quarantine(entry.file, entry.handle, `${entry.dropped} earlier revision(s) would not open`, true);
        this.writeEntry(entry.handle, entry.current, entry.kept);
      }
    }
    this.bound = true;
    this.recordGeneration();
  }

  /**
   * The entries as binding found them, for a manual rollback, marked as the
   * pre-binding copy. A card keeps no CVC here (item 7 of the #367 review):
   * the copy outlives the migration by 14 days, and backups of it by longer.
   * After a rollback, cards need their CVC entered again.
   */
  private copyAside(planned: PlannedEntry[], aside: string): void {
    const staging = `${aside}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      for (const entry of planned) {
        if (entry.kind === 'unreadable') continue;
        if (entry.kind === 'entry' && CARD_CVC.test(entry.handle)) continue;
        let raw = entry.raw;
        if (entry.kind === 'entry' && CARD_SECRET.test(entry.handle)) {
          const original = JSON.parse(entry.raw).blob as string;
          const { cvc: _cvc, ...card } = JSON.parse(this.decrypt(original, entry.handle));
          raw = JSON.stringify({ handle: entry.handle, blob: this.encrypt(JSON.stringify(card), entry.handle, !original.startsWith('v2.')) });
        }
        writeDurably(path.join(staging, entry.file), raw);
      }
      writeDurably(path.join(staging, GENERATION_FILE), this.generationMarker(crypto.randomUUID(), 'pre-v2'));
      fs.renameSync(staging, aside);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    syncDirectory(path.dirname(aside));
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
