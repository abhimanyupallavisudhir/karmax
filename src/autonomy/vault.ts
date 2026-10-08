import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireFileLock } from '../util/file-lock.js';
import { INSTALLATION_SCOPE, LocalKek, isVaultScope, kekFromEnvironment, type KekSource, type KeyEncryptionKey, type VaultScope } from './vault-keys.js';
import { CANARY, KEK_ID, KEYRING, wrappedFor, SECRET_LIMIT, VaultKeyRefused, isScoped, kekCanaryRecord, mintDataKey, openEntry, openKekCanary, parseKeyring,
  readableKeyring, refusal, sealEntry, strandedKeys, strandedRefusal, unwrapDataKey, validateScope, validateSecret,
  type Keyring, type SecretVault, type VaultKeyStatus } from './vault-crypto.js';
import type { VaultRows } from './vault-database.js';

export { VaultKeyRefused, type VaultKeyStatus } from './vault-crypto.js';

/**
 * A local, file-backed secret vault (SPEC §1, §8.4): the credential broker's
 * storage on every deployment, hosted included. External password stores are
 * connectors that integrate with it, not replacement backends. Stored values
 * are SECRETS resolved only by the broker; everything else in the system holds
 * opaque handles (pointers), never raw keys.
 *
 * Envelope encryption (SS-1, data epoch 4; wiki features/vault-encryption).
 * Every secret belongs to a scope (an organization, a user, the installation)
 * and is encrypted with AES-256-GCM under a random data key (DEK) of that scope:
 * `v3.<kid>.iv.tag.ct`, its additional data binding the format, the scope and
 * the handle. Each scope's DEKs live in a keyring, `keys/<sha256(scope)>.json`,
 * wrapped under one or more key encryption keys (KEKs, `vault-keys.ts`), with
 * additional data binding the format, the scope and the kid. Several wraps
 * make KEK rotation crash-safe; deleting a keyring crypto-shreds its scope.
 *
 * Layout: one file per handle under `entries/`, recording its scope, with up to
 * five earlier revisions. Earlier formats are read only until they are
 * migrated: unbound ciphertext (before data epoch 3) until `bind`, and `v2.`
 * ciphertext under the KEK itself (data epoch 3) until `migrateToScopes`, which
 * needs the database to find each secret's owner. Both migrations are one-way;
 * the way back is the pre-update backup (deploy/README.md, "Rollback
 * compatibility").
 */
/** Not a storable handle, so the canary's ciphertext cannot stand in for an entry. */
const CANARY_HANDLE = '\0canary';
const boundTo = (handle: string) => Buffer.from(`karmax-vault:v2\0${handle}`, 'utf8');
const ENTRY_FILE = /^[a-f0-9]{64}\.json$/;
const KEYRING_FILE = /^[a-f0-9]{64}\.json$/;
/** How long quarantined entries are kept for someone to recover them. */
const QUARANTINE_RETENTION_MS = 30 * 86_400_000;
/** What `secrets.json` holds once its secrets have moved to `entries/`: not a
 * map, so a release before data epoch 3 refuses it ("not a secret map")
 * instead of starting on an empty vault and writing secrets this one ignores. */
const MOVED = ['karmax-vault-moved-to-entries',
  'The secrets moved to vault/entries/ (data epoch 3). To run an earlier release, restore the pre-update backup with its code.'];
const isMoved = (parsed: unknown) => Array.isArray(parsed) && parsed[0] === MOVED[0];
/** What `secrets.json` holds once the vault has moved into the application
 * database (data epoch 5, `vault-backend.ts`): neither a map nor the epoch 3
 * sentinel, so the epoch 3 and 4 releases refuse the vault ("not a secret
 * map") instead of starting on an empty one. */
export const MOVED_TO_DATABASE = ['karmax-vault-moved-to-database',
  'The secrets moved into the application database (data epoch 5). To run an earlier release, restore the pre-update backup with its code.'];
/** Has the vault in `dir` moved into the application database? */
export function movedToDatabase(dir: string): boolean {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'))?.[0] === MOVED_TO_DATABASE[0]; } catch { return false; }
}

/** The vault in this directory moved into the application database. */
export class VaultMovedToDatabase extends Error {}
/** What `vault.canary` holds once every secret is under a data key: the
 * epoch-3 release finds no canary and no entry its key opens, and refuses. */
const SCOPED = { format: 'karmax-vault-moved-to-data-keys',
  note: 'Secrets are encrypted under per-scope data keys (data epoch 4). To run an earlier release, restore the pre-update backup with its code.' };

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
  /** Entries the epoch 4 migration would re-encrypt under their scope's data key. */
  toScopes: number;
  /** Entries binding would move (or, for a damaged older revision, copy) to quarantine. */
  quarantine: QuarantinedEntry[];
  /** Files that cannot be read (permissions, I/O): binding stops on them. */
  unreadable: Array<{ file: string; error: string }>;
  /** The directory is retired: the vault moved into the application database
   * (data epoch 5), which `inspectDatabaseVault` checks instead. */
  movedToDatabase?: boolean;
  /** Secrets over the 64 KiB write limit (a previous release set none): kept,
   * and only ever rewritten smaller, as the CVC split does. */
  oversized?: string[];
}

/** What `migrateToScopes` did, for the audit log. */
export interface ScopeMigration {
  migrated: number;
  /** Handles no owner was found for: kept under the installation's data key
   * until a write names their owner. */
  unresolved: string[];
  byScope: Record<string, number>;
}

/** One secret as binding sees it: from the pre-epoch-3 map, or an entry file. */
type PlannedEntry =
  | { kind: 'unreadable'; file: string; error: string }
  | { kind: 'damaged'; file: string; raw?: string; handle?: string; reason: string; fromMap: boolean }
  | { kind: 'entry'; file: string; handle: string; current: string; kept: string[]; dropped: number; fromMap: boolean; changed: boolean; bytes: number }
  /** A bound entry an interrupted move wrote for a secret no longer in the map. */
  | { kind: 'stale'; file: string };

/** An entry file. `scope` is absent only on ciphertext from before data epoch 4;
 * `unresolved` marks an owner the migration could not find. */
interface EntryRecord { handle: string; blob: string; previous: string[]; scope?: VaultScope; unresolved?: boolean }

/** Open the vault in `dir` read-only and report what the first boot would do. */
export function inspectVault(dir: string, options: { kek?: KekSource } = {}): VaultInspection {
  const empty = { bound: false, rebind: 0, toScopes: 0, quarantine: [], unreadable: [] };
  if (movedToDatabase(dir)) return { key: 'unchecked', movedToDatabase: true, fatal: 'the vault moved into the application database', ...empty };
  let vault: Vault;
  try { vault = new Vault(dir, { readOnly: true, ...options }); }
  catch (error) {
    const message = (error as Error).message;
    return { ...(error instanceof VaultKeyRefused ? { key: 'refused', refusal: message } : { key: 'unchecked', fatal: message }), ...empty };
  }
  try { return vault.inspect(); }
  catch (error) { return { key: 'accepted', fatal: (error as Error).message, ...empty }; }
}

/** Run the data epoch 4 migration (SS-1) and append its report to the audit
 * log, acknowledged only once written: a crash in between reports it again. */
export async function recordScopeMigration(vault: Vault, resolve: (handles: string[]) => Promise<Map<string, VaultScope>>,
  append: (report: ScopeMigration) => Promise<unknown>): Promise<ScopeMigration | undefined> {
  await vault.migrateToScopes(resolve);
  const report = vault.unauditedScopeMigration();
  if (!report) return undefined;
  await append(report);
  vault.acknowledgeScopeMigration();
  return report;
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

export class Vault implements SecretVault {
  private dbPath: string;
  private kek: KekSource;
  /** The KEK's raw material, for ciphertext from before data keys. */
  private key?: Buffer;
  private entriesPath: string;
  private keysPath: string;
  private canaryPath: string;
  /** Recorded in the authenticated canary: unbound ciphertext is refused. */
  private bound = false;
  /** Keyrings exist: secrets are written under data keys. */
  private scoped = false;
  /** `v2.` ciphertext under the KEK is still accepted (until `migrateToScopes` finishes). */
  private legacy = true;
  /** Some data keys lack a wrap under the current KEK; another known KEK opens them. */
  private unwrapped = false;
  /** Unwrapped data keys, by scope, valid while the keyring file is unchanged. */
  private rings = new Map<string, { raw: string; keys: Map<string, Buffer> }>();
  private reported = new Set<string>();
  private readOnly: boolean;
  /** A well-formed canary failed to authenticate (for the wording of a refusal). */
  private canaryFailed = false;

  /** `readOnly` opens without creating or recording anything (a preflight, a
   * restore drill); anything that would write throws. `kek` replaces the key
   * from the environment (key rotation). */
  constructor(dir: string, options: { readOnly?: boolean; kek?: KekSource } = {}) {
    this.readOnly = options.readOnly === true;
    if (movedToDatabase(dir))
      throw new VaultMovedToDatabase(`the vault in ${dir} moved into the application database (data epoch 5); open it with KARMAX_DATABASE_URL`);
    // The vault holds encrypted secrets and possibly its key; keep the directory
    // private (0700) so the 0600 files inside aren't reachable via a traversable dir.
    if (!this.readOnly) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dbPath = path.join(dir, 'secrets.json');
    this.kek = options.kek ?? kekFromEnvironment(dir, { readOnly: this.readOnly });
    if (!KEK_ID.test(this.kek.current.id)) throw new Error(`invalid vault key id ${this.kek.current.id}`);
    if (this.kek.current instanceof LocalKek) this.key = this.kek.current.material;
    this.entriesPath = path.join(dir, 'entries');
    this.keysPath = path.join(dir, 'keys');
    if (!this.readOnly) fs.mkdirSync(this.entriesPath, { recursive: true, mode: 0o700 });
    this.canaryPath = path.join(dir, 'vault.canary');
    if (this.hasKeyrings()) this.checkKek();
    else {
      if (!this.key) throw new Error('a vault from before data keys needs its local vault key to migrate');
      this.checkCanary();
    }
    this.checkLegacyMap();
  }

  /** This vault's current key encryption key id. */
  get kekId(): string { return this.kek.current.id; }

  /** The KEK's raw material (only for ciphertext from before data keys). */
  private legacyKey(): Buffer {
    if (!this.key) throw new Error('ciphertext from before data keys needs the local vault key');
    return this.key;
  }

  private keyId(): string { return this.kek.current.id; }
  /** The operator's explicit word that this key is the vault's. It never
   * accepts a key that opens none of the vault's secrets. */
  private overridden(): boolean {
    return process.env.KARMAX_VAULT_ACCEPT_KEY === this.keyId();
  }
  private refuse(detail: string, overridable: boolean): Error {
    return refusal(this.keyId(), detail, overridable);
  }

  // ── Key encryption keys: canaries and keyrings ──

  private canaryIds(): string[] {
    try { return fs.readdirSync(this.keysPath).filter((name) => name.endsWith('.canary')).map((name) => name.slice(0, -'.canary'.length)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private keyringFiles(): string[] {
    try { return fs.readdirSync(this.keysPath).filter((name) => KEYRING_FILE.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private hasKeyrings(): boolean { return this.canaryIds().length > 0 || this.keyringFiles().length > 0; }
  private keyringPath(scope: string): string {
    return path.join(this.keysPath, `${crypto.createHash('sha256').update(scope).digest('hex')}.json`);
  }
  private known(): KeyEncryptionKey[] { return [this.kek.current, ...this.kek.others]; }

  /** A KEK's canary state, or undefined when it has none; a canary that fails
   * to authenticate refuses the key. */
  private readKekCanary(kek: KeyEncryptionKey): { legacy: boolean } | undefined {
    let raw: string;
    // Missing, or unreadable: re-derived from the keyrings.
    try { raw = fs.readFileSync(path.join(this.keysPath, `${kek.id}.canary`), 'utf8'); } catch { return undefined; }
    return openKekCanary(kek, raw, `vault/keys/${kek.id}.canary`);
  }
  private writeKekCanary(kek: KeyEncryptionKey, legacy: boolean): void {
    if (this.readOnly) return;
    fs.mkdirSync(this.keysPath, { recursive: true, mode: 0o700 });
    writeDurably(path.join(this.keysPath, `${kek.id}.canary`), kekCanaryRecord(kek, legacy));
  }

  /** Every keyring, parsed; damaged ones are skipped here and fail their reads. */
  private keyrings(): Array<{ file: string; ring: Keyring }> {
    return this.keyringFiles().flatMap((file) => {
      let ring: Keyring | undefined;
      try { ring = readableKeyring(fs.readFileSync(path.join(this.keysPath, file), 'utf8')); } catch { ring = undefined; }
      return ring ? [{ file, ring }] : [];
    });
  }

  /**
   * The KEK must be the vault's: its canary authenticates (or, lost, the
   * keyrings carry its wraps), and every data key opens with a key this
   * process knows. A wrong key is refused before anything is written with it;
   * a key whose canary is missing while another known key's opens is a
   * rotation in progress, completed on the first write.
   */
  private checkKek(): void {
    this.scoped = true;
    this.bound = true;
    const canaries = this.canaryIds();
    const current = this.kek.current;
    let state = this.readKekCanary(current);
    if (!state) {
      const opener = this.kek.others.find((kek) => canaries.includes(kek.id) && this.readKekCanary(kek));
      if (opener) state = this.readKekCanary(opener);
      else if (this.keyrings().some(({ ring }) => Object.values(ring.keys).some((key) => key?.wraps?.[current.id]))) {
        // A lost or damaged canary: the keyrings vouch for the key.
        state = { legacy: !this.retiredCanary() };
        try { this.writeKekCanary(current, state.legacy); } catch (error) { if (!cannotWrite(error)) throw error; }
      } else {
        throw this.refuse(canaries.length
          ? `it is ${current.id}, but the vault's data keys are wrapped under ${canaries.join(', ')}`
          : `none of its data keys is wrapped under ${current.id}`, false);
      }
      this.unwrapped = true;
    }
    this.legacy = state!.legacy;
    const { stranded, lacking } = strandedKeys(this.keyrings().map(({ ring }) => ring), current, this.known());
    if (stranded.length) throw strandedRefusal(current.id, stranded);
    if (lacking) this.unwrapped = true;
  }

  /** Has `vault.canary` been replaced by the data-key sentinel (migration finished)? */
  private retiredCanary(): boolean {
    try { return JSON.parse(fs.readFileSync(this.canaryPath, 'utf8'))?.format === SCOPED.format; } catch { return false; }
  }

  private parseRing(scope: string, raw: string): Keyring { return parseKeyring(scope, raw); }
  private readRingRaw(scope: string): string | undefined {
    try { return fs.readFileSync(this.keyringPath(scope), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private unwrapKey(ring: Keyring, kid: string): Buffer { return unwrapDataKey(ring, kid, this.known(), this.kek.current.id); }
  /** A scope's data key by kid, for reading. */
  private dataKey(scope: VaultScope, kid: string): Buffer {
    const raw = this.readRingRaw(scope);
    if (raw === undefined) { this.rings.delete(scope); throw new Error(`the data key ${kid} of ${scope} is destroyed or missing (its keyring is gone)`); }
    let cached = this.rings.get(scope);
    if (cached?.raw !== raw) this.rings.set(scope, cached = { raw, keys: cached?.keys ?? new Map() });
    const known = cached.keys.get(kid);
    if (known) return known;
    const ring = this.parseRing(scope, raw);
    if (!ring.keys[kid]) throw new Error(`the data key ${kid} of ${scope} is destroyed or missing (retired or shredded)`);
    const key = this.unwrapKey(ring, kid);
    cached.keys.set(kid, key);
    return key;
  }
  /** Wrap a new data key under the current KEK, and under every other known
   * KEK that already wraps this keyring (so a rotation in progress keeps working). */
  private newDataKey(ring: Pick<Keyring, 'scope' | 'keys'>): { kid: string; key: Buffer } {
    return mintDataKey(ring, this.kek.current, this.known());
  }
  private writeRing(ring: Keyring, syncDir = true): void {
    fs.mkdirSync(this.keysPath, { recursive: true, mode: 0o700 });
    writeDurably(this.keyringPath(ring.scope), `${JSON.stringify(ring)}\n`, syncDir);
  }
  /** The scope's current data key, creating its keyring on first use. Under the lock. */
  private writableKey(scope: VaultScope): { kid: string; key: Buffer } {
    const raw = this.readRingRaw(scope);
    if (raw === undefined) {
      const ring: Keyring = { format: KEYRING, scope, current: '', keys: {} };
      const created = this.newDataKey(ring);
      ring.current = created.kid;
      this.writeRing(ring);
      return created;
    }
    const ring = this.parseRing(scope, raw);
    if (!ring.keys[ring.current]) throw new Error(`the vault keyring for ${scope} has no current data key; restore it from a backup`);
    return { kid: ring.current, key: this.dataKey(scope, ring.current) };
  }

  // ── Before data keys: the epoch 3 canary and binding ──

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
      if (this.opens(blob, handle, this.legacyKey())) opened++;
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

  /** Every secret's current blob from before data keys, reading `secrets.json` once. */
  private snapshot(): Array<{ handle: string; blob: string }> {
    const secrets = new Map<string, string>();
    for (const file of this.entryFiles()) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this.entriesPath, file), 'utf8'));
        if (typeof entry?.handle === 'string' && typeof entry.blob === 'string' && !isScoped(entry.blob)) secrets.set(entry.handle, entry.blob);
      } catch { /* unreadable: counted by neither side */ }
    }
    if (!this.migrated())
      for (const [handle, blob] of Object.entries(this.readDb())) if (typeof blob === 'string') secrets.set(handle, blob);
    return [...secrets].map(([handle, blob]) => ({ handle, blob }));
  }

  /** `vault.key` when `KARMAX_VAULT_KEY` supplies another key. */
  private otherKnownKeys(): Buffer[] {
    return this.kek.others.flatMap((kek) => kek instanceof LocalKek ? [kek.material] : []);
  }

  private opens(blob: string, handle: string, key: Buffer): boolean {
    try { this.legacyDecrypt(blob, handle, key, true); return true; } catch { return false; }
  }

  /** The recorded bound state, or undefined when there is no usable canary. */
  private readCanary(): boolean | undefined {
    let blob: unknown;
    try { blob = JSON.parse(fs.readFileSync(this.canaryPath, 'utf8')).blob; } catch { return undefined; }
    const parts = typeof blob === 'string' ? blob.split('.') : [];
    if (parts.length !== 4 || parts[0] !== 'v2' || Buffer.from(parts[1]!, 'base64').length !== 12
      || Buffer.from(parts[2]!, 'base64').length !== 16) return undefined;
    let state: { canary?: string; bound?: unknown } | undefined;
    try { state = JSON.parse(this.legacyDecrypt(blob as string, CANARY_HANDLE)); } catch { state = undefined; }
    if (state?.canary !== CANARY) {
      this.canaryFailed = true;
      // Overridden, the secrets decide as for a missing canary: the key must still open some.
      if (this.overridden()) { console.error('[vault] KARMAX_VAULT_ACCEPT_KEY: replacing a canary this key does not open'); return undefined; }
      const opensAny = this.snapshot().some(({ handle, blob }) => this.opens(blob, handle, this.legacyKey()));
      throw this.refuse('vault/vault.canary fails to authenticate under KARMAX_VAULT_KEY (or vault.key)', opensAny);
    }
    return state.bound === true;
  }

  /** Best effort: a vault it cannot write (a restore drill) is checked, not recorded. */
  private writeCanary(): void {
    if (this.readOnly) return;
    const blob = this.legacyEncrypt(JSON.stringify({ canary: CANARY, bound: this.bound }), CANARY_HANDLE);
    try { writeDurably(this.canaryPath, `${JSON.stringify({ format: CANARY, blob })}\n`); }
    catch (error) { if (!cannotWrite(error)) throw error; }
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

  /** `v2.` ciphertext authenticates its handle as additional data (AU-27). It
   * is written only while binding, never after data keys exist. */
  private legacyEncrypt(plain: string, handle: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.legacyKey(), iv);
    cipher.setAAD(boundTo(handle));
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v2.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }
  /** Unbound (pre-v2) ciphertext opens only until `bind` has bound the vault
   * (or, `anyFormat`, to recognise which key wrote it). */
  private legacyDecrypt(blob: string, handle: string, key = this.legacyKey(), anyFormat = false): string {
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

  // ── Ciphertext under data keys ──

  private encrypt(plain: string, handle: string, scope: VaultScope, data?: { kid: string; key: Buffer }): string {
    return sealEntry(plain, handle, scope, data ?? this.writableKey(scope));
  }
  /** Any stored blob: `v3.` under its scope's data key, and older formats only
   * until their migrations have run. */
  private decrypt(blob: string, handle: string, scope: VaultScope | undefined): string {
    if (!isScoped(blob)) {
      if (this.scoped && !this.legacy)
        throw new Error(`vault entry for ${handle} is not under a data key (older ciphertext after the data epoch 4 migration); restore it from a backup`);
      return this.legacyDecrypt(blob, handle);
    }
    return openEntry(blob, handle, scope, (kid) => this.dataKey(scope!, kid));
  }

  private entryPath(handle: string): string {
    return path.join(this.entriesPath, crypto.createHash('sha256').update(handle).digest('hex') + '.json');
  }
  /** Entry files; none before the first boot of the epoch 3 release created `entries/`. */
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

  private parseEntry(raw: string, handle?: string): EntryRecord {
    let entry: { handle?: unknown; blob?: unknown; previous?: unknown; scope?: unknown; unresolved?: unknown };
    try { entry = JSON.parse(raw); }
    catch { throw new Error(`vault entry for ${handle ?? 'a handle'} is unreadable; restore it from a backup`); }
    if ((handle !== undefined && entry?.handle !== handle) || typeof entry?.handle !== 'string' || typeof entry.blob !== 'string')
      throw new Error('vault entry is corrupt');
    const previous = entry.previous ?? [];
    if (!Array.isArray(previous) || previous.length > 5 || previous.some(blob => typeof blob !== 'string'))
      throw new Error('vault history is corrupt');
    if (entry.scope !== undefined && !isVaultScope(entry.scope)) throw new Error(`vault entry for ${entry.handle} records an invalid scope`);
    return { handle: entry.handle, blob: entry.blob, previous: previous as string[],
      ...(entry.scope ? { scope: entry.scope as VaultScope } : {}), ...(entry.unresolved === true ? { unresolved: true } : {}) };
  }

  private readEntry(handle: string): EntryRecord | undefined {
    const raw = this.readEntryFile(handle);
    if (raw !== undefined) return this.parseEntry(raw, handle);
    if (this.migrated()) return undefined;
    const blob = this.readDb()[handle];
    return blob === undefined ? undefined : { handle, blob, previous: [] };
  }

  private writeEntry(entry: EntryRecord, syncDir = true): void {
    writeDurably(this.entryPath(entry.handle), JSON.stringify({ handle: entry.handle, ...(entry.scope ? { scope: entry.scope } : {}),
      blob: entry.blob, ...(entry.previous.length ? { previous: entry.previous } : {}), ...(entry.unresolved ? { unresolved: true } : {}) }), syncDir);
  }

  private validateSecret(secret: string): void { validateSecret(secret); }
  private validateScope(scope: VaultScope): void { validateScope(scope); }

  /**
   * The entry, ready to be written as `scope`. A secret belongs to the scope
   * recorded on it: a write naming another is refused, so a confused caller
   * can never move one tenant's secret under another tenant's key. Only an
   * owner the migration could not find yields, to the first write that names one.
   */
  private claim(entry: EntryRecord | undefined, scope: VaultScope): EntryRecord | undefined {
    if (!entry?.scope || entry.scope === scope) return entry;
    if (!entry.unresolved)
      throw new Error(`vault entry for ${entry.handle} belongs to ${entry.scope}; refusing to write it as ${scope}`);
    const reencrypt = (blob: string) => this.encrypt(this.decrypt(blob, entry.handle, entry.scope), entry.handle, scope);
    return { handle: entry.handle, scope, blob: reencrypt(entry.blob), previous: entry.previous.map(reencrypt) };
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    if (this.readOnly) throw new Error('this vault was opened read-only');
    const release = process.platform === 'linux'
      ? await acquireFileLock(`${this.dbPath}.lock`) : undefined;
    try {
      // Another process may have moved the vault to data keys meanwhile.
      if (!this.scoped && this.hasKeyrings()) this.checkKek();
      if (!this.scoped) {
        if (!this.bound || !this.moved()) this.bind();
        this.startScopes();
      }
      if (this.unwrapped) this.wrapAll();
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
          const plain = this.legacyDecrypt(blob, handle);
          planned.push({ kind: 'entry', file, handle, current: blob.startsWith('v2.') ? blob : this.legacyEncrypt(plain, handle),
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
      // Already under a data key: nothing to bind.
      if (isScoped(entry?.blob)) continue;
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
        const plain = this.legacyDecrypt(blob, handle);
        return blob.startsWith('v2.') ? blob : this.legacyEncrypt(plain, handle);
      };
      let current: string;
      let bytes = 0;
      try { current = rebind(entry.blob); bytes = Buffer.byteLength(this.legacyDecrypt(current, handle), 'utf8'); }
      catch (error) { planned.push({ kind: 'damaged', file, raw, handle, reason: (error as Error).message, fromMap: false }); continue; }
      const history = Array.isArray(entry.previous) ? entry.previous : [];
      const kept = history.flatMap(blob => { try { return [rebind(blob)]; } catch { return []; } });
      planned.push({ kind: 'entry', file, handle, current, kept, dropped: history.length - kept.length, fromMap: false, bytes,
        changed: current !== entry.blob || kept.some((blob, i) => blob !== history[i]) || kept.length < history.length });
    }
    return planned;
  }

  /** Entries holding ciphertext from before data keys (current or a revision). */
  private unscopedFiles(): string[] {
    return this.entryFiles().filter((file) => {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this.entriesPath, file), 'utf8'));
        return typeof entry?.blob === 'string' && (!isScoped(entry.blob)
          || (Array.isArray(entry.previous) && entry.previous.some((blob: unknown) => !isScoped(blob))));
      } catch { return false; }
    });
  }

  /** What `migrate` and `migrateToScopes` would do, without writing (see `inspectVault`). */
  inspect(): VaultInspection {
    const migrated = this.moved();
    const bound = this.scoped || (this.bound && migrated);
    const planned = bound ? [] : this.plan();
    const report: VaultInspection = { key: 'accepted', bound, rebind: 0, toScopes: 0, quarantine: [], unreadable: [] };
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
    if (!this.scoped || this.legacy)
      report.toScopes = bound ? this.unscopedFiles().length : planned.filter((entry) => entry.kind === 'entry').length;
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
        if (entry.changed) this.writeEntry({ handle: entry.handle, blob: entry.current, previous: entry.kept }, false);
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

  /** Begin writing under data keys: the current KEK's canary records whether
   * older ciphertext remains to migrate. With none (a new vault), the epoch 3
   * canary is retired at once. */
  private startScopes(): void {
    const legacy = this.unscopedFiles().length > 0;
    this.writeKekCanary(this.kek.current, legacy);
    this.scoped = true;
    this.legacy = legacy;
    if (!legacy) this.retireCanary();
  }
  private retireCanary(): void {
    if (!this.retiredCanary()) writeDurably(this.canaryPath, `${JSON.stringify(SCOPED)}\n`);
  }

  /**
   * Move a pre-epoch-4 vault under data keys (SS-1): re-encrypt every `v2.`
   * secret and revision under the data key of the scope `resolve` names (the
   * database knows who owns each handle), recording that scope on the entry.
   * Handles without a known owner go under the installation's key, marked
   * `unresolved`, until a write names their owner. Each entry is rewritten
   * atomically and the canary flips only when none remains, so a crash midway
   * finishes on the next boot; with nothing left to do this is a no-op.
   */
  async migrateToScopes(resolve: (handles: string[]) => Promise<Map<string, VaultScope>>): Promise<ScopeMigration> {
    await this.mutate(() => undefined);
    const report: ScopeMigration = { migrated: 0, unresolved: [], byScope: {} };
    if (!this.legacy) return report;
    const pending = this.unscopedFiles().flatMap((file) => {
      try { return [String(JSON.parse(fs.readFileSync(path.join(this.entriesPath, file), 'utf8')).handle)]; } catch { return []; }
    });
    const owners = await resolve(pending);
    return this.mutate(() => {
      for (const file of this.unscopedFiles()) {
        let entry: EntryRecord;
        try { entry = this.parseEntry(fs.readFileSync(path.join(this.entriesPath, file), 'utf8')); }
        catch (error) { this.quarantine({ kind: 'damaged', file, reason: (error as Error).message, fromMap: false }); continue; }
        const owner = entry.scope ?? owners.get(entry.handle);
        const scope = owner ?? INSTALLATION_SCOPE;
        const convert = (blob: string) => isScoped(blob) ? blob : this.encrypt(this.legacyDecrypt(blob, entry.handle), entry.handle, scope);
        let blob: string;
        try { blob = convert(entry.blob); }
        catch (error) { this.quarantine({ kind: 'damaged', file, handle: entry.handle, reason: (error as Error).message, fromMap: false }); continue; }
        const previous = entry.previous.flatMap((older) => { try { return [convert(older)]; } catch { return []; } });
        if (previous.length < entry.previous.length)
          this.quarantine({ kind: 'damaged', file, handle: entry.handle,
            reason: `${entry.previous.length - previous.length} earlier revision(s) would not open`, fromMap: false }, true);
        this.writeEntry({ handle: entry.handle, scope, blob, previous, ...(owner ? {} : { unresolved: true }) }, false);
        report.migrated++;
        report.byScope[scope.split(':')[0]!] = (report.byScope[scope.split(':')[0]!] ?? 0) + 1;
        if (!owner) report.unresolved.push(entry.handle);
      }
      syncDirectory(this.entriesPath);
      // Kept until the audit log has it (`recordScopeMigration`), even across a crash.
      writeDurably(this.scopeReportPath(), JSON.stringify(report));
      this.writeKekCanary(this.kek.current, false);
      this.legacy = false;
      this.retireCanary();
      return report;
    });
  }

  private scopeReportPath(): string { return path.join(path.dirname(this.entriesPath), 'scope-migration.json'); }

  /** The epoch 4 migration's report, until `acknowledgeScopeMigration`. */
  unauditedScopeMigration(): ScopeMigration | undefined {
    try { return JSON.parse(fs.readFileSync(this.scopeReportPath(), 'utf8')); } catch { return undefined; }
  }
  acknowledgeScopeMigration(): void {
    if (!this.readOnly) fs.rmSync(this.scopeReportPath(), { force: true });
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
      sweep(this.keysPath, 0);
      sweep(vaultDir, 60_000);
      let held: string[] = [];
      try { held = fs.readdirSync(quarantine); } catch { /* none */ }
      for (const file of held.filter((name) => !name.endsWith('.why')))
        if (Date.now() - fs.statSync(path.join(quarantine, file)).mtimeMs > QUARANTINE_RETENTION_MS)
          for (const stale of [file, `${file}.why`]) fs.rmSync(path.join(quarantine, stale), { force: true });
      // Rollback copies an earlier build of the epoch 3 release kept.
      for (const name of fs.readdirSync(vaultDir))
        if (name.startsWith('entries.pre-v2')) fs.rmSync(path.join(vaultDir, name), { recursive: true, force: true });
    });
    return { quarantined: this.unaudited() };
  }

  /** `history: false` replaces the secret and forgets its earlier revisions,
   * for a value that must not survive in them (a card's CVC, AU-31). */
  async put(handle: string, secret: string, scope: VaultScope, options: { history?: boolean } = {}): Promise<void> {
    this.validateScope(scope);
    await this.mutate(() => {
      const stored = this.readEntry(handle);
      const prior = this.claim(stored, scope);
      const priorSecret = prior === undefined ? undefined : this.decrypt(prior.blob, handle, prior.scope);
      // A rewrite that strictly shrinks a stored secret is always allowed: an
      // earlier release stored card billing fields with no limit, and their
      // CVC must still come out (AU-31). Anything else keeps the limit.
      const bytes = Buffer.byteLength(secret, 'utf8');
      if (bytes > SECRET_LIMIT && !(priorSecret !== undefined && bytes < Buffer.byteLength(priorSecret, 'utf8')))
        this.validateSecret(secret);
      if (options.history === false) return this.writeEntry({ handle, scope, blob: this.encrypt(secret, handle, scope), previous: [] });
      if (priorSecret === secret) {
        if (prior !== stored) this.writeEntry(prior!);
        return;
      }
      const previous = prior === undefined ? [] : [prior.blob, ...prior.previous].slice(0, 5);
      this.writeEntry({ handle, scope, blob: this.encrypt(secret, handle, scope), previous });
    });
  }

  async putIfAbsent(handle: string, secret: string, scope: VaultScope): Promise<void> {
    this.validateSecret(secret);
    this.validateScope(scope);
    await this.mutate(() => {
      const existing = this.readEntry(handle);
      if (!existing) return this.writeEntry({ handle, scope, blob: this.encrypt(secret, handle, scope), previous: [] });
      // Never rotate a concurrent creator's value; only correct a guessed owner.
      if (existing.unresolved && existing.scope !== scope) this.writeEntry(this.claim(existing, scope)!);
    });
  }

  async move(handle: string, nextHandle: string, scope: VaultScope, replacement?: string): Promise<void> {
    this.validateScope(scope);
    if (replacement !== undefined) this.validateSecret(replacement);
    await this.mutate(() => {
      const prior = this.claim(this.readEntry(handle), scope);
      if (nextHandle !== handle) this.claim(this.readEntry(nextHandle), scope);
      const secret = replacement ?? (prior === undefined ? undefined : this.decrypt(prior.blob, handle, prior.scope));
      if (secret === undefined) throw new Error(`credential broker: no secret for handle ${handle}`);
      const history = prior?.previous ?? [];
      const previous = prior !== undefined && this.decrypt(prior.blob, handle, prior.scope) !== secret
        ? [prior.blob, ...history].slice(0, 5) : history;
      // History is bound to the old handle; carry it across re-encrypted.
      this.writeEntry({ handle: nextHandle, scope, blob: this.encrypt(secret, nextHandle, scope),
        previous: previous.map(blob => nextHandle === handle ? blob : this.encrypt(this.decrypt(blob, handle, prior?.scope), nextHandle, scope)) });
      if (nextHandle !== handle) fs.rmSync(this.entryPath(handle), { force: true });
    });
  }
  async has(handle: string): Promise<boolean> {
    return this.readEntry(handle) !== undefined;
  }
  /** The scope a secret belongs to; undefined for none, or one not yet migrated. */
  async scopeOf(handle: string): Promise<VaultScope | undefined> {
    return this.readEntry(handle)?.scope;
  }
  /** Internal: only the broker should call this. */
  async reveal(handle: string, revision = 0): Promise<string | undefined> {
    return this.revealNow(handle, revision);
  }
  private revealNow(handle: string, revision = 0): string | undefined {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid vault revision');
    const entry = this.readEntry(handle);
    const blob = revision === 0 ? entry?.blob : entry?.previous[revision - 1];
    return blob === undefined ? undefined : this.decrypt(blob, handle, entry!.scope);
  }
  async list(): Promise<string[]> {
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
      if (this.revealNow(handle) !== observed) return false;
      fs.rmSync(this.entryPath(handle), { force: true });
      return true;
    });
  }

  // ── Rotation and shredding ──

  /** Entries of one scope, parsed (the unreadable are skipped). */
  private scopeEntries(scope: VaultScope): EntryRecord[] {
    return this.entryFiles().flatMap((file) => {
      try {
        const entry = this.parseEntry(fs.readFileSync(path.join(this.entriesPath, file), 'utf8'));
        return entry.scope === scope ? [entry] : [];
      } catch { return []; }
    });
  }

  /**
   * Replace a scope's data key: mint a new one (or, after an interruption,
   * keep the one already minted), re-encrypt every entry of the scope and
   * its revisions under it, then retire the old keys from the keyring.
   * Quarantined copies stay under the retired key and stop opening.
   */
  async rotateDataKey(scope: VaultScope): Promise<{ reencrypted: number; retired: string[] }> {
    this.validateScope(scope);
    return this.mutate(() => {
      const raw = this.readRingRaw(scope);
      if (raw === undefined) return { reencrypted: 0, retired: [] };
      const ring = this.parseRing(scope, raw);
      if (Object.keys(ring.keys).length === 1) {
        ring.current = this.newDataKey(ring).kid;
        this.writeRing(ring);
      }
      const data = { kid: ring.current, key: this.dataKey(scope, ring.current) };
      let reencrypted = 0;
      for (const entry of this.scopeEntries(scope)) {
        const blobs = [entry.blob, ...entry.previous];
        if (blobs.every((blob) => blob.split('.')[1] === data.kid)) continue;
        const reencrypt = (blob: string) => blob.split('.')[1] === data.kid ? blob
          : this.encrypt(this.decrypt(blob, entry.handle, scope), entry.handle, scope, data);
        this.writeEntry({ ...entry, blob: reencrypt(entry.blob), previous: entry.previous.map(reencrypt) }, false);
        reencrypted++;
      }
      syncDirectory(this.entriesPath);
      const retired = Object.keys(ring.keys).filter((kid) => kid !== data.kid);
      ring.keys = { [data.kid]: ring.keys[data.kid]! };
      this.writeRing(ring);
      return { reencrypted, retired };
    });
  }

  /**
   * Crypto-shred a scope (organization deletion, account erasure): delete its
   * entries and quarantined copies, then its keyring. Whatever ciphertext of
   * the scope survives anywhere else (an old snapshot of a file) no longer
   * opens; backups taken before still hold the wrapped key until they expire
   * (wiki features/vault-encryption). Safe to repeat.
   */
  async destroyScope(scope: VaultScope): Promise<{ entries: number; quarantined: number }> {
    this.validateScope(scope);
    if (scope === INSTALLATION_SCOPE) throw new Error('the installation scope cannot be destroyed');
    return this.mutate(() => {
      let entries = 0, quarantined = 0;
      for (const entry of this.scopeEntries(scope)) { fs.rmSync(this.entryPath(entry.handle), { force: true }); entries++; }
      const dir = path.join(this.entriesPath, 'quarantine');
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { /* none */ }
      for (const name of names.filter((file) => !file.endsWith('.why') && !file.endsWith('.tmp'))) {
        let held: { scope?: unknown } | undefined;
        try { held = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
        if (held?.scope !== scope) continue;
        for (const file of [name, `${name}.why`]) fs.rmSync(path.join(dir, file), { force: true });
        quarantined++;
      }
      if (quarantined) syncDirectory(dir);
      syncDirectory(this.entriesPath);
      fs.rmSync(this.keyringPath(scope), { force: true });
      this.rings.delete(scope);
      if (fs.existsSync(this.keysPath)) syncDirectory(this.keysPath);
      return { entries, quarantined };
    });
  }

  /** Give every data key a wrap under the current KEK (opening it with
   * another known KEK), then the current KEK's canary, last. */
  private wrapAll(): number {
    let wrapped = 0;
    const current = this.kek.current;
    for (const { ring } of this.keyrings()) {
      let changed = false;
      for (const [kid, entry] of Object.entries(ring.keys)) {
        if (!entry.wraps[current.id]) {
          entry.wraps[current.id] = current.wrap(this.unwrapKey(ring, kid), wrappedFor(ring.scope, kid));
          changed = true;
        }
        wrapped++;
      }
      if (changed) this.writeRing(ring, false);
    }
    if (fs.existsSync(this.keysPath)) syncDirectory(this.keysPath);
    this.writeKekCanary(current, this.legacy);
    this.unwrapped = false;
    return wrapped;
  }

  /**
   * Every entry, keyring, KEK canary and quarantined copy exactly as stored,
   * read under the lock, for the move into the database (`vault-backend.ts`).
   * Nothing is decrypted. An entry that does not parse is quarantined first,
   * as binding does, rather than stopping the move or being dropped silently.
   */
  async exportRows(): Promise<VaultRows> {
    this.requireScoped();
    return this.mutate(() => {
      const rows: VaultRows = { canaries: [], keyrings: [], entries: [], quarantine: [] };
      for (const id of this.canaryIds())
        rows.canaries.push({ kek: id, record: fs.readFileSync(path.join(this.keysPath, `${id}.canary`), 'utf8') });
      for (const file of this.keyringFiles()) {
        const raw = fs.readFileSync(path.join(this.keysPath, file), 'utf8');
        const ring = readableKeyring(raw);
        if (!ring || this.keyringPath(ring.scope) !== path.join(this.keysPath, file))
          throw new Error(`cannot move the vault: vault/keys/${file} is not a keyring of the scope it is named for; restore it from a backup`);
        rows.keyrings.push({ scope: ring.scope, ring: raw.trimEnd() });
      }
      for (const file of this.entryFiles()) {
        let entry: EntryRecord;
        try {
          entry = this.parseEntry(fs.readFileSync(path.join(this.entriesPath, file), 'utf8'));
          if (this.entryPath(entry.handle) !== path.join(this.entriesPath, file)) throw new Error('not the entry of the handle it is named for');
          if (!entry.scope || ![entry.blob, ...entry.previous].every(isScoped)) throw new Error('not under a data key');
        } catch (error) {
          this.quarantine({ kind: 'damaged', file, reason: (error as Error).message, fromMap: false });
          continue;
        }
        rows.entries.push({ handle: entry.handle, scope: entry.scope, blob: entry.blob, previous: entry.previous, unresolved: entry.unresolved === true });
      }
      const dir = path.join(this.entriesPath, 'quarantine');
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { /* none */ }
      for (const name of names.filter((file) => !file.endsWith('.why') && !file.endsWith('.tmp'))) {
        const record = fs.readFileSync(path.join(dir, name), 'utf8');
        let held: { handle?: unknown; scope?: unknown } = {};
        try { held = JSON.parse(record); } catch { /* kept as it is */ }
        let why: { reason?: unknown } = {};
        try { why = JSON.parse(fs.readFileSync(path.join(dir, `${name}.why`), 'utf8')); } catch { /* audited already */ }
        rows.quarantine.push({ id: name, record, createdAt: Math.floor(fs.statSync(path.join(dir, name)).mtimeMs),
          reason: typeof why.reason === 'string' ? why.reason : 'quarantined before the move (see the audit log)',
          ...(typeof held.handle === 'string' ? { handle: held.handle } : {}), ...(isVaultScope(held.scope) ? { scope: held.scope } : {}) });
      }
      return rows;
    });
  }

  /**
   * After the move into the database: retire this directory as a vault. The
   * sentinel goes in first (an earlier release then refuses the directory),
   * then every entry, keyring, canary and quarantined copy is deleted: a
   * stale keyring left on disk would outlive crypto-shredding. `vault.key`
   * stays: it is the KEK, not part of the vault. Repeatable.
   */
  static retire(dir: string): void {
    if (!fs.existsSync(dir)) return;
    if (!movedToDatabase(dir)) writeDurably(path.join(dir, 'secrets.json'), `${JSON.stringify(MOVED_TO_DATABASE)}\n`);
    const entries = path.join(dir, 'entries');
    fs.mkdirSync(entries, { recursive: true, mode: 0o700 });
    // Without it, an epoch 3 or 4 release would not read secrets.json, and would start on an empty vault.
    if (!fs.existsSync(path.join(entries, '.migrated'))) writeDurably(path.join(entries, '.migrated'), '');
    const remove = (sub: string, keep: (name: string) => boolean) => {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(dir, sub)); } catch { return; }
      for (const name of names) if (!keep(name)) fs.rmSync(path.join(dir, sub, name), { recursive: true, force: true });
      syncDirectory(path.join(dir, sub));
    };
    remove('entries', (name) => name === '.migrated');
    for (const name of ['keys', 'scope-migration.json', 'secrets.json.lock']) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    syncDirectory(dir);
  }

  private requireScoped(): void {
    if (!this.scoped || this.legacy)
      throw new Error('the vault still holds secrets from before data keys: let the first boot of this release finish the data epoch 4 migration before rotating its key');
  }

  /** KEK rotation, step 1 (open with the new KEK as current and the old one
   * among `others`): wrap every data key under the new KEK. The old KEK keeps
   * opening everything until `pruneKeks`. Repeatable. */
  async wrapUnderCurrentKek(): Promise<{ wrapped: number }> {
    this.requireScoped();
    return this.mutate(() => ({ wrapped: this.wrapAll() }));
  }

  /** KEK rotation, step 3 (after the switch to the new KEK): remove every
   * other KEK's canary, then its wraps. From the first step on, the old KEK
   * is refused. Repeatable. */
  async pruneKeks(): Promise<{ pruned: string[] }> {
    this.requireScoped();
    return this.mutate(() => {
      const current = this.kek.current.id;
      const pruned = new Set(this.canaryIds().filter((id) => id !== current));
      for (const id of pruned) fs.rmSync(path.join(this.keysPath, `${id}.canary`), { force: true });
      if (pruned.size) syncDirectory(this.keysPath);
      for (const { ring } of this.keyrings()) {
        let changed = false;
        for (const entry of Object.values(ring.keys))
          for (const id of Object.keys(entry.wraps)) if (id !== current) { delete entry.wraps[id]; pruned.add(id); changed = true; }
        if (changed) this.writeRing(ring, false);
      }
      if (fs.existsSync(this.keysPath)) syncDirectory(this.keysPath);
      return { pruned: [...pruned].sort() };
    });
  }

  async keyStatus(): Promise<VaultKeyStatus> {
    const wraps: Record<string, number> = {};
    const rings = this.keyrings();
    for (const { ring } of rings)
      for (const entry of Object.values(ring.keys)) for (const id of Object.keys(entry.wraps ?? {})) wraps[id] = (wraps[id] ?? 0) + 1;
    return { kek: this.kek.current.id, scoped: this.scoped && !this.legacy, keyrings: rings.length,
      scopes: rings.map(({ ring }) => ring.scope).sort(), wraps, canaries: this.canaryIds() };
  }
}
