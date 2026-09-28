import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault, inspectVault } from '../src/autonomy/vault.js';

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

  // #367 review item 5: only another known key opening more entries counts
  // against this one; entries no known key opens are stale or damaged, not votes.
  it('accepts a key over stale or damaged entries, and refuses one another known key beats', () => {
    const { dir, key } = legacyVault();
    fs.writeFileSync(entryFile(dir, 'second'), JSON.stringify({ handle: 'second', blob: legacyBlob(key, 'two') }));
    for (const handle of ['a', 'b', 'c']) foreignEntry(dir, handle);
    expect(new Vault(dir).reveal('rotated')).toBe('current'); // opens 2 of 5
    fs.rmSync(path.join(dir, 'vault.canary'));
    // KARMAX_VAULT_KEY names another key, while vault.key opens more entries.
    vi.stubEnv('KARMAX_VAULT_KEY', 'a-key-that-opens-only-one-entry-000000');
    const other = crypto.createHash('sha256').update('a-key-that-opens-only-one-entry-000000').digest();
    fs.writeFileSync(entryFile(dir, 'mine'), JSON.stringify({ handle: 'mine', blob: legacyBlob(other, 'x') }));
    const refusal = (() => { try { new Vault(dir); } catch (error) { return String(error); } })();
    expect(refusal).toMatch(/vault\.canary is missing.*opens 1 of 6 entries.*vault\/vault\.key opens 2/);
    expect(fs.existsSync(path.join(dir, 'vault.canary'))).toBe(false);
    // The operator can insist, naming this key.
    vi.stubEnv('KARMAX_VAULT_ACCEPT_KEY', /KARMAX_VAULT_ACCEPT_KEY=(vk-[0-9a-f]+)/.exec(refusal!)![1]!);
    expect(new Vault(dir).reveal('mine')).toBe('x');
  });

  it('accepts a key that opens the only good entry beside a damaged one', () => {
    const { dir } = legacyVault();
    foreignEntry(dir, 'damaged');
    expect(new Vault(dir).reveal('rotated')).toBe('current');
  });

  it('says a missing canary, not a failed one, when the key opens no entry', () => {
    const { dir } = legacyVault();
    vi.stubEnv('KARMAX_VAULT_KEY', 'not-the-key-this-vault-was-created-with');
    expect(() => new Vault(dir)).toThrow(/vault\.canary is missing or damaged, and the key opens none of the 1 entries/);
    const dir2 = directory();
    vi.stubEnv('KARMAX_VAULT_KEY', 'the-original-deployment-key-material-000');
    return new Vault(dir2).put('kept', 'secret').then(() => {
      vi.stubEnv('KARMAX_VAULT_KEY', 'a-different-deployment-key-material-111');
      expect(() => new Vault(dir2)).toThrow(/vault\.canary fails to authenticate/);
    });
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

describe('the first boot of the binding release', () => {
  // #367 review item 4: an entry the app cannot read stops the migration
  // with a report, before anything changes, and leaves nothing behind.
  it('stops, and changes nothing, when an entry cannot be read', async () => {
    const { dir } = legacyVault();
    fs.writeFileSync(entryFile(dir, 'locked'), JSON.stringify({ handle: 'locked', blob: 'x' }));
    fs.chmodSync(entryFile(dir, 'locked'), 0o000);
    const before = fs.readFileSync(entryFile(dir, 'rotated'), 'utf8');
    try {
      for (let boot = 0; boot < 2; boot++)
        await expect(new Vault(dir).migrate()).rejects.toThrow(new RegExp(`cannot read 1 vault entr.*${path.basename(entryFile(dir, 'locked'))}.*EACCES`));
      expect(fs.readdirSync(dir).filter((name) => name.startsWith('entries.pre-v2'))).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'entries', 'quarantine'))).toBe(false);
      expect(fs.readFileSync(entryFile(dir, 'rotated'), 'utf8')).toBe(before);
    } finally { fs.chmodSync(entryFile(dir, 'locked'), 0o600); }
    fs.rmSync(entryFile(dir, 'locked'));
    await new Vault(dir).migrate();
    expect(new Vault(dir).reveal('rotated')).toBe('current');
  });

  // Item 5: a read error is not corruption.
  it('never quarantines an entry it merely failed to read', async () => {
    const { dir } = legacyVault();
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...rest: any[]) => {
      if (String(file) === entryFile(dir, 'rotated')) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      return (read as any)(file, ...rest);
    }) as any);
    const vault = new Vault(dir);
    await expect(vault.migrate()).rejects.toThrow(/cannot read 1 vault entr.*EIO/);
    spy.mockRestore();
    expect(fs.existsSync(entryFile(dir, 'rotated'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'entries', 'quarantine'))).toBe(false);
  });
});

// Item 4: what deploy/karmax runs with the new image before switching to it.
describe('a read-only preflight of the migration', () => {
  it('reports what the first boot would do, and writes nothing', async () => {
    const { dir } = legacyVault();
    foreignEntry(dir, 'foreign');
    fs.writeFileSync(entryFile(dir, 'locked'), '{}');
    fs.chmodSync(entryFile(dir, 'locked'), 0o000);
    const snapshot = () => JSON.stringify(fs.readdirSync(dir, { recursive: true }).sort());
    const before = snapshot();
    try {
      const report = inspectVault(dir);
      expect(report).toMatchObject({ key: 'accepted', bound: false, rebind: 1,
        quarantine: [expect.objectContaining({ handle: 'foreign' })],
        unreadable: [expect.objectContaining({ file: path.basename(entryFile(dir, 'locked')) })] });
      expect(snapshot()).toBe(before);
    } finally { fs.chmodSync(entryFile(dir, 'locked'), 0o600); }
    vi.stubEnv('KARMAX_VAULT_KEY', 'not-the-key-this-vault-was-created-with');
    expect(inspectVault(dir)).toMatchObject({ key: 'refused', refusal: expect.stringMatching(/vault\.canary is missing/) });
    vi.stubEnv('KARMAX_VAULT_KEY', '');
    fs.rmSync(entryFile(dir, 'locked'));
    fs.rmSync(entryFile(dir, 'foreign'));
    await new Vault(dir).migrate();
    expect(inspectVault(dir)).toMatchObject({ key: 'accepted', bound: true, rebind: 0, quarantine: [], unreadable: [] });
  });

  it('is what npm run vault-preflight reports, failing on findings', async () => {
    const { dir } = legacyVault();
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/vault-preflight.ts', dir],
      { encoding: 'utf8', env: { ...process.env, KARMAX_VAULT_KEY: '' } });
    const clean = run();
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toMatch(/key accepted.*1 entr.* to bind/s);
    foreignEntry(dir, 'foreign');
    const finding = run();
    expect(finding.status).toBe(3);
    expect(finding.stdout).toMatch(/would quarantine.*foreign/s);
  });
});

/**
 * #367 review, round 3: production's previous release (master, data epoch 2)
 * keeps the whole vault in vault/secrets.json, with no entries/, history or
 * canary. Its first boot of this release is the one that must not fail.
 */
describe('the first boot on the previous release’s vault', () => {
  /** A vault as master writes it: one secrets.json map of unbound blobs. */
  function masterVault(secrets: Record<string, string>, key = crypto.randomBytes(32), damaged: string[] = []) {
    const dir = directory();
    fs.writeFileSync(path.join(dir, 'vault.key'), key, { mode: 0o600 });
    const map: Record<string, string> = {};
    for (const [handle, plain] of Object.entries(secrets)) map[handle] = legacyBlob(key, plain);
    for (const handle of damaged) map[handle] = legacyBlob(crypto.randomBytes(32), 'foreign');
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(map), { mode: 0o600 });
    return { dir, key };
  }
  const card = JSON.stringify({ number: '4242424242424242', cvc: '123', expMonth: 1, expYear: 2031 });

  it('binds every secret, keeps malformed card secrets as they are, and boots again', async () => {
    const { dir } = masterVault({ 'world-reference:key:v2': 'world-key', 'payment:card:good': card,
      'payment:card:text': 'not json', 'payment:card:null': 'null', 'github:app': 'pem' }, undefined, ['payment:card:broken']);
    const report = inspectVault(dir);
    expect(report).toMatchObject({ key: 'accepted', bound: false, rebind: 5, unreadable: [],
      quarantine: [expect.objectContaining({ handle: 'payment:card:broken' })] });
    expect(fs.existsSync(path.join(dir, 'entries'))).toBe(false); // the preflight wrote nothing
    const { quarantined } = await new Vault(dir).migrate();
    expect(quarantined.map((entry) => entry.handle)).toEqual(report.quarantine.map((entry) => entry.handle));
    for (let boot = 0; boot < 2; boot++) {
      const vault = new Vault(dir);
      await vault.migrate();
      expect(vault.reveal('world-reference:key:v2')).toBe('world-key');
      expect(vault.reveal('payment:card:text')).toBe('not json');
      expect(vault.reveal('payment:card:null')).toBe('null');
      expect(JSON.parse(vault.reveal('payment:card:good')!)).toMatchObject({ cvc: '123' });
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'))).toEqual({});
    // No second copy of the vault is kept: the pre-update backup is the way back.
    expect(fs.readdirSync(dir).filter((name) => name.includes('pre-v2'))).toEqual([]);
  });

  it('binds a few thousand secrets reading secrets.json once', async () => {
    const secrets = Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`handle-${i}`, `secret-${i}`]));
    const { dir } = masterVault(secrets);
    const reads = vi.spyOn(fs, 'readFileSync');
    const started = Date.now();
    const vault = new Vault(dir);
    await vault.migrate();
    const elapsed = Date.now() - started;
    const mapReads = reads.mock.calls.filter(([file]) => String(file).endsWith('secrets.json')).length;
    reads.mockRestore();
    expect(mapReads).toBeLessThanOrEqual(4);
    expect(elapsed).toBeLessThan(30_000);
    expect(vault.reveal('handle-2999')).toBe('secret-2999');
  }, 60_000);

  it('refuses secrets a previous release wrote to secrets.json after the move', async () => {
    const { dir, key } = masterVault({ kept: 'value' });
    await new Vault(dir).migrate();
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ 'world-reference:key:v2': legacyBlob(key, 'regenerated') }));
    expect(() => new Vault(dir)).toThrow(/secrets\.json holds 1 secret.*pre-update backup/);
    expect(inspectVault(dir)).toMatchObject({ key: 'refused', refusal: expect.stringMatching(/secrets\.json holds 1 secret/) });
  });

  // Item 4: a canary that says "bound" is final.
  it('never unbinds a bound vault, whatever entries/ now holds', async () => {
    const { dir, key } = masterVault({ victim: 'victim-secret', attacker: 'attacker-secret' });
    await new Vault(dir).migrate();
    fs.rmSync(path.join(dir, 'entries', '.generation'), { force: true });
    fs.writeFileSync(entryFile(dir, 'victim'), JSON.stringify({ handle: 'victim', blob: legacyBlob(key, 'attacker-secret') }));
    fs.rmSync(entryFile(dir, 'attacker'));
    const vault = new Vault(dir);
    await vault.migrate();
    expect(() => vault.reveal('victim')).toThrow(/not bound to its handle/);
  });

  // Item 5: the override cannot bind the vault under a key that opens nothing.
  it('refuses the override for a key that opens none of the entries', () => {
    const { dir } = masterVault({ a: '1', b: '2' });
    vi.stubEnv('KARMAX_VAULT_KEY', 'not-the-key-this-vault-was-created-with');
    const refusal = (() => { try { new Vault(dir); } catch (error) { return String(error); } })()!;
    expect(refusal).not.toContain('KARMAX_VAULT_ACCEPT_KEY');
    vi.stubEnv('KARMAX_VAULT_ACCEPT_KEY', 'vk-anything');
    expect(() => new Vault(dir)).toThrow(/opens none of the 2 entries/);
    expect(fs.existsSync(path.join(dir, 'entries', 'quarantine'))).toBe(false);
  });

  // Item 7: temporaries a crash left in entries/ may hold a whole card.
  it('sweeps temporaries a crash left in entries/', async () => {
    const { dir } = masterVault({ kept: 'value' });
    await new Vault(dir).migrate();
    const stale = path.join(dir, 'entries', `${'a'.repeat(64)}.json.123.abc.tmp`);
    fs.writeFileSync(stale, 'plaintext-looking leftovers');
    await new Vault(dir).migrate();
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('prunes quarantined entries after the retention window', async () => {
    const { dir } = masterVault({ kept: 'value' }, undefined, ['damaged']);
    await new Vault(dir).migrate();
    const quarantine = path.join(dir, 'entries', 'quarantine');
    const [file] = fs.readdirSync(quarantine);
    const old = new Date(Date.now() - 31 * 86_400_000);
    fs.utimesSync(path.join(quarantine, file!), old, old);
    await new Vault(dir).migrate();
    expect(fs.readdirSync(quarantine)).toEqual([]);
  });

  // Item 2: the preflight runs in production with the key only in a file.
  it('preflights with the key from KARMAX_VAULT_KEY_FILE and no entries/ yet', () => {
    const material = 'turnkey-vault-key-material-0123456789abcdef';
    const { dir } = masterVault({ 'world-reference:key:v2': 'world-key', 'payment:card:text': 'not json' },
      crypto.createHash('sha256').update(material).digest());
    fs.rmSync(path.join(dir, 'vault.key'));
    const keyFile = path.join(directory(), 'vault_key');
    fs.writeFileSync(keyFile, `${material}\n`);
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/vault-preflight.ts', dir], { encoding: 'utf8',
      env: { ...process.env, KARMAX_VAULT_KEY: '', KARMAX_VAULT_KEY_FILE: keyFile, KARMAX_HOME: directory() } });
    expect(run.stdout + run.stderr).toMatch(/key accepted.*2 entries to bind/s);
    expect(run.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'entries'))).toBe(false);
  });
});
