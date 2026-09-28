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
