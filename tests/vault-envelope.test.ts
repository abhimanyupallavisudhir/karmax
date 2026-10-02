import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault, inspectVault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { INSTALLATION_SCOPE, LocalKek, organizationScope, userScope, type VaultScope } from '../src/autonomy/vault-keys.js';
import { resolveVaultScopes } from '../src/autonomy/vault-scopes.js';
import { Store } from '../src/store/db.js';

/**
 * SS-1: envelope encryption. Every secret is encrypted under a data key (DEK)
 * of its owner's scope (an organization, a user, or the installation); each
 * DEK is wrapped under the key encryption key (KEK, today's vault key).
 */

const directories: string[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-envelope-'));
  directories.push(dir);
  return dir;
}
beforeEach(() => vi.stubEnv('KARMAX_VAULT_KEY', ''));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const A = organizationScope('org_a');
const B = organizationScope('org_b');
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const entryFile = (dir: string, handle: string) => path.join(dir, 'entries', `${sha(handle)}.json`);
const keyringFile = (dir: string, scope: string) => path.join(dir, 'keys', `${sha(scope)}.json`);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const KEY_A = 'the-original-deployment-key-material-000';
const KEY_B = 'a-rotated-deployment-key-material-11111';
const kekId = (text: string) => LocalKek.fromText(text).id;

/** A vault as the epoch-3 release leaves it: bound `v2.` entries under the
 * installation key, a moved secrets.json and a bound canary. */
function epoch3Vault(entries: Record<string, { current: string; previous?: string[] }>, keyText = KEY_A) {
  const dir = directory();
  const key = crypto.createHash('sha256').update(keyText).digest();
  const v2 = (plain: string, handle: string) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`karmax-vault:v2\0${handle}`, 'utf8'));
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v2.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
  };
  fs.mkdirSync(path.join(dir, 'entries'), { recursive: true, mode: 0o700 });
  for (const [handle, { current, previous = [] }] of Object.entries(entries))
    fs.writeFileSync(entryFile(dir, handle), JSON.stringify({ handle, blob: v2(current, handle),
      ...(previous.length ? { previous: previous.map((plain) => v2(plain, handle)) } : {}) }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'entries', '.migrated'), '');
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(['karmax-vault-moved-to-entries', 'moved']));
  fs.writeFileSync(path.join(dir, 'vault.canary'), JSON.stringify({ format: 'karmax-vault-canary',
    blob: v2(JSON.stringify({ canary: 'karmax-vault-canary', bound: true }), '\0canary') }));
  vi.stubEnv('KARMAX_VAULT_KEY', keyText);
  return { dir, v2 };
}

describe('entries under scope data keys', () => {
  it('writes v3 ciphertext under the scope’s data key, wrapped under the vault key', async () => {
    vi.stubEnv('KARMAX_VAULT_KEY', KEY_A);
    const dir = directory();
    const vault = new Vault(dir);
    await vault.put('item:1:password', 'tenant-secret', A);
    const entry = readJson(entryFile(dir, 'item:1:password'));
    expect(entry.scope).toBe(A);
    expect(entry.blob).toMatch(/^v3\.[0-9a-z-]+\./);
    const keyring = readJson(keyringFile(dir, A));
    expect(keyring.scope).toBe(A);
    const kid = entry.blob.split('.')[1];
    expect(Object.keys(keyring.keys[kid].wraps)).toEqual([kekId(KEY_A)]);
    expect(vault.reveal('item:1:password')).toBe('tenant-secret');
    expect(vault.scopeOf('item:1:password')).toBe(A);
    // Never the raw secret, nor the raw data key, on disk.
    expect(fs.readFileSync(keyringFile(dir, A), 'utf8')).not.toContain('tenant-secret');
  });

  it('keeps every write path: history, renames, putIfAbsent, the size limit', async () => {
    const vault = new Vault(directory());
    await vault.put('h', 'one', A);
    await vault.put('h', 'two', A);
    await vault.move('h', 'h2', A);
    expect(vault.reveal('h2')).toBe('two');
    expect(vault.reveal('h2', 1)).toBe('one');
    await vault.putIfAbsent('k', 'first', INSTALLATION_SCOPE);
    await vault.putIfAbsent('k', 'second', INSTALLATION_SCOPE);
    expect(vault.reveal('k')).toBe('first');
    await expect(vault.put('big', 'x'.repeat(70_000), A)).rejects.toThrow(/size limit/);
  });

  it('requires a valid scope on every write', async () => {
    const vault = new Vault(directory());
    await expect(vault.put('h', 'v', 'organization:' as VaultScope)).rejects.toThrow(/scope/);
    await expect(vault.put('h', 'v', 'tenant:x' as VaultScope)).rejects.toThrow(/scope/);
    expect(() => organizationScope('a:b')).toThrow(/organization id/);
    expect(() => userScope('')).toThrow(/user id/);
  });
});

describe('a cross-scope swap is refused', () => {
  it('refuses a ciphertext moved into another scope’s entry', async () => {
    const dir = directory();
    const vault = new Vault(dir);
    await vault.put('item:a', 'org-a-secret', A);
    await vault.put('item:b', 'org-b-secret', B);
    const stolen = readJson(entryFile(dir, 'item:a'));
    // Same handle, relabelled as B's: the AAD binds the scope.
    fs.writeFileSync(entryFile(dir, 'item:a'), JSON.stringify({ ...stolen, scope: B }));
    expect(() => vault.reveal('item:a')).toThrow(/item:a/);
    // A's ciphertext on B's handle.
    fs.writeFileSync(entryFile(dir, 'item:b'), JSON.stringify({ ...stolen, handle: 'item:b' }));
    expect(() => vault.reveal('item:b')).toThrow(/item:b.*failed authentication/);
  });

  it('refuses a keyring or a wrapped data key copied to another scope', async () => {
    const dir = directory();
    const vault = new Vault(dir);
    await vault.put('item:a', 'org-a-secret', A);
    await vault.put('item:b', 'org-b-secret', B);
    const ringA = readJson(keyringFile(dir, A));
    fs.writeFileSync(keyringFile(dir, B), JSON.stringify(ringA));
    expect(() => new Vault(dir).reveal('item:b')).toThrow(/keyring/);
    fs.writeFileSync(keyringFile(dir, B), JSON.stringify({ ...ringA, scope: B }));
    expect(() => new Vault(dir).reveal('item:b')).toThrow(/data key/);
  });

  it('refuses to write a secret into another owner’s scope', async () => {
    const vault = new Vault(directory());
    await vault.put('resource:r1:credential', 'org-a-secret', A);
    await expect(vault.put('resource:r1:credential', 'hijack', B)).rejects.toThrow(/belongs to organization:org_a/);
    await expect(vault.move('resource:r1:credential', 'resource:r1:credential', B, 'x')).rejects.toThrow(/belongs to/);
    await vault.put('other', 'b', B);
    await expect(vault.move('resource:r1:credential', 'other', A)).rejects.toThrow(/belongs to/);
    expect(vault.reveal('resource:r1:credential')).toBe('org-a-secret');
    expect(vault.reveal('other')).toBe('b');
  });
});

describe('the epoch 4 migration of a realistic mixed v2 vault', () => {
  async function fixture() {
    const store = await Store.create(':memory:');
    const orgA = await store.createOrganization({ name: 'Alpha' });
    const orgB = await store.createOrganization({ name: 'Beta' });
    const project = await store.createProject('Beta app', {}, orgB.id);
    await store.kvSet(`vault:items:${orgA.id}`, JSON.stringify([{ id: 'vi_login', type: 'login', label: 'L', fields: ['password', 'totp'] }]));
    await store.createResourceAttachment({ id: 'resource_env', organizationId: orgB.id, projectId: project.id, name: 'TOKEN',
      driver: 'secret@1', target: { kind: 'environment', name: 'TOKEN' }, access: 'read', isolation: 'fork', source: {},
      credentialHandles: ['resource:resource_env:credential'], publish: 'discard' });
    await store.createCard({ id: 'card_1', provider: 'vault-card', scope: 'organization', scopeId: orgA.id, label: 'Card', cap: 100, available: 100, createdAt: Date.now() });
    await store.kvSet('service-connection:sc_1', JSON.stringify({ id: 'sc_1', organizationId: orgB.id }));
    const secrets: Record<string, { current: string; previous?: string[] }> = {
      'item:vi_login:password': { current: 'pw-3', previous: ['pw-2', 'pw-1'] },
      'item:vi_login:totp': { current: 'otpauth://x' },
      'resource:resource_env:credential': { current: 'project-token' },
      'payment:card:card_1': { current: '{"number":"4242"}' },
      'payment:card:card_1:cvc': { current: '123' },
      [`world-provider:${orgB.id}:e2b:api-key`]: { current: 'e2b' },
      [`mcp:${orgA.id}:conn`]: { current: '{}' },
      [`connector:${orgB.id}:pass-git:auth`]: { current: 'gpg' },
      [`connector-export:${orgA.id}:w1`]: { current: 'snapshot' },
      [`resource-store:key:${orgB.id}`]: { current: 'chunk-key' },
      [`mailbox:imap:${orgA.id}:auth`]: { current: 'imap' },
      'git:user:u_1:github:token': { current: 'user-git' },
      'git:github:ssh': { current: 'personal-org-git' },
      [`git:${orgB.id}:deploy:token`]: { current: 'org-git' },
      'github-app:user:u_1:account:9:authorization': { current: 'user-oauth' },
      'service-connection:sc_1': { current: 'https://connect' },
      [`anthropic:${orgA.id}:work`]: { current: 'sk-ant' },
      'openai:personal': { current: 'sk-open' },
      'github-app:private-key': { current: 'pem' },
      'checkpoint:encryption-key': { current: 'ck' },
      'world-reference:key:v2': { current: 'wr' },
      'platform:stripe:secret-key': { current: 'sk_live' },
      'service-connections:composio:api-key': { current: 'composio' },
      'mystery:thing': { current: 'who-owns-this' },
      [`world-provider:org_gone:e2b:api-key`]: { current: 'deleted-org-key' },
    };
    const { dir, v2 } = epoch3Vault(secrets);
    return { store, orgA: orgA.id, orgB: orgB.id, secrets, dir, v2 };
  }
  const expected = (orgA: string, orgB: string): Record<string, string> => ({
    'item:vi_login:password': `organization:${orgA}`, 'item:vi_login:totp': `organization:${orgA}`,
    'resource:resource_env:credential': `organization:${orgB}`,
    'payment:card:card_1': `organization:${orgA}`, 'payment:card:card_1:cvc': `organization:${orgA}`,
    [`world-provider:${orgB}:e2b:api-key`]: `organization:${orgB}`, [`mcp:${orgA}:conn`]: `organization:${orgA}`,
    [`connector:${orgB}:pass-git:auth`]: `organization:${orgB}`, [`connector-export:${orgA}:w1`]: `organization:${orgA}`,
    [`resource-store:key:${orgB}`]: `organization:${orgB}`, [`mailbox:imap:${orgA}:auth`]: `organization:${orgA}`,
    'git:user:u_1:github:token': 'user:u_1', 'git:github:ssh': 'organization:org_personal',
    [`git:${orgB}:deploy:token`]: `organization:${orgB}`, 'github-app:user:u_1:account:9:authorization': 'user:u_1',
    'service-connection:sc_1': `organization:${orgB}`, [`anthropic:${orgA}:work`]: `organization:${orgA}`,
    'openai:personal': 'organization:org_personal',
    'github-app:private-key': 'installation', 'checkpoint:encryption-key': 'installation', 'world-reference:key:v2': 'installation',
    'platform:stripe:secret-key': 'installation', 'service-connections:composio:api-key': 'installation',
    'mystery:thing': 'installation', 'world-provider:org_gone:e2b:api-key': 'installation',
  });

  it('re-encrypts every entry and revision under its owner’s data key, reports the unresolved, and is idempotent', async () => {
    const { store, orgA, orgB, secrets, dir, v2 } = await fixture();
    try {
      expect(inspectVault(dir)).toMatchObject({ key: 'accepted', toScopes: Object.keys(secrets).length });
      const vault = new Vault(dir);
      const report = await vault.migrateToScopes((handles) => resolveVaultScopes(store, handles));
      expect(report.migrated).toBe(Object.keys(secrets).length);
      expect(report.unresolved.sort()).toEqual(['mystery:thing', 'world-provider:org_gone:e2b:api-key']);
      for (const [handle, scope] of Object.entries(expected(orgA, orgB))) {
        expect(vault.scopeOf(handle), handle).toBe(scope);
        const entry = readJson(entryFile(dir, handle));
        expect(entry.blob, handle).toMatch(/^v3\./);
        for (const blob of entry.previous ?? []) expect(blob).toMatch(/^v3\./);
      }
      for (const [handle, { current, previous = [] }] of Object.entries(secrets)) {
        expect(vault.reveal(handle)).toBe(current);
        previous.forEach((plain, i) => expect(vault.reveal(handle, i + 1)).toBe(plain));
      }
      // The epoch-3 canary is retired, so that release refuses this vault.
      expect(fs.readFileSync(path.join(dir, 'vault.canary'), 'utf8')).toMatch(/epoch 4/);
      expect(inspectVault(dir)).toMatchObject({ key: 'accepted', toScopes: 0 });
      expect((await new Vault(dir).migrateToScopes((handles) => resolveVaultScopes(store, handles))).migrated).toBe(0);
      // v2 is readable only until the migration: a planted one is refused.
      fs.writeFileSync(entryFile(dir, 'mystery:thing'), JSON.stringify({ handle: 'mystery:thing', blob: v2('planted', 'mystery:thing') }));
      expect(() => new Vault(dir).reveal('mystery:thing')).toThrow(/not under a data key/);
      // A guessed owner yields to the first write that names the real one.
      const fresh = new Vault(dir);
      await fresh.put('world-provider:org_gone:e2b:api-key', 'moved', B);
      expect(fresh.scopeOf('world-provider:org_gone:e2b:api-key')).toBe(B);
    } finally { await store.close(); }
  });

  it('survives an interruption midway and finishes on the next boot', async () => {
    const { store, orgA, orgB, secrets, dir } = await fixture();
    try {
      const rename = fs.renameSync;
      let entryWrites = 0;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to).includes(`${path.sep}entries${path.sep}`) && ++entryWrites > 5) throw new Error('crash');
        return rename(from, to);
      });
      await expect(new Vault(dir).migrateToScopes((handles) => resolveVaultScopes(store, handles))).rejects.toThrow('crash');
      spy.mockRestore();
      // Half-migrated: everything still opens, old and new formats alike.
      const reopened = new Vault(dir);
      for (const [handle, { current }] of Object.entries(secrets)) expect(reopened.reveal(handle)).toBe(current);
      expect(inspectVault(dir).toScopes).toBe(Object.keys(secrets).length - 5);
      const report = await reopened.migrateToScopes((handles) => resolveVaultScopes(store, handles));
      expect(report.migrated).toBe(Object.keys(secrets).length - 5);
      for (const [handle, scope] of Object.entries(expected(orgA, orgB))) expect(reopened.scopeOf(handle), handle).toBe(scope);
      for (const [handle, { current, previous = [] }] of Object.entries(secrets)) {
        expect(reopened.reveal(handle)).toBe(current);
        previous.forEach((plain, i) => expect(reopened.reveal(handle, i + 1)).toBe(plain));
      }
    } finally { await store.close(); }
  });

  it('writes new secrets under data keys before the migration has run', async () => {
    const { dir } = epoch3Vault({ old: { current: 'v' } });
    const vault = new Vault(dir);
    await vault.put('new', 'n', A);
    expect(readJson(entryFile(dir, 'new')).blob).toMatch(/^v3\./);
    expect(vault.reveal('old')).toBe('v');
    expect(readJson(entryFile(dir, 'old')).blob).toMatch(/^v2\./);
    const report = await vault.migrateToScopes(async () => new Map());
    expect(report).toMatchObject({ migrated: 1, unresolved: ['old'] });
  });
});

describe('key encryption key rotation', () => {
  async function populated() {
    vi.stubEnv('KARMAX_VAULT_KEY', KEY_A);
    const dir = directory();
    const vault = new Vault(dir);
    await vault.put('a', 'alpha', A);
    await vault.put('b', 'beta', B);
    await vault.put('u', 'user', userScope('u_1'));
    await vault.put('i', 'installation', INSTALLATION_SCOPE);
    return dir;
  }
  const opensAll = (dir: string, kek: { current: LocalKek; others?: LocalKek[] }) => {
    const vault = new Vault(dir, { kek: { current: kek.current, others: kek.others ?? [] } });
    return ['a', 'b', 'u', 'i'].map((handle) => vault.reveal(handle));
  };
  const old = () => LocalKek.fromText(KEY_A), next = () => LocalKek.fromText(KEY_B);
  const values = ['alpha', 'beta', 'user', 'installation'];
  /** Fail the nth keyring or canary write under keys/. */
  const crashOnKeyWrite = (n: number) => {
    const rename = fs.renameSync;
    let writes = 0;
    return vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes(`${path.sep}keys${path.sep}`) && ++writes >= n) throw new Error('crash');
      return rename(from, to);
    });
  };

  it('adds wraps, switches, then prunes, with the old key working until the switch', async () => {
    const dir = await populated();
    await new Vault(dir, { kek: { current: next(), others: [old()] } }).wrapUnderCurrentKek();
    expect(opensAll(dir, { current: old() })).toEqual(values);
    expect(opensAll(dir, { current: next() })).toEqual(values);
    const status = new Vault(dir, { kek: { current: next(), others: [] } }).keyStatus();
    expect(status.wraps).toEqual({ [next().id]: 4, [old().id]: 4 });
    await new Vault(dir, { kek: { current: next(), others: [] } }).pruneKeks();
    expect(opensAll(dir, { current: next() })).toEqual(values);
    expect(() => opensAll(dir, { current: old() })).toThrow(/vault key does not open this vault.*wrapped under vk-/);
    expect(new Vault(dir, { kek: { current: next(), others: [] } }).keyStatus().wraps).toEqual({ [next().id]: 4 });
  });

  it('crash-safe: interrupted while adding the new wraps', async () => {
    const dir = await populated();
    const spy = crashOnKeyWrite(3);
    await expect(new Vault(dir, { kek: { current: next(), others: [old()] } }).wrapUnderCurrentKek()).rejects.toThrow('crash');
    spy.mockRestore();
    expect(opensAll(dir, { current: old() })).toEqual(values);
    // The new key's canary is written last: alone, it is not yet the vault's key.
    expect(() => opensAll(dir, { current: next() })).toThrow(/vault key does not open this vault/);
    await new Vault(dir, { kek: { current: next(), others: [old()] } }).wrapUnderCurrentKek();
    expect(opensAll(dir, { current: next() })).toEqual(values);
    expect(opensAll(dir, { current: old() })).toEqual(values);
  });

  it('crash-safe: a data key created by the live app between add and switch', async () => {
    const dir = await populated();
    await new Vault(dir, { kek: { current: next(), others: [old()] } }).wrapUnderCurrentKek();
    // The app, still on the old key, creates a new organization's data key.
    await new Vault(dir, { kek: { current: old(), others: [] } }).put('c', 'gamma', organizationScope('org_c'));
    expect(() => new Vault(dir, { kek: { current: next(), others: [] } })).toThrow(/1 data key.*not wrapped under vk-.*rotate-vault-key/);
    expect(() => new Vault(dir, { kek: { current: next(), others: [] } }).pruneKeks()).toThrow();
    // The catch-up add (deploy/karmax runs it with the app stopped) closes the gap.
    await new Vault(dir, { kek: { current: next(), others: [old()] } }).wrapUnderCurrentKek();
    expect(new Vault(dir, { kek: { current: next(), others: [] } }).reveal('c')).toBe('gamma');
  });

  it('crash-safe: interrupted while pruning the old wraps', async () => {
    const dir = await populated();
    await new Vault(dir, { kek: { current: next(), others: [old()] } }).wrapUnderCurrentKek();
    const spy = crashOnKeyWrite(2);
    await expect(new Vault(dir, { kek: { current: next(), others: [] } }).pruneKeks()).rejects.toThrow('crash');
    spy.mockRestore();
    expect(opensAll(dir, { current: next() })).toEqual(values);
    // The old key's canary goes first, so a half-pruned vault refuses it cleanly.
    expect(() => opensAll(dir, { current: old() })).toThrow(/vault key does not open this vault/);
    await new Vault(dir, { kek: { current: next(), others: [] } }).pruneKeks();
    expect(new Vault(dir, { kek: { current: next(), others: [] } }).keyStatus().wraps).toEqual({ [next().id]: 4 });
  });

  it('refuses to rotate the key of a vault the migration has not finished', async () => {
    const { dir: legacy } = epoch3Vault({ x: { current: 'y' } });
    await expect(new Vault(legacy, { kek: { current: old(), others: [] } }).wrapUnderCurrentKek()).rejects.toThrow(/data epoch 4 migration/);
    await expect(new Vault(legacy, { kek: { current: old(), others: [] } }).pruneKeks()).rejects.toThrow(/data epoch 4 migration/);
  });

  it('is what npm run vault-key runs', async () => {
    const dir = await populated();
    const keyFile = path.join(directory(), 'vault_key.next');
    fs.writeFileSync(keyFile, `${KEY_B}\n`);
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/vault-key.ts', '--vault', dir, ...args],
      { encoding: 'utf8', env: { ...process.env, KARMAX_VAULT_KEY: KEY_A, KARMAX_HOME: directory() } });
    const added = run('add', keyFile);
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toMatch(new RegExp(`4 data keys wrapped under ${next().id}`));
    const status = run('status');
    expect(status.stdout).toContain(next().id);
    const pruned = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/vault-key.ts', '--vault', dir, 'prune'],
      { encoding: 'utf8', env: { ...process.env, KARMAX_VAULT_KEY: KEY_B, KARMAX_HOME: directory() } });
    expect(pruned.status, pruned.stderr).toBe(0);
    expect(opensAll(dir, { current: next() })).toEqual(values);
  });
});

describe('data key rotation', () => {
  it('re-encrypts a scope’s entries and revisions, then retires the old data key', async () => {
    const dir = directory();
    const vault = new Vault(dir);
    await vault.put('a1', 'one', A);
    await vault.put('a1', 'two', A);
    await vault.put('a2', 'other', A);
    await vault.put('b1', 'bee', B);
    const before = readJson(keyringFile(dir, A));
    const oldKid = before.current;
    const ringB = fs.readFileSync(keyringFile(dir, B), 'utf8');
    const result = await vault.rotateDataKey(A);
    expect(result).toMatchObject({ reencrypted: 2, retired: [oldKid] });
    const after = readJson(keyringFile(dir, A));
    expect(after.current).not.toBe(oldKid);
    expect(Object.keys(after.keys)).toEqual([after.current]);
    for (const handle of ['a1', 'a2']) {
      const entry = readJson(entryFile(dir, handle));
      for (const blob of [entry.blob, ...(entry.previous ?? [])]) expect(blob.split('.')[1]).toBe(after.current);
    }
    expect(vault.reveal('a1')).toBe('two');
    expect(vault.reveal('a1', 1)).toBe('one');
    expect(new Vault(dir).reveal('a2')).toBe('other');
    expect(fs.readFileSync(keyringFile(dir, B), 'utf8')).toBe(ringB);
  });

  it('resumes an interrupted rotation without minting another key', async () => {
    const dir = directory();
    const vault = new Vault(dir);
    for (let i = 0; i < 4; i++) await vault.put(`a${i}`, `v${i}`, A);
    const rename = fs.renameSync;
    let entryWrites = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes(`${path.sep}entries${path.sep}`) && ++entryWrites > 2) throw new Error('crash');
      return rename(from, to);
    });
    await expect(vault.rotateDataKey(A)).rejects.toThrow('crash');
    spy.mockRestore();
    const mid = readJson(keyringFile(dir, A));
    expect(Object.keys(mid.keys)).toHaveLength(2);
    for (let i = 0; i < 4; i++) expect(new Vault(dir).reveal(`a${i}`)).toBe(`v${i}`);
    const result = await new Vault(dir).rotateDataKey(A);
    expect(result.reencrypted).toBe(2);
    const after = readJson(keyringFile(dir, A));
    expect(after.current).toBe(mid.current);
    expect(Object.keys(after.keys)).toEqual([mid.current]);
  });
});

describe('crypto-shredding a scope', () => {
  it('destroys the keyring, entries, revisions and quarantine of one scope only', async () => {
    const dir = directory();
    const broker = new CredentialBroker(new Vault(dir));
    await broker.registerHandle('a1', 'one', A);
    await broker.registerHandle('a1', 'two', A);
    await broker.registerHandle('b1', 'bee', B);
    const leftover = fs.readFileSync(entryFile(dir, 'a1'), 'utf8');
    // A quarantined copy, as a damaged-revision quarantine leaves one.
    fs.mkdirSync(path.join(dir, 'entries', 'quarantine'), { recursive: true });
    const quarantined = path.join(dir, 'entries', 'quarantine', `${sha('a1')}.json.1.x`);
    fs.writeFileSync(quarantined, leftover);
    fs.writeFileSync(`${quarantined}.why`, JSON.stringify({ handle: 'a1', reason: 'test' }));
    const result = await broker.destroyScope(A);
    expect(result).toMatchObject({ entries: 1, quarantined: 1 });
    expect(fs.existsSync(keyringFile(dir, A))).toBe(false);
    expect(broker.hasHandle('a1')).toBe(false);
    expect(fs.existsSync(quarantined)).toBe(false);
    expect(broker.resolve('b1', { caps: ['use-credential:*'] })).toBe('bee');
    // A copy that survived elsewhere (an old snapshot of the entry) no longer opens.
    fs.writeFileSync(entryFile(dir, 'a1'), leftover);
    expect(() => new Vault(dir).reveal('a1')).toThrow(/data key .* organization:org_a .*(destroyed|missing)/);
    expect(() => new Vault(dir).reveal('a1', 1)).toThrow(/data key/);
    await expect(broker.destroyScope(INSTALLATION_SCOPE)).rejects.toThrow(/installation/);
  });
});
