import crypto from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseVault } from '../src/autonomy/vault-database.js';
import { VaultKeyRefused } from '../src/autonomy/vault-crypto.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { INSTALLATION_SCOPE, LocalKek, organizationScope, type KekSource } from '../src/autonomy/vault-keys.js';
import { Store } from '../src/store/db.js';
import { openSqlDatabase, type SqlDatabase } from '../src/store/sql.js';

/**
 * The database vault (wiki planned/host-local-state, step 1): the secret map
 * as encrypted rows in the application database, shared by every process and
 * host, with compare-and-swap writes instead of a host-local file lock.
 * Runs on SQLite, and on PostgreSQL when KARMAX_TEST_POSTGRES_URL is set.
 */

const KEY_A = 'the-original-deployment-key-material-000';
const KEY_B = 'a-rotated-deployment-key-material-11111';
const kek = (text: string): KekSource => ({ current: LocalKek.fromText(text), others: [] });
const A = organizationScope('org_a');
const B = organizationScope('org_b');
const postgresUrl = process.env.KARMAX_TEST_POSTGRES_URL;

/** Two "hosts": separate connections (separate pools on PostgreSQL) to one database. */
interface Shared { store: Store; second(): SqlDatabase; close(): Promise<void> }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const backends: Array<{ name: string; open(): Promise<Shared> }> = [
  { name: 'SQLite', open: async () => {
    const store = await Store.create(':memory:');
    const shared = { store, second: () => store.db, close: () => store.close() };
    cleanups.push(shared.close);
    return shared;
  } },
  ...(postgresUrl ? [{ name: 'PostgreSQL', open: async () => {
    const schema = `karmax_vault_${crypto.randomBytes(6).toString('hex')}`;
    const admin = async (sql: string) => {
      const client = new pg.Client({ connectionString: postgresUrl });
      await client.connect();
      try { await client.query(sql); } finally { await client.end(); }
    };
    await admin(`CREATE SCHEMA ${schema}`);
    const url = new URL(postgresUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const store = await Store.create(url.toString());
    const others: SqlDatabase[] = [];
    const shared = {
      store,
      // A distinct URL is a distinct pool: another host's connections.
      second: () => {
        const other = new URL(url); other.searchParams.set('application_name', `karmax-host-${others.length + 2}`);
        const db = openSqlDatabase(other.toString());
        others.push(db);
        return db;
      },
      close: async () => {
        for (const db of others) await db.close();
        await store.close();
        await admin(`DROP SCHEMA ${schema} CASCADE`);
      },
    };
    cleanups.push(shared.close);
    return shared;
  } }] : []),
];

describe.each(backends)('database vault ($name)', ({ open }) => {
  it('stores, reveals, revises, lists and deletes secrets', async () => {
    const { store } = await open();
    const vault = await DatabaseVault.open(store.db, { kek: kek(KEY_A) });
    expect(await vault.has('h')).toBe(false);
    for (const value of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) await vault.put('h', value, A);
    expect(await vault.reveal('h')).toBe('seven');
    expect(await vault.reveal('h', 1)).toBe('six');
    expect(await vault.reveal('h', 5)).toBe('two');
    expect(await vault.reveal('h', 6)).toBeUndefined();
    await vault.put('h', 'seven', A); // unchanged: no new revision
    expect(await vault.reveal('h', 1)).toBe('six');
    await vault.put('card', 'cvc 123', A, { history: false });
    await vault.put('card', 'no cvc', A, { history: false });
    expect(await vault.reveal('card', 1)).toBeUndefined();
    expect(await vault.scopeOf('h')).toBe(A);
    expect((await vault.list()).sort()).toEqual(['card', 'h']);
    await vault.delete('h');
    expect(await vault.has('h')).toBe(false);
    expect(await vault.reveal('h')).toBeUndefined();
    expect(await vault.deleteIfEqual('card', 'other')).toBe(false);
    expect(await vault.deleteIfEqual('card', 'no cvc')).toBe(true);
    expect(await vault.list()).toEqual([]);
  });

  it('puts only ciphertext bound to its handle and scope in the database', async () => {
    const { store } = await open();
    const vault = await DatabaseVault.open(store.db, { kek: kek(KEY_A) });
    await vault.put('github:token', 'ghp_super_secret_value', A);
    await vault.put('github:token', 'ghp_rotated_secret_value', A);
    await vault.put('other', 'unrelated', A);
    const dump = JSON.stringify([
      ...await store.db.prepare('SELECT * FROM vault_entries').all(),
      ...await store.db.prepare('SELECT * FROM vault_keyrings').all(),
      ...await store.db.prepare('SELECT * FROM vault_kek_canaries').all(),
    ]);
    expect(dump).not.toContain('ghp_super_secret_value');
    expect(dump).not.toContain('ghp_rotated_secret_value');
    expect(dump).not.toContain('unrelated');
    const row = await store.db.prepare('SELECT * FROM vault_entries WHERE handle=?').get('github:token') as { blob: string; scope: string };
    expect(row.blob).toMatch(/^v3\.dk-[0-9a-f]{16}\./);
    expect(row.scope).toBe(A);
    // AU-40: a blob moved to another handle, or a row relabelled to another scope, does not open.
    await store.db.prepare('UPDATE vault_entries SET blob=? WHERE handle=?').run(row.blob, 'other');
    await expect(vault.reveal('other')).rejects.toThrow(/failed authentication/);
    await store.db.prepare('UPDATE vault_entries SET scope=? WHERE handle=?').run(B, 'github:token');
    await expect(vault.reveal('github:token')).rejects.toThrow();
  });

  it('keeps a secret in the scope that owns it', async () => {
    const { store } = await open();
    const vault = await DatabaseVault.open(store.db, { kek: kek(KEY_A) });
    await vault.put('h', 'secret', A);
    await expect(vault.put('h', 'stolen', B)).rejects.toThrow(/belongs to organization:org_a; refusing to write it as organization:org_b/);
    await expect(vault.move('h', 'h2', B)).rejects.toThrow(/belongs to organization:org_a/);
    await expect(vault.put('h', 'x', 'nonsense' as never)).rejects.toThrow(/invalid vault scope/);
    await expect(vault.put('big', 'x'.repeat(65_537), A)).rejects.toThrow(/exceeds size limit/);
    expect(await vault.reveal('h')).toBe('secret');
  });

  it('lets the first write that names an owner claim an unresolved entry', async () => {
    const { store } = await open();
    const vault = await DatabaseVault.open(store.db, { kek: kek(KEY_A) });
    await vault.put('orphan', 'first', INSTALLATION_SCOPE);
    await store.db.prepare('UPDATE vault_entries SET unresolved=1 WHERE handle=?').run('orphan');
    await vault.putIfAbsent('orphan', 'ignored', A);
    expect(await vault.scopeOf('orphan')).toBe(A);
    expect(await vault.reveal('orphan')).toBe('first');
    await expect(vault.put('orphan', 'x', B)).rejects.toThrow(/belongs to organization:org_a/);
  });

  it('moves a secret to a new handle with its history, or replaces it', async () => {
    const { store } = await open();
    const vault = await DatabaseVault.open(store.db, { kek: kek(KEY_A) });
    await vault.put('old', 'v1', A);
    await vault.put('old', 'v2', A);
    await vault.move('old', 'new', A);
    expect(await vault.has('old')).toBe(false);
    expect(await vault.reveal('new')).toBe('v2');
    expect(await vault.reveal('new', 1)).toBe('v1');
    await vault.move('new', 'new', A, 'v3');
    expect(await vault.reveal('new')).toBe('v3');
    expect(await vault.reveal('new', 1)).toBe('v2');
    await expect(vault.move('missing', 'x', A)).rejects.toThrow(/no secret for handle missing/);
  });

  it('never loses a write when two hosts write at once', async () => {
    const shared = await open();
    const one = await DatabaseVault.open(shared.store.db, { kek: kek(KEY_A) });
    const two = await DatabaseVault.open(shared.second(), { kek: kek(KEY_A) });
    // The scope's keyring is created once, whichever host gets there first.
    await Promise.all([one.put('a', '1', A), two.put('b', '2', A)]);
    expect((await shared.store.db.prepare('SELECT COUNT(*) AS n FROM vault_keyrings').get() as { n: number }).n).toBe(1);
    const writes = Array.from({ length: 12 }, (_, i) => (i % 2 ? one : two).put('shared', `value-${i}`, A));
    await Promise.all(writes);
    const row = await shared.store.db.prepare('SELECT version FROM vault_entries WHERE handle=?').get('shared') as { version: number };
    expect(Number(row.version)).toBe(12); // every write built on the one before it
    const seen = new Set<string>();
    for (let revision = 0; revision <= 5; revision++) seen.add((await one.reveal('shared', revision))!);
    expect(seen.size).toBe(6);
    // Reads are never stale across hosts.
    await one.put('fresh', 'first', A);
    expect(await two.reveal('fresh')).toBe('first');
    await one.put('fresh', 'second', A);
    expect(await two.reveal('fresh')).toBe('second');
    await one.delete('fresh');
    expect(await two.has('fresh')).toBe(false);
  });

  it('retries a write whose row changed after it was read, instead of overwriting it', async () => {
    const { store } = await open();
    const vault = await DatabaseVault.open(store.db, { kek: kek(KEY_A) });
    await vault.put('h', 'v1', A);
    const read = (vault as unknown as { readEntry(handle: string): Promise<unknown> }).readEntry.bind(vault);
    let reads = 0;
    vi.spyOn(vault as unknown as { readEntry(handle: string): Promise<unknown> }, 'readEntry').mockImplementation(async (handle) => {
      const entry = await read(handle);
      // Another host commits a write between this one's read and its swap.
      if (reads++ === 0) await store.db.prepare('UPDATE vault_entries SET version=version+1 WHERE handle=?').run(handle);
      return entry;
    });
    await vault.put('h', 'v2', A);
    expect(reads).toBe(2);
    expect(await vault.reveal('h')).toBe('v2');
    expect(await vault.reveal('h', 1)).toBe('v1');
  });

  it('refuses a key that is not the vault\'s, and rotates the KEK in steps', async () => {
    const { store } = await open();
    const vault = await DatabaseVault.open(store.db, { kek: kek(KEY_A) });
    await vault.put('h', 'secret', A);
    await vault.put('i', 'installation', INSTALLATION_SCOPE);
    await expect(DatabaseVault.open(store.db, { kek: kek(KEY_B) })).rejects.toBeInstanceOf(VaultKeyRefused);
    // Step 1: wrap every data key under the new KEK while the old one serves.
    const next = await DatabaseVault.open(store.db, { kek: { current: LocalKek.fromText(KEY_B), others: [LocalKek.fromText(KEY_A)] } });
    expect((await next.wrapUnderCurrentKek()).wrapped).toBe(2);
    // Step 2: the new key alone opens everything; the old one still does until prune.
    const switched = await DatabaseVault.open(store.db, { kek: kek(KEY_B) });
    expect(await switched.reveal('h')).toBe('secret');
    expect(await (await DatabaseVault.open(store.db, { kek: kek(KEY_A) })).reveal('h')).toBe('secret');
    // Step 3: prune; the old key is refused from then on.
    expect((await switched.pruneKeks()).pruned).toEqual([LocalKek.fromText(KEY_A).id]);
    await expect(DatabaseVault.open(store.db, { kek: kek(KEY_A) })).rejects.toBeInstanceOf(VaultKeyRefused);
    const status = await switched.keyStatus();
    expect(status).toMatchObject({ kek: LocalKek.fromText(KEY_B).id, scoped: true, keyrings: 2,
      wraps: { [LocalKek.fromText(KEY_B).id]: 2 }, canaries: [LocalKek.fromText(KEY_B).id] });
    expect(status.scopes).toEqual([INSTALLATION_SCOPE, A].sort());
  });

  it('rotates a data key without losing writes that race it', async () => {
    const shared = await open();
    const one = await DatabaseVault.open(shared.store.db, { kek: kek(KEY_A) });
    const two = await DatabaseVault.open(shared.second(), { kek: kek(KEY_A) });
    for (let i = 0; i < 5; i++) await one.put(`h${i}`, `v${i}`, A);
    const before = JSON.parse((await shared.store.db.prepare('SELECT ring FROM vault_keyrings WHERE scope=?').get(A) as { ring: string }).ring);
    const racing = Array.from({ length: 8 }, (_, i) => two.put(`r${i}`, `race-${i}`, A));
    const [rotated] = await Promise.all([one.rotateDataKey(A), ...racing]);
    expect(rotated.retired).toEqual([before.current]);
    // Whichever side of the rotation each write landed on, it opens.
    for (let i = 0; i < 5; i++) expect(await two.reveal(`h${i}`)).toBe(`v${i}`);
    for (let i = 0; i < 8; i++) expect(await one.reveal(`r${i}`)).toBe(`race-${i}`);
    const rows = await shared.store.db.prepare('SELECT blob FROM vault_entries').all() as Array<{ blob: string }>;
    const after = JSON.parse((await shared.store.db.prepare('SELECT ring FROM vault_keyrings WHERE scope=?').get(A) as { ring: string }).ring);
    expect(Object.keys(after.keys)).toEqual([after.current]);
    expect(rows.every(({ blob }) => blob.split('.')[1] === after.current)).toBe(true);
  });

  it('crypto-shreds a scope on every host', async () => {
    const shared = await open();
    const one = await DatabaseVault.open(shared.store.db, { kek: kek(KEY_A) });
    const two = await DatabaseVault.open(shared.second(), { kek: kek(KEY_A) });
    await one.put('a1', 'x', A);
    await one.put('a2', 'y', A);
    await one.put('b1', 'z', B);
    expect(await two.reveal('a1')).toBe('x'); // host two has A's data key cached
    const copy = await shared.store.db.prepare('SELECT * FROM vault_entries WHERE handle=?').get('a1') as Record<string, unknown>;
    expect(await one.destroyScope(A)).toEqual({ entries: 2, quarantined: 0 });
    expect(await two.has('a1')).toBe(false);
    expect(await two.reveal('b1')).toBe('z');
    // A copy of the ciphertext put back (an old backup's row) no longer opens anywhere.
    await shared.store.db.prepare('INSERT INTO vault_entries (handle, scope, blob, previous, unresolved, version, updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run(copy.handle, copy.scope, copy.blob, copy.previous, copy.unresolved, copy.version, copy.updatedAt);
    await expect(one.reveal('a1')).rejects.toThrow(/destroyed or missing/);
    await expect(two.reveal('a1')).rejects.toThrow(/destroyed or missing/); // its cached data key is not used
    await expect(one.destroyScope(INSTALLATION_SCOPE)).rejects.toThrow(/cannot be destroyed/);
  });

  it('opens read-only without writing anything', async () => {
    const { store } = await open();
    await expect(DatabaseVault.open(store.db, { kek: kek(KEY_A), readOnly: true })).resolves.toBeDefined();
    expect((await store.db.prepare('SELECT COUNT(*) AS n FROM vault_kek_canaries').get() as { n: number }).n).toBe(0);
    const vault = await DatabaseVault.open(store.db, { kek: kek(KEY_A), readOnly: true });
    await expect(vault.put('h', 'x', A)).rejects.toThrow(/read-only/);
  });

  it('serves the credential broker', async () => {
    const { store } = await open();
    const broker = new CredentialBroker(await DatabaseVault.open(store.db, { kek: kek(KEY_A) }));
    await broker.registerHandle('svc:key', 'sk-123', A);
    expect(await broker.hasHandle('svc:key')).toBe(true);
    expect(await broker.scopeOf('svc:key')).toBe(A);
    expect(await broker.listHandles()).toEqual(['svc:key']);
    expect(await broker.resolve('svc:key', { caps: ['use-credential:svc:*'] })).toBe('sk-123');
    await expect(broker.resolve('svc:key', { caps: [] })).rejects.toThrow(/not permitted/);
    await expect(broker.resolve('svc:none', { caps: ['use-credential:*'] })).rejects.toThrow(/no secret/);
    expect(broker.audit_log().map((entry) => entry.granted)).toEqual([true, false, false]);
  });
});
