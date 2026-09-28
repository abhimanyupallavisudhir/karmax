import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from '../src/autonomy/vault.js';

/**
 * AU-27: vault ciphertext is bound to its handle (AES-GCM additional data), and
 * a key canary tells a wrong key apart from a corrupt vault before anything is
 * written with it. Existing vaults migrate in place.
 */

const directories: string[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-binding-'));
  directories.push(dir);
  return dir;
}
beforeEach(() => vi.stubEnv('KARMAX_VAULT_KEY', ''));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const entryFile = (dir: string, handle: string) =>
  path.join(dir, 'entries', `${crypto.createHash('sha256').update(handle).digest('hex')}.json`);

/** The pre-binding ciphertext format: AES-256-GCM without additional data. */
function legacyBlob(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

/** A vault as the previous release left it: one legacy map entry, one migrated
 * entry file with history, no canary and no binding. */
function legacyVault(): { dir: string; key: Buffer } {
  const dir = directory();
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dir, 'vault.key'), key, { mode: 0o600 });
  fs.mkdirSync(path.join(dir, 'entries'), { mode: 0o700 });
  fs.writeFileSync(entryFile(dir, 'rotated'), JSON.stringify({
    handle: 'rotated', blob: legacyBlob(key, 'current'), previous: [legacyBlob(key, 'older')],
  }));
  fs.writeFileSync(path.join(dir, 'entries', '.migrated'), '');
  return { dir, key };
}

describe('handle-bound vault ciphertext', () => {
  it('refuses a ciphertext moved onto another handle', async () => {
    const dir = directory();
    const vault = new Vault(dir);
    await vault.put('attacker', 'attacker-secret');
    await vault.put('victim', 'victim-secret');
    const moved = JSON.parse(fs.readFileSync(entryFile(dir, 'attacker'), 'utf8')).blob;
    fs.writeFileSync(entryFile(dir, 'victim'), JSON.stringify({ handle: 'victim', blob: moved }));
    expect(() => vault.reveal('victim')).toThrow(/victim.*failed authentication/);
  });

  it('keeps the history readable when a handle is renamed', async () => {
    const vault = new Vault(directory());
    await vault.put('old', 'first');
    await vault.put('old', 'second');
    await vault.move('old', 'new');
    expect(vault.reveal('new')).toBe('second');
    expect(vault.reveal('new', 1)).toBe('first');
  });

  it('migrates existing entries and their history, then refuses unbound ciphertext', async () => {
    const { dir, key } = legacyVault();
    const vault = new Vault(dir);
    expect(vault.reveal('rotated')).toBe('current');
    await vault.migrate();
    const entry = JSON.parse(fs.readFileSync(entryFile(dir, 'rotated'), 'utf8'));
    expect(entry.blob).toMatch(/^v2\./);
    expect(entry.previous[0]).toMatch(/^v2\./);
    expect(vault.reveal('rotated')).toBe('current');
    expect(vault.reveal('rotated', 1)).toBe('older');
    fs.writeFileSync(entryFile(dir, 'rotated'), JSON.stringify({ handle: 'rotated', blob: legacyBlob(key, 'planted') }));
    expect(() => vault.reveal('rotated')).toThrow(/not bound to its handle/);
  });

  it('migrates a legacy secret map on the first write', async () => {
    const dir = directory();
    const key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dir, 'vault.key'), key, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ mapped: legacyBlob(key, 'from-the-map') }));
    const vault = new Vault(dir);
    await vault.put('fresh', 'value');
    expect(vault.reveal('mapped')).toBe('from-the-map');
    expect(JSON.parse(fs.readFileSync(entryFile(dir, 'mapped'), 'utf8')).blob).toMatch(/^v2\./);
  });
});

describe('vault key canary', () => {
  it('refuses to open a vault with a different key before writing anything', async () => {
    const dir = directory();
    vi.stubEnv('KARMAX_VAULT_KEY', 'the-original-deployment-key-material-000');
    await new Vault(dir).put('kept', 'secret');
    const before = fs.readdirSync(path.join(dir, 'entries')).sort();
    vi.stubEnv('KARMAX_VAULT_KEY', 'a-different-deployment-key-material-111');
    expect(() => new Vault(dir)).toThrow(/vault key does not open this vault/);
    expect(fs.readdirSync(path.join(dir, 'entries')).sort()).toEqual(before);
  });

  it('checks a vault from before the canary against its entries, then records one', () => {
    const { dir } = legacyVault();
    vi.stubEnv('KARMAX_VAULT_KEY', 'not-the-key-this-vault-was-created-with');
    expect(() => new Vault(dir)).toThrow(/vault key does not open this vault/);
    expect(fs.existsSync(path.join(dir, 'vault.canary'))).toBe(false);
    vi.stubEnv('KARMAX_VAULT_KEY', '');
    expect(new Vault(dir).reveal('rotated')).toBe('current');
    expect(fs.existsSync(path.join(dir, 'vault.canary'))).toBe(true);
  });
});

/** An entry the vault wrote under another key (a split vault) or not at all. */
function foreignEntry(dir: string, handle: string) {
  fs.writeFileSync(entryFile(dir, handle), JSON.stringify({ handle, blob: legacyBlob(crypto.randomBytes(32), 'foreign') }));
}

describe('a one-way migration that keeps its way back', () => {
  it('copies the unbound entries aside before binding them', async () => {
    const { dir } = legacyVault();
    const original = fs.readFileSync(entryFile(dir, 'rotated'), 'utf8');
    await new Vault(dir).migrate();
    const aside = path.join(dir, 'entries.pre-v2', path.basename(entryFile(dir, 'rotated')));
    expect(fs.readFileSync(aside, 'utf8')).toBe(original);
    expect(fs.readFileSync(entryFile(dir, 'rotated'), 'utf8')).not.toBe(original);
  });

  it('quarantines the entries that will not open and binds the rest', async () => {
    const { dir, key } = legacyVault();
    fs.writeFileSync(entryFile(dir, 'second'), JSON.stringify({ handle: 'second', blob: legacyBlob(key, 'two') }));
    fs.writeFileSync(entryFile(dir, 'power-loss'), '');
    fs.writeFileSync(entryFile(dir, 'garbled'), '{"handle":');
    foreignEntry(dir, 'foreign');
    const vault = new Vault(dir);
    expect(vault.list()).toEqual(expect.arrayContaining(['rotated', 'second', 'foreign']));
    const { quarantined } = await vault.migrate();
    expect(quarantined.map(q => q.handle ?? null).sort()).toEqual(['foreign', null, null].sort());
    expect(fs.readdirSync(path.join(dir, 'entries', 'quarantine'))).toHaveLength(3);
    expect(vault.list().sort()).toEqual(['rotated', 'second']);
    expect(vault.reveal('second')).toBe('two');
    // Later writes are not held hostage by the damaged entries.
    await vault.put('after', 'value');
    await vault.delete('rotated');
    expect(vault.reveal('after')).toBe('value');
  });

  it('lists around an unreadable entry instead of refusing', async () => {
    const dir = directory();
    const vault = new Vault(dir);
    await vault.put('kept', 'secret');
    fs.writeFileSync(path.join(dir, 'entries', `${'0'.repeat(64)}.json`), '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(vault.list()).toEqual(['kept']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
  });

  it('keeps a readable secret whose older revision is damaged', async () => {
    const { dir } = legacyVault();
    const entry = JSON.parse(fs.readFileSync(entryFile(dir, 'rotated'), 'utf8'));
    entry.previous.push(legacyBlob(crypto.randomBytes(32), 'foreign'));
    fs.writeFileSync(entryFile(dir, 'rotated'), JSON.stringify(entry));
    const vault = new Vault(dir);
    const { quarantined } = await vault.migrate();
    expect(quarantined).toEqual([expect.objectContaining({ handle: 'rotated', reason: expect.stringMatching(/revision/) })]);
    expect(vault.reveal('rotated')).toBe('current');
    expect(vault.reveal('rotated', 1)).toBe('older');
    expect(vault.reveal('rotated', 2)).toBeUndefined();
  });

  it('syncs each entry and the directory before the rename publishes it', async () => {
    const vault = new Vault(directory());
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const rename = vi.spyOn(fs, 'renameSync');
    await vault.put('durable', 'value');
    const renamed = rename.mock.invocationCallOrder[0]!;
    expect(fsync.mock.invocationCallOrder.some(call => call < renamed)).toBe(true);
    expect(fsync.mock.invocationCallOrder.some(call => call > renamed)).toBe(true);
  });
});

describe('the canary decides only when it can', () => {
  it('re-checks an empty or truncated canary against the entries and rewrites it', async () => {
    const dir = directory();
    await new Vault(dir).put('kept', 'secret');
    const canary = path.join(dir, 'vault.canary');
    const good = fs.readFileSync(canary, 'utf8');
    for (const damaged of ['', good.slice(0, good.length - 10)]) {
      fs.writeFileSync(canary, damaged);
      expect(new Vault(dir).reveal('kept')).toBe('secret');
      expect(fs.readFileSync(canary, 'utf8')).not.toBe(damaged);
    }
    fs.writeFileSync(canary, '');
    vi.stubEnv('KARMAX_VAULT_KEY', 'a-different-deployment-key-material-111');
    expect(() => new Vault(dir)).toThrow(/vault key does not open this vault/);
  });

  it('does not record a key that opens only a minority of the entries', () => {
    const { dir } = legacyVault();
    const minority = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dir, 'vault.key'), minority);
    for (const handle of ['a', 'b']) foreignEntry(dir, handle);
    fs.writeFileSync(entryFile(dir, 'mine'), JSON.stringify({ handle: 'mine', blob: legacyBlob(minority, 'x') }));
    // 'mine' opens under this key; 'rotated', 'a' and 'b' do not.
    expect(() => new Vault(dir)).toThrow(/opens 1 of 4 entries/);
    expect(fs.existsSync(path.join(dir, 'vault.canary'))).toBe(false);
  });

  it('keeps refusing unbound ciphertext when the canary is deleted', async () => {
    const { dir, key } = legacyVault();
    await new Vault(dir).migrate();
    fs.rmSync(path.join(dir, 'vault.canary'));
    fs.rmSync(path.join(dir, 'entries', '.bound'), { force: true });
    fs.writeFileSync(entryFile(dir, 'planted'), JSON.stringify({ handle: 'planted', blob: legacyBlob(key, 'planted') }));
    const vault = new Vault(dir);
    await vault.migrate();
    expect(() => vault.reveal('planted')).toThrow(/not bound to its handle/);
  });

  it('opens a vault it cannot write, as the read-only restore drill does', async () => {
    const dir = directory();
    await new Vault(dir).put('kept', 'secret');
    fs.rmSync(path.join(dir, 'vault.canary'));
    fs.chmodSync(dir, 0o500);
    try { expect(new Vault(dir).reveal('kept')).toBe('secret'); }
    finally { fs.chmodSync(dir, 0o700); }
  });
});

describe('replacing a secret without its history', () => {
  it('drops the earlier revisions', async () => {
    const vault = new Vault(directory());
    await vault.put('card', 'with-cvc');
    await vault.put('card', 'without-cvc', { history: false });
    expect(vault.reveal('card')).toBe('without-cvc');
    expect(vault.reveal('card', 1)).toBeUndefined();
  });
});
