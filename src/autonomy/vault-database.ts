import type { SqlDatabase } from '../store/sql.js';
import { noteExternalEffect } from '../store/transaction-effects.js';
import { Vault } from './vault.js';
import { INSTALLATION_SCOPE, isVaultScope, type KekSource, type KeyEncryptionKey, type VaultScope } from './vault-keys.js';
import { KEK_ID, KEYRING, SECRET_LIMIT, isScoped, kekCanaryRecord, mintDataKey, openEntry, openKekCanary, parseKeyring,
  readableKeyring, refusal, sealEntry, strandedKeys, strandedRefusal, unwrapDataKey, validateScope, validateSecret, wrappedFor,
  type Keyring, type SecretVault, type VaultKeyStatus } from './vault-crypto.js';

/**
 * The vault as rows of the application database (wiki
 * planned/host-local-state, step 1): what makes the secret map shared by every
 * process and host instead of one host's files under a Linux lock.
 *
 * Rows hold exactly what the file vault's files held (`vault-crypto.ts`):
 * `v3.` ciphertext under the scope's data key, bound to its scope and handle,
 * and keyrings whose data keys are wrapped under the KEK, which never leaves
 * the app host. No plaintext ever reaches the database, and a dump of it is
 * useless without the vault key.
 *
 * Concurrency: every entry write is a compare-and-swap on the row's `version`,
 * retried on conflict. A write share-locks its scope's keyring row (PostgreSQL
 * `FOR SHARE`); rotating or shredding a scope locks it exclusively, so no write
 * can land under a data key being retired. Lock order (STORE_LOCK_ORDER): any
 * advisory key the caller holds (`vault:<orgId>`), then the keyring row, then
 * entry rows. SQLite serializes transactions.
 */
const QUARANTINE_RETENTION_MS = 30 * 86_400_000;
const ATTEMPTS = 8;

interface EntryRow { handle: string; scope: string; blob: string; previous: string; unresolved: number | boolean; version: number; ring?: string | null }
interface EntryRecord { handle: string; scope: VaultScope; blob: string; previous: string[]; unresolved: boolean; version: number }

/** Another writer changed the row between this write's read and its swap: a
 * serialization failure (SQLSTATE 40001), so a caller's Store transaction
 * that this write joined is re-run like any other. */
class WriteConflict extends Error { readonly code = '40001'; }
const retryable = (error: unknown) => error instanceof WriteConflict
  || ['40001', '40P01'].includes(String((error as { code?: unknown })?.code ?? ''));

export class DatabaseVault implements SecretVault {
  /** Unwrapped data keys by scope, valid while the keyring row's text is unchanged. */
  private rings = new Map<string, { raw: string; keys: Map<string, Buffer> }>();
  /** Some data keys lack a wrap under the current KEK; wrapped on the first write. */
  private unwrapped = false;

  private constructor(private db: SqlDatabase, private kek: KekSource, private readOnly: boolean,
    private shredRetired?: (scope: VaultScope) => void) {}

  /**
   * Open the vault, refusing a KEK that is not its own before anything is
   * written with it: the KEK's canary authenticates (or, lost, the keyrings
   * carry its wraps), and every data key opens with a key this process knows.
   * A new vault records the KEK's canary; `readOnly` records nothing.
   */
  static async open(db: SqlDatabase, options: { kek: KekSource; readOnly?: boolean; retired?: string }): Promise<DatabaseVault> {
    const retired = options.retired;
    const vault = new DatabaseVault(db, options.kek, options.readOnly === true,
      retired ? (scope) => Vault.shredRetired(retired, scope) : undefined);
    if (!KEK_ID.test(options.kek.current.id)) throw new Error(`invalid vault key id ${options.kek.current.id}`);
    await vault.checkKek();
    return vault;
  }

  get kekId(): string { return this.kek.current.id; }
  private known(): KeyEncryptionKey[] { return [this.kek.current, ...this.kek.others]; }
  private lock(mode: 'SHARE' | 'UPDATE'): string { return this.db.dialect === 'postgres' ? ` FOR ${mode}` : ''; }

  private async canaries(): Promise<Map<string, string>> {
    const rows = await this.db.prepare('SELECT kek, record FROM vault_kek_canaries ORDER BY kek').all() as Array<{ kek: string; record: string }>;
    return new Map(rows.map((row) => [row.kek, row.record]));
  }
  private async keyrings(lock = ''): Promise<Array<{ ring: Keyring; version: number }>> {
    const rows = await this.db.prepare(`SELECT ring, version FROM vault_keyrings ORDER BY scope${lock}`).all() as Array<{ ring: string; version: number }>;
    return rows.flatMap((row) => { const ring = readableKeyring(row.ring); return ring ? [{ ring, version: Number(row.version) }] : []; });
  }
  private async writeCanary(kek: KeyEncryptionKey): Promise<void> {
    await this.db.prepare('INSERT INTO vault_kek_canaries (kek, record) VALUES (?, ?) ON CONFLICT(kek) DO UPDATE SET record=excluded.record')
      .run(kek.id, kekCanaryRecord(kek, false));
  }

  private async checkKek(): Promise<void> {
    const canaries = await this.canaries();
    const current = this.kek.current;
    const where = (id: string) => `the vault key canary for ${id}`;
    const accepted = canaries.has(current.id) && openKekCanary(current, canaries.get(current.id)!, where(current.id));
    const rings = (await this.keyrings()).map(({ ring }) => ring);
    if (!accepted) {
      const opener = this.kek.others.find((kek) => canaries.has(kek.id) && openKekCanary(kek, canaries.get(kek.id)!, where(kek.id)));
      if (opener) this.unwrapped = true; // a KEK rotation in progress
      else if (rings.some((ring) => Object.values(ring.keys).some((key) => key?.wraps?.[current.id]))) {
        // A lost or damaged canary: the keyrings vouch for the key.
        if (!this.readOnly) await this.writeCanary(current);
      } else if (!canaries.size && !rings.length) {
        if (!this.readOnly) await this.writeCanary(current); // a new vault
      } else {
        throw refusal(current.id, canaries.size
          ? `it is ${current.id}, but the vault's data keys are wrapped under ${[...canaries.keys()].join(', ')}`
          : `none of its data keys is wrapped under ${current.id}`, false);
      }
    }
    const { stranded, lacking } = strandedKeys(rings, current, this.known());
    if (stranded.length) throw strandedRefusal(current.id, stranded);
    if (lacking) this.unwrapped = true;
  }

  // ── Data keys ──

  /** A scope's data key by kid, from the keyring row's text. */
  private dataKey(scope: VaultScope, kid: string, raw: string | null | undefined): Buffer {
    if (raw == null) { this.rings.delete(scope); throw new Error(`the data key ${kid} of ${scope} is destroyed or missing (its keyring is gone)`); }
    let cached = this.rings.get(scope);
    if (cached?.raw !== raw) this.rings.set(scope, cached = { raw, keys: new Map() });
    const known = cached.keys.get(kid);
    if (known) return known;
    const ring = parseKeyring(scope, raw);
    if (!ring.keys[kid]) throw new Error(`the data key ${kid} of ${scope} is destroyed or missing (retired or shredded)`);
    const key = unwrapDataKey(ring, kid, this.known(), this.kek.current.id);
    cached.keys.set(kid, key);
    return key;
  }
  private open(blob: string, handle: string, scope: VaultScope, ring: string | null | undefined): string {
    if (!isScoped(blob)) throw new Error(`vault entry for ${handle} is not under a data key; restore it from a backup`);
    return openEntry(blob, handle, scope, (kid) => this.dataKey(scope, kid, ring));
  }

  // ── Rows ──

  private parse(row: EntryRow | undefined): EntryRecord | undefined {
    if (!row) return undefined;
    let previous: unknown;
    try { previous = JSON.parse(row.previous || '[]'); } catch { throw new Error(`vault history for ${row.handle} is corrupt`); }
    if (!Array.isArray(previous) || previous.length > 5 || previous.some((blob) => typeof blob !== 'string'))
      throw new Error(`vault history for ${row.handle} is corrupt`);
    if (!isVaultScope(row.scope)) throw new Error(`vault entry for ${row.handle} records an invalid scope`);
    return { handle: row.handle, scope: row.scope, blob: row.blob, previous: previous as string[],
      unresolved: row.unresolved === true || Number(row.unresolved) === 1, version: Number(row.version) };
  }
  private async readWithRing(handle: string): Promise<{ entry?: EntryRecord; ring?: string | null }> {
    const row = await this.db.prepare(`SELECT e.handle, e.scope, e.blob, e.previous, e.unresolved, e.version, k.ring
      FROM vault_entries e LEFT JOIN vault_keyrings k ON k.scope = e.scope WHERE e.handle = ?`).get(handle) as EntryRow | undefined;
    return { entry: this.parse(row), ring: row?.ring };
  }

  /**
   * Run a write: a transaction that reads what it needs, then swaps rows only
   * if they are unchanged, retried from scratch on a conflict. Inside a
   * caller's transaction it joins that transaction; a conflict (40001) then
   * re-runs the caller's outermost transaction (`SqlDatabase.transaction`).
   */
  private async write<T>(operation: (tx: WriteContext) => Promise<T>): Promise<T> {
    if (this.readOnly) throw new Error('this vault was opened read-only');
    const nested = this.db.inTransaction();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async () => {
          if (this.unwrapped) await this.wrapAll();
          return operation(new WriteContext(this));
        });
      } catch (error) {
        if (nested || attempt >= ATTEMPTS || !retryable(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
      }
    }
  }

  /** @internal A scope's keyring row, share-locked (or exclusively, to change it). */
  async lockRing(scope: VaultScope, mode: 'SHARE' | 'UPDATE'): Promise<{ raw: string; version: number } | undefined> {
    const row = await this.db.prepare(`SELECT ring, version FROM vault_keyrings WHERE scope = ?${this.lock(mode)}`).get(scope) as
      { ring: string; version: number } | undefined;
    return row ? { raw: row.ring, version: Number(row.version) } : undefined;
  }
  /** @internal The scope's current data key, creating its keyring on first use. */
  async writableKey(scope: VaultScope): Promise<{ kid: string; key: Buffer; raw: string }> {
    const locked = await this.lockRing(scope, 'SHARE');
    if (!locked) {
      const ring: Keyring = { format: KEYRING, scope, current: '', keys: {} };
      const created = mintDataKey(ring, this.kek.current, this.known());
      ring.current = created.kid;
      const raw = JSON.stringify(ring);
      const inserted = await this.db.prepare('INSERT INTO vault_keyrings (scope, ring, version) VALUES (?, ?, 1) ON CONFLICT(scope) DO NOTHING')
        .run(scope, raw);
      if (!Number(inserted.changes)) throw new WriteConflict(`the keyring of ${scope} was created concurrently`);
      return { ...created, raw };
    }
    const ring = parseKeyring(scope, locked.raw);
    if (!ring.keys[ring.current]) throw new Error(`the vault keyring for ${scope} has no current data key; restore it from a backup`);
    return { kid: ring.current, key: this.dataKey(scope, ring.current, locked.raw), raw: locked.raw };
  }
  /** @internal */
  async readEntry(handle: string): Promise<EntryRecord | undefined> {
    return this.parse(await this.db.prepare('SELECT handle, scope, blob, previous, unresolved, version FROM vault_entries WHERE handle = ?')
      .get(handle) as EntryRow | undefined);
  }
  /** @internal Decrypt a blob of `scope` inside a write (its keyring share-locked). */
  async decryptLocked(blob: string, handle: string, scope: VaultScope): Promise<string> {
    const locked = await this.lockRing(scope, 'SHARE');
    return this.open(blob, handle, scope, locked?.raw);
  }
  /** @internal Swap an entry in, or insert one, only if it is as read. */
  async swap(next: Omit<EntryRecord, 'version'>, read: EntryRecord | undefined): Promise<void> {
    const previous = JSON.stringify(next.previous);
    const result = read
      ? await this.db.prepare(`UPDATE vault_entries SET scope=?, blob=?, previous=?, unresolved=?, version=version+1, updatedAt=?
          WHERE handle=? AND version=?`).run(next.scope, next.blob, previous, next.unresolved ? 1 : 0, Date.now(), next.handle, read.version)
      : await this.db.prepare(`INSERT INTO vault_entries (handle, scope, blob, previous, unresolved, version, updatedAt)
          VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(handle) DO NOTHING`).run(next.handle, next.scope, next.blob, previous, next.unresolved ? 1 : 0, Date.now());
    if (!Number(result.changes)) throw new WriteConflict(`the vault entry for ${next.handle} changed concurrently`);
  }
  /** @internal */
  async remove(entry: EntryRecord): Promise<void> {
    const result = await this.db.prepare('DELETE FROM vault_entries WHERE handle=? AND version=?').run(entry.handle, entry.version);
    if (!Number(result.changes)) throw new WriteConflict(`the vault entry for ${entry.handle} changed concurrently`);
  }

  // ── Reads ──

  async has(handle: string): Promise<boolean> {
    return !!await this.db.prepare('SELECT 1 AS present FROM vault_entries WHERE handle = ?').get(handle);
  }
  async scopeOf(handle: string): Promise<VaultScope | undefined> {
    const row = await this.db.prepare('SELECT scope FROM vault_entries WHERE handle = ?').get(handle) as { scope: string } | undefined;
    return row && isVaultScope(row.scope) ? row.scope : undefined;
  }
  async reveal(handle: string, revision = 0): Promise<string | undefined> {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid vault revision');
    const { entry, ring } = await this.readWithRing(handle);
    const blob = revision === 0 ? entry?.blob : entry?.previous[revision - 1];
    return blob === undefined ? undefined : this.open(blob, handle, entry!.scope, ring);
  }
  async list(): Promise<string[]> {
    return (await this.db.prepare('SELECT handle FROM vault_entries ORDER BY handle').all() as Array<{ handle: string }>).map((row) => row.handle);
  }

  // ── Writes ──

  async put(handle: string, secret: string, scope: VaultScope, options: { history?: boolean } = {}): Promise<void> {
    validateScope(scope);
    await this.write(async (tx) => {
      const stored = await this.readEntry(handle);
      const prior = await tx.claim(stored, scope);
      const priorSecret = prior === undefined ? undefined : await this.decryptLocked(prior.blob, handle, prior.scope);
      // A rewrite that strictly shrinks a stored secret is always allowed (AU-31); anything else keeps the limit.
      const bytes = Buffer.byteLength(secret, 'utf8');
      if (bytes > SECRET_LIMIT && !(priorSecret !== undefined && bytes < Buffer.byteLength(priorSecret, 'utf8'))) validateSecret(secret);
      const data = await this.writableKey(scope);
      if (options.history === false) return this.swap({ handle, scope, blob: sealEntry(secret, handle, scope, data), previous: [], unresolved: false }, stored);
      if (priorSecret === secret) {
        if (prior !== stored) await this.swap(prior!, stored);
        return;
      }
      const previous = prior === undefined ? [] : [prior.blob, ...prior.previous].slice(0, 5);
      await this.swap({ handle, scope, blob: sealEntry(secret, handle, scope, data), previous, unresolved: false }, stored);
    });
  }

  async putIfAbsent(handle: string, secret: string, scope: VaultScope): Promise<void> {
    validateSecret(secret);
    validateScope(scope);
    await this.write(async (tx) => {
      const existing = await this.readEntry(handle);
      if (!existing) {
        const data = await this.writableKey(scope);
        return this.swap({ handle, scope, blob: sealEntry(secret, handle, scope, data), previous: [], unresolved: false }, undefined);
      }
      // Never rotate a concurrent creator's value; only correct a guessed owner.
      if (existing.unresolved && existing.scope !== scope) await this.swap((await tx.claim(existing, scope))!, existing);
    });
  }

  async move(handle: string, nextHandle: string, scope: VaultScope, replacement?: string): Promise<void> {
    validateScope(scope);
    if (replacement !== undefined) validateSecret(replacement);
    await this.write(async (tx) => {
      const stored = await this.readEntry(handle);
      const prior = await tx.claim(stored, scope);
      const target = nextHandle === handle ? undefined : await this.readEntry(nextHandle);
      if (target) await tx.claim(target, scope);
      const current = prior === undefined ? undefined : await this.decryptLocked(prior.blob, handle, prior.scope);
      const secret = replacement ?? current;
      if (secret === undefined) throw new Error(`credential broker: no secret for handle ${handle}`);
      const history = prior?.previous ?? [];
      const previous = prior !== undefined && current !== secret ? [prior.blob, ...history].slice(0, 5) : history;
      const data = await this.writableKey(scope);
      // History is bound to the old handle; carry it across re-encrypted.
      const carried: string[] = [];
      for (const blob of previous)
        carried.push(nextHandle === handle ? blob : sealEntry(await this.decryptLocked(blob, handle, prior!.scope), nextHandle, scope, data));
      const next = { handle: nextHandle, scope, blob: sealEntry(secret, nextHandle, scope, data), previous: carried, unresolved: false };
      if (nextHandle === handle) return this.swap(next, stored);
      await this.swap(next, target);
      if (stored) await this.remove(stored);
    });
  }

  async delete(handle: string): Promise<void> {
    if (this.readOnly) throw new Error('this vault was opened read-only');
    await this.db.prepare('DELETE FROM vault_entries WHERE handle = ?').run(handle);
  }

  async replaceIfEqual(handle: string, observed: string | undefined, secret: string, scope: VaultScope, options: { history?: boolean } = {}): Promise<boolean> {
    validateScope(scope);
    validateSecret(secret);
    return this.write(async (tx) => {
      const stored = await this.readEntry(handle);
      const current = stored === undefined ? undefined : await this.decryptLocked(stored.blob, handle, stored.scope);
      if (current !== observed) return false;
      const prior = await tx.claim(stored, scope);
      const data = await this.writableKey(scope);
      const previous = options.history === false || prior === undefined ? [] : [prior.blob, ...prior.previous].slice(0, 5);
      await this.swap({ handle, scope, blob: sealEntry(secret, handle, scope, data), previous, unresolved: false }, stored);
      return true;
    });
  }

  async deleteIfEqual(handle: string, observed: string): Promise<boolean> {
    return this.write(async () => {
      const entry = await this.readEntry(handle);
      if (!entry || await this.decryptLocked(entry.blob, handle, entry.scope) !== observed) return false;
      await this.remove(entry);
      return true;
    });
  }

  // ── Rotation and shredding ──

  /** Replace a scope's data key: mint one, re-encrypt the scope's entries and
   * revisions under it, retire the others; one transaction, holding the
   * keyring exclusively so no write lands under a retiring key. */
  async rotateDataKey(scope: VaultScope): Promise<{ reencrypted: number; retired: string[] }> {
    validateScope(scope);
    return this.write(async () => {
      const locked = await this.lockRing(scope, 'UPDATE');
      if (!locked) return { reencrypted: 0, retired: [] };
      const ring = parseKeyring(scope, locked.raw);
      const old = { ...ring, keys: { ...ring.keys } };
      const data = mintDataKey(ring, this.kek.current, this.known());
      ring.current = data.kid;
      let reencrypted = 0;
      const rows = await this.db.prepare(`SELECT handle, scope, blob, previous, unresolved, version FROM vault_entries
        WHERE scope = ? ORDER BY handle${this.lock('UPDATE')}`).all(scope) as EntryRow[];
      for (const row of rows) {
        const entry = this.parse(row)!;
        const reencrypt = (blob: string) => sealEntry(this.open(blob, entry.handle, scope, locked.raw), entry.handle, scope, data);
        await this.swap({ ...entry, blob: reencrypt(entry.blob), previous: entry.previous.map(reencrypt) }, entry);
        reencrypted++;
      }
      const retired = Object.keys(old.keys);
      ring.keys = { [data.kid]: ring.keys[data.kid]! };
      await this.swapRing(ring, locked.version);
      this.rings.delete(scope);
      return { reencrypted, retired };
    });
  }

  private async swapRing(ring: Keyring, version: number): Promise<void> {
    const result = await this.db.prepare('UPDATE vault_keyrings SET ring=?, version=version+1 WHERE scope=? AND version=?')
      .run(JSON.stringify(ring), ring.scope, version);
    if (!Number(result.changes)) throw new WriteConflict(`the keyring of ${ring.scope} changed concurrently`);
  }

  /** Crypto-shred a scope (organization deletion, account erasure): delete its
   * entries, quarantined copies and keyring. Safe to repeat. */
  async destroyScope(scope: VaultScope): Promise<{ entries: number; quarantined: number }> {
    validateScope(scope);
    if (scope === INSTALLATION_SCOPE) throw new Error('the installation scope cannot be destroyed');
    return this.write(async () => {
      await this.lockRing(scope, 'UPDATE');
      const entries = Number((await this.db.prepare('DELETE FROM vault_entries WHERE scope = ?').run(scope)).changes);
      const quarantined = Number((await this.db.prepare('DELETE FROM vault_quarantine WHERE scope = ?').run(scope)).changes);
      await this.db.prepare('DELETE FROM vault_keyrings WHERE scope = ?').run(scope);
      this.rings.delete(scope);
      return { entries, quarantined };
    }).then((result) => {
      // After the commit: the retired file copy (data epoch 5) goes with the rows.
      // Joined to a caller's transaction, this file effect precedes its commit:
      // that transaction must then not be re-run.
      noteExternalEffect();
      this.shredRetired?.(scope);
      return result;
    });
  }

  /** Give every data key a wrap under the current KEK, then record its canary. */
  private async wrapAll(): Promise<number> {
    let wrapped = 0;
    const current = this.kek.current;
    for (const { ring, version } of await this.keyrings(this.lock('UPDATE'))) {
      let changed = false;
      for (const [kid, entry] of Object.entries(ring.keys)) {
        if (!entry.wraps[current.id]) {
          entry.wraps[current.id] = current.wrap(unwrapDataKey(ring, kid, this.known(), current.id), wrappedFor(ring.scope, kid));
          changed = true;
        }
        wrapped++;
      }
      if (changed) await this.swapRing(ring, version);
    }
    await this.writeCanary(current);
    this.unwrapped = false;
    return wrapped;
  }

  /** KEK rotation, step 1 (opened with the new KEK as current and the old one
   * among `others`): wrap every data key under the new KEK. Repeatable. */
  async wrapUnderCurrentKek(): Promise<{ wrapped: number }> {
    return this.write(async () => ({ wrapped: await this.wrapAll() }));
  }

  /** KEK rotation, step 3 (after the switch): remove every other KEK's canary
   * and wraps; from then on the old KEK is refused. Repeatable. */
  async pruneKeks(): Promise<{ pruned: string[] }> {
    return this.write(async () => {
      const current = this.kek.current.id;
      const pruned = new Set([...(await this.canaries()).keys()].filter((id) => id !== current));
      await this.db.prepare('DELETE FROM vault_kek_canaries WHERE kek <> ?').run(current);
      for (const { ring, version } of await this.keyrings(this.lock('UPDATE'))) {
        let changed = false;
        for (const entry of Object.values(ring.keys))
          for (const id of Object.keys(entry.wraps)) if (id !== current) { delete entry.wraps[id]; pruned.add(id); changed = true; }
        if (changed) await this.swapRing(ring, version);
      }
      return { pruned: [...pruned].sort() };
    });
  }

  async keyStatus(): Promise<VaultKeyStatus> {
    const wraps: Record<string, number> = {};
    const rings = await this.keyrings();
    for (const { ring } of rings)
      for (const entry of Object.values(ring.keys)) for (const id of Object.keys(entry.wraps ?? {})) wraps[id] = (wraps[id] ?? 0) + 1;
    return { kek: this.kek.current.id, scoped: true, keyrings: rings.length,
      scopes: rings.map(({ ring }) => ring.scope).sort(), wraps, canaries: [...(await this.canaries()).keys()] };
  }

  /** Quarantined copies past their 30 days are deleted (the file vault's rule). */
  async sweepQuarantine(now = Date.now()): Promise<number> {
    if (this.readOnly) return 0;
    return Number((await this.db.prepare('DELETE FROM vault_quarantine WHERE createdAt < ?').run(now - QUARANTINE_RETENTION_MS)).changes);
  }
}

/** What a write may do while its transaction is open. */
class WriteContext {
  constructor(private vault: DatabaseVault) {}

  /**
   * The entry, ready to be written as `scope`. A secret belongs to the scope
   * recorded on it: a write naming another is refused, so a confused caller
   * can never move one tenant's secret under another tenant's key. Only an
   * owner the epoch 4 migration could not find yields, to the first write
   * that names one.
   */
  async claim(entry: EntryRecord | undefined, scope: VaultScope): Promise<EntryRecord | undefined> {
    if (!entry || entry.scope === scope) return entry;
    if (!entry.unresolved) throw new Error(`vault entry for ${entry.handle} belongs to ${entry.scope}; refusing to write it as ${scope}`);
    const data = await this.vault.writableKey(scope);
    const reencrypt = async (blob: string) => sealEntry(await this.vault.decryptLocked(blob, entry.handle, entry.scope), entry.handle, scope, data);
    const previous: string[] = [];
    for (const blob of entry.previous) previous.push(await reencrypt(blob));
    return { ...entry, scope, blob: await reencrypt(entry.blob), previous, unresolved: false };
  }
}

/** A raw copy of the file vault's rows, for the epoch 5 import (`vault-import.ts`). */
export interface VaultRows {
  canaries: Array<{ kek: string; record: string }>;
  keyrings: Array<{ scope: VaultScope; ring: string }>;
  entries: Array<{ handle: string; scope: VaultScope; blob: string; previous: string[]; unresolved: boolean }>;
  quarantine: Array<{ id: string; handle?: string; scope?: VaultScope; record: string; reason: string; createdAt: number }>;
}

/** Upsert rows verbatim (nothing is decrypted to copy them), in one
 * transaction: repeating it after a crash writes the same rows again. */
export async function upsertVaultRows(db: SqlDatabase, rows: VaultRows): Promise<void> {
  await db.transaction(async () => {
    for (const { kek, record } of rows.canaries)
      await db.prepare('INSERT INTO vault_kek_canaries (kek, record) VALUES (?, ?) ON CONFLICT(kek) DO UPDATE SET record=excluded.record').run(kek, record);
    for (const { scope, ring } of rows.keyrings)
      await db.prepare(`INSERT INTO vault_keyrings (scope, ring, version) VALUES (?, ?, 1)
        ON CONFLICT(scope) DO UPDATE SET ring=excluded.ring, version=vault_keyrings.version+1`).run(scope, ring);
    for (const entry of rows.entries)
      await db.prepare(`INSERT INTO vault_entries (handle, scope, blob, previous, unresolved, version, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(handle) DO UPDATE SET scope=excluded.scope, blob=excluded.blob, previous=excluded.previous,
          unresolved=excluded.unresolved, version=vault_entries.version+1, updatedAt=excluded.updatedAt`)
        .run(entry.handle, entry.scope, entry.blob, JSON.stringify(entry.previous), entry.unresolved ? 1 : 0, Date.now());
    for (const held of rows.quarantine)
      await db.prepare(`INSERT INTO vault_quarantine (id, handle, scope, record, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`).run(held.id, held.handle ?? null, held.scope ?? null, held.record, held.reason, held.createdAt);
  });
}
