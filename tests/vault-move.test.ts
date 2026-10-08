import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOVED_TO_DATABASE, RETIRED_VAULT, Vault, VaultMovedToDatabase, inspectVault } from '../src/autonomy/vault.js';
import { DatabaseVault } from '../src/autonomy/vault-database.js';
import { VAULT_MOVED_MARKER, moveVaultToDatabase, openSecretVault, vaultMoved, type VaultBoot } from '../src/autonomy/vault-backend.js';
import { INSTALLATION_SCOPE, LocalKek, organizationScope, type KekSource } from '../src/autonomy/vault-keys.js';
import { storeBackends } from './helpers/store-backends.js';
import type { Store } from '../src/store/db.js';

/**
 * Data epoch 5 (wiki planned/host-local-state, step 1): the first boot on
 * PostgreSQL moves the file vault into the database. The rows are the files'
 * ciphertext verbatim, the move is checked before it counts, and it resumes
 * after a crash at any step.
 */

const KEY = 'the-original-deployment-key-material-000';
const kek = (): KekSource => ({ current: LocalKek.fromText(KEY), others: [] });
const A = organizationScope('org_a');
const B = organizationScope('org_b');
const directories: string[] = [];
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-import-'));
  directories.push(dir);
  return path.join(dir, 'vault');
}

/** A file vault as data epoch 4 leaves it: scoped entries with history, an
 * unresolved owner, and a quarantined copy. */
async function epoch4Vault() {
  vi.stubEnv('KARMAX_VAULT_KEY', KEY);
  const dir = directory();
  const vault = new Vault(dir);
  for (const value of ['a1', 'a2', 'a3']) await vault.put('org-a:token', value, A);
  await vault.put('org-b:token', 'b1', B);
  await vault.put('checkpoint:encryption-key', 'installation-secret', INSTALLATION_SCOPE);
  await vault.put('orphan', 'unattributed', INSTALLATION_SCOPE);
  const orphan = path.join(dir, 'entries', `${sha('orphan')}.json`);
  fs.writeFileSync(orphan, JSON.stringify({ ...JSON.parse(fs.readFileSync(orphan, 'utf8')), unresolved: true }));
  fs.mkdirSync(path.join(dir, 'entries', 'quarantine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'entries', 'quarantine', `${sha('lost')}.json.1.x`), JSON.stringify({ handle: 'lost', scope: A, blob: 'v3.dk-0.x' }));
  return dir;
}

const files = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
const audits = () => {
  const rows: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const boot: VaultBoot = { resolveScopes: async () => new Map(), audit: async (action, detail) => { rows.push({ action, detail }); } };
  return { rows, boot };
};

describe.each(storeBackends)('moving the vault into the database ($name)', ({ open }) => {
  let store: Store;
  const begin = async () => { store = await open(); return store; };

  it('copies every secret verbatim, checks it, and retires the directory', async () => {
    const dir = await epoch4Vault();
    const before: Record<string, { blob: string; previous?: string[]; scope: string }> = Object.fromEntries(fs.readdirSync(path.join(dir, 'entries')).filter((name) => name.endsWith('.json'))
      .map((name) => { const entry = JSON.parse(fs.readFileSync(path.join(dir, 'entries', name), 'utf8')); return [entry.handle, entry]; }));
    await begin();
    const { rows, boot } = audits();
    expect(await moveVaultToDatabase(dir, store.db, kek(), boot)).toEqual({ entries: 4, keyrings: 3, quarantined: 1 });
    expect(await vaultMoved(store.db)).toBe(true);
    expect(rows.map((row) => row.action)).toContain('vault.moved-to-database');
    // Rows are the files' ciphertext, byte for byte: nothing was decrypted to copy it.
    for (const row of await store.db.prepare('SELECT * FROM vault_entries').all() as Array<{ handle: string; blob: string; previous: string; scope: string }>) {
      expect(row.blob).toBe(before[row.handle]!.blob);
      expect(JSON.parse(row.previous)).toEqual(before[row.handle]!.previous ?? []);
      expect(row.scope).toBe(before[row.handle]!.scope);
    }
    const vault = await DatabaseVault.open(store.db, { kek: kek() });
    expect(await vault.reveal('org-a:token')).toBe('a3');
    expect(await vault.reveal('org-a:token', 2)).toBe('a1');
    expect(await vault.reveal('org-b:token')).toBe('b1');
    expect(await vault.reveal('checkpoint:encryption-key')).toBe('installation-secret');
    // The unresolved owner is still claimable by the first write that names one.
    await vault.put('orphan', 'claimed', A);
    expect(await vault.scopeOf('orphan')).toBe(A);
    expect((await store.db.prepare('SELECT handle, reason FROM vault_quarantine').all())).toEqual([{ handle: 'lost', reason: expect.any(String) }]);
    // The vault's files are kept, unchanged, beside the sentinel: the cheapest way back. No release reads them.
    const retired = path.join(dir, RETIRED_VAULT);
    expect(files(dir).filter((name) => !name.startsWith('vault.') && !name.startsWith(RETIRED_VAULT)))
      .toEqual(['entries', 'entries/.migrated', 'secrets.json']);
    for (const [handle, entry] of Object.entries(before))
      expect(JSON.parse(fs.readFileSync(path.join(retired, 'entries', `${sha(handle)}.json`), 'utf8'))).toEqual(entry);
    expect(fs.readdirSync(path.join(retired, 'keys')).filter((name) => name.endsWith('.json'))).toHaveLength(3);
    expect(fs.readdirSync(path.join(retired, 'entries', 'quarantine'))).toEqual([`${sha('lost')}.json.1.x`]);
    // It still opens as a vault, with the same key: the secrets as the move found them.
    expect(await new Vault(retired, { readOnly: true }).reveal('org-a:token')).toBe('a3');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'))).toEqual(MOVED_TO_DATABASE);
    expect(() => new Vault(dir)).toThrow(VaultMovedToDatabase);
    // A second boot does nothing.
    expect(await moveVaultToDatabase(dir, store.db, kek(), boot)).toBeUndefined();
  });

  it('shreds a deleted organization from the retired copy too', async () => {
    const dir = await epoch4Vault();
    await begin();
    await moveVaultToDatabase(dir, store.db, kek(), audits().boot);
    const retired = path.join(dir, RETIRED_VAULT);
    const vault = await DatabaseVault.open(store.db, { kek: kek(), retired });
    expect(fs.existsSync(path.join(retired, 'keys', `${sha(A)}.json`))).toBe(true);
    expect(await vault.destroyScope(A)).toEqual({ entries: 1, quarantined: 1 });
    // A keyring kept on disk would let the retired copy outlive crypto-shredding.
    expect(fs.existsSync(path.join(retired, 'keys', `${sha(A)}.json`))).toBe(false);
    expect(fs.existsSync(path.join(retired, 'entries', `${sha('org-a:token')}.json`))).toBe(false);
    expect(fs.readdirSync(path.join(retired, 'entries', 'quarantine'))).toEqual([]);
    expect(await new Vault(retired, { readOnly: true }).reveal('org-b:token')).toBe('b1');
  });

  it('leaves the files authoritative until the marker commits, and resumes after a crash at any step', async () => {
    for (const crashAt of ['copied', 'verified', 'marked'] as const) {
      const dir = await epoch4Vault();
      await begin();
      const { boot } = audits();
      await expect(moveVaultToDatabase(dir, store.db, kek(), boot, (step) => { if (step === crashAt) throw new Error(`crash after ${step}`); }))
        .rejects.toThrow(`crash after ${crashAt}`);
      const marked = await vaultMoved(store.db);
      expect(marked).toBe(crashAt === 'marked');
      // Before the marker, the file vault still opens and is still the vault.
      if (!marked) expect(await new Vault(dir).reveal('org-a:token')).toBe('a3');
      // A secret written in between (the old files are still the vault) is carried by the retry.
      if (!marked) await new Vault(dir).put('late', 'written after the crash', A);
      await moveVaultToDatabase(dir, store.db, kek(), boot);
      const vault = await DatabaseVault.open(store.db, { kek: kek() });
      expect(await vault.reveal('org-a:token')).toBe('a3');
      if (!marked) expect(await vault.reveal('late')).toBe('written after the crash');
      expect(() => new Vault(dir)).toThrow(VaultMovedToDatabase);
      await store.close();
    }
  });

  it('refuses to count a move that does not read back, and keeps the files', async () => {
    const dir = await epoch4Vault();
    await begin();
    const { boot } = audits();
    const reveal = DatabaseVault.prototype.reveal;
    vi.spyOn(DatabaseVault.prototype, 'reveal').mockImplementation(async function (this: DatabaseVault, handle, revision) {
      return handle === 'org-b:token' ? 'something else' : reveal.call(this, handle, revision);
    });
    await expect(moveVaultToDatabase(dir, store.db, kek(), boot)).rejects.toThrow(/does not read back the same.*file vault is unchanged/);
    vi.restoreAllMocks();
    expect(await vaultMoved(store.db)).toBe(false);
    expect(await new Vault(dir).reveal('org-b:token')).toBe('b1');
  });

  it('copies a revision the file vault cannot open either, instead of refusing the move', async () => {
    const dir = await epoch4Vault();
    // An old revision under a data key no longer in its keyring: unreadable before the move.
    const file = path.join(dir, 'entries', `${sha('org-a:token')}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.previous[1] = entry.previous[1].replace(/^v3\.dk-[0-9a-f]{16}\./, 'v3.dk-0000000000000000.');
    fs.writeFileSync(file, JSON.stringify(entry));
    await expect(new Vault(dir).reveal('org-a:token', 2)).rejects.toThrow(/destroyed or missing/);
    await begin();
    await moveVaultToDatabase(dir, store.db, kek(), audits().boot);
    const vault = await DatabaseVault.open(store.db, { kek: kek() });
    expect(await vault.reveal('org-a:token')).toBe('a3');
    await expect(vault.reveal('org-a:token', 2)).rejects.toThrow(/destroyed or missing/);
  });

  it('runs the epoch 4 migration first, so an epoch 3 vault moves too', async () => {
    vi.stubEnv('KARMAX_VAULT_KEY', KEY);
    const dir = directory();
    const key = crypto.createHash('sha256').update(KEY).digest();
    const v2 = (plain: string, handle: string) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`karmax-vault:v2\0${handle}`, 'utf8'));
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return `v2.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
    };
    fs.mkdirSync(path.join(dir, 'entries'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'entries', `${sha('world-provider:org_a:e2b:api-key')}.json`),
      JSON.stringify({ handle: 'world-provider:org_a:e2b:api-key', blob: v2('e2b-key', 'world-provider:org_a:e2b:api-key') }));
    fs.writeFileSync(path.join(dir, 'entries', '.migrated'), '');
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(['karmax-vault-moved-to-entries', 'moved']));
    fs.writeFileSync(path.join(dir, 'vault.canary'), JSON.stringify({ format: 'karmax-vault-canary',
      blob: v2(JSON.stringify({ canary: 'karmax-vault-canary', bound: true }), '\0canary') }));
    await begin();
    const { rows, boot } = audits();
    boot.resolveScopes = async (handles) => new Map(handles.map((handle) => [handle, A]));
    await moveVaultToDatabase(dir, store.db, kek(), boot);
    expect(rows.map((row) => row.action)).toEqual(['vault.scopes.migrated', 'vault.moved-to-database']);
    const vault = await DatabaseVault.open(store.db, { kek: kek() });
    expect(await vault.reveal('world-provider:org_a:e2b:api-key')).toBe('e2b-key');
    expect(await vault.scopeOf('world-provider:org_a:e2b:api-key')).toBe(A);
  });

  it('marks a database with no file vault as moved, and refuses the wrong key afterwards', async () => {
    await begin();
    const dir = directory();
    expect(await moveVaultToDatabase(dir, store.db, kek(), audits().boot)).toEqual({ entries: 0, keyrings: 0, quarantined: 0 });
    expect(fs.existsSync(dir)).toBe(false);
    expect(await store.kvGet(VAULT_MOVED_MARKER)).toBeTruthy();
    const vault = await DatabaseVault.open(store.db, { kek: kek() });
    await vault.put('h', 'x', A);
    await expect(DatabaseVault.open(store.db, { kek: { current: LocalKek.fromText('another-key-entirely-0000000000000'), others: [] } }))
      .rejects.toThrow(/does not open this vault/);
  });
});

describe('choosing the vault', () => {
  it('keeps the file vault on SQLite, and the preflight reports a moved directory', async () => {
    const dir = await epoch4Vault();
    const store = await storeBackends[0]!.open();
    const vault = await openSecretVault(dir, store.db, audits().boot);
    expect(vault).toBeInstanceOf(Vault);
    expect(await vault.reveal('org-b:token')).toBe('b1');
    await moveVaultToDatabase(dir, store.db, kek(), audits().boot);
    expect(inspectVault(dir)).toMatchObject({ key: 'unchecked', movedToDatabase: true });
    await store.close();
  });

  it.runIf(storeBackends.length > 1)('moves into PostgreSQL on the primary\'s boot; a secondary process only attaches', async () => {
    const dir = await epoch4Vault();
    const store = await storeBackends[1]!.open();
    await expect(openSecretVault(dir, store.db)).rejects.toThrow(/has not moved into the database yet/);
    const lines: string[] = [];
    const primary = await openSecretVault(dir, store.db, { ...audits().boot, log: (line) => lines.push(line) });
    expect(primary).toBeInstanceOf(DatabaseVault);
    expect(lines).toEqual(['Vault: moved 4 secrets into the database (data epoch 5)']);
    const secondary = await openSecretVault(dir, store.db);
    await primary.put('shared', 'from the primary', A);
    expect(await secondary.reveal('shared')).toBe('from the primary');
    // Shredded in the database, then a crash before the retired files went: the next boot finishes it.
    await (await DatabaseVault.open(store.db, { kek: kek() })).destroyScope(B);
    expect(fs.existsSync(path.join(dir, RETIRED_VAULT, 'keys', `${sha(B)}.json`))).toBe(true);
    await openSecretVault(dir, store.db, audits().boot);
    expect(fs.existsSync(path.join(dir, RETIRED_VAULT, 'keys', `${sha(B)}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, RETIRED_VAULT, 'keys', `${sha(A)}.json`))).toBe(true);
    await store.close();
  });
});
