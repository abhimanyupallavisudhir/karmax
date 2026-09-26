import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { acquireFileLock } from '../src/util/file-lock.js';

const linux = process.platform === 'linux' ? it : it.skip;
const directories: string[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-shared-vault-'));
  directories.push(dir);
  return dir;
}
beforeEach(() => vi.stubEnv('KARMAX_VAULT_KEY', ''));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

linux('initializes one complete key and retains independent writes from two processes', async () => {
  const dir = directory();
  const module = new URL('../src/autonomy/vault.ts', import.meta.url).href;
  const workers = ['first', 'second'].map(name => {
    const code = `
      import { Vault } from ${JSON.stringify(module)};
      process.once('message', async () => {
        try {
          const vault = new Vault(${JSON.stringify(dir)});
          for (let i = 0; i < 12; i++) {
            await vault.put(${JSON.stringify(name)} + i, 'fixture-' + i);
            await vault.putIfAbsent('shared-encryption-key', ${JSON.stringify(name)});
          }
          process.disconnect();
        } catch { process.exit(1); }
      });
      process.send('ready');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => { throw new Error('vault writer exited before readiness'); }),
    ]);
    const closed = once(child, 'close');
    return { child, ready, closed };
  });
  const timeout = setTimeout(() => { for (const { child } of workers) child.kill('SIGKILL'); }, 10_000);
  try {
    await Promise.all(workers.map(worker => worker.ready));
    for (const { child } of workers) child.send('start');
    for (const worker of workers) expect((await worker.closed)[0]).toBe(0);
    const vault = new Vault(dir);
    expect(vault.list()).toHaveLength(25);
    for (const prefix of ['first', 'second'])
      for (let i = 0; i < 12; i++) expect(vault.reveal(prefix + i)).toBe('fixture-' + i);
    expect(['first', 'second']).toContain(vault.reveal('shared-encryption-key'));
    expect(fs.readFileSync(path.join(dir, 'vault.key'))).toHaveLength(32);
  } finally {
    clearTimeout(timeout);
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      await worker.closed;
    }
  }
});

linux('waits asynchronously for another writer before reading the secret map', async () => {
  const dir = directory();
  const vault = new Vault(dir);
  const release = (await acquireFileLock(path.join(dir, 'secrets.json.lock')))!;
  let written = false;
  const writing = vault.put('later', 'fixture').then(() => { written = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(written).toBe(false);
  } finally { release(); await writing; }
  expect(vault.reveal('later')).toBe('fixture');
});

it('preserves a replacement credential when cleanup carries an older value', async () => {
  const vault = new Vault(directory());
  const broker = new CredentialBroker(vault);
  await broker.registerHandle('token', 'old');
  await broker.registerHandle('token', 'replacement');
  expect(await broker.deleteHandleIfUnchanged('token', 'old')).toBe(false);
  expect(vault.reveal('token')).toBe('replacement');
  await broker.updateHandle('token', 'renamed');
  expect(vault.has('token')).toBe(false);
  expect(vault.reveal('renamed')).toBe('replacement');
  expect(await broker.deleteHandleIfUnchanged('renamed', 'replacement')).toBe(true);
});

it('returns the same initialized encryption key to concurrent creators', async () => {
  const dir = directory();
  const first = new Vault(dir);
  const second = new Vault(dir);
  const observed = await Promise.all([
    first.putIfAbsent('key', 'first').then(() => first.reveal('key')),
    second.putIfAbsent('key', 'second').then(() => second.reveal('key')),
  ]);
  expect(new Set(observed).size).toBe(1);
  expect(['first', 'second']).toContain(observed[0]);
});

it('keeps the existing ciphertext intact when a mutation fails and releases admission', async () => {
  const dir = directory();
  const vault = new Vault(dir);
  await vault.put('retained', 'fixture');
  const before = fs.readFileSync(path.join(dir, 'secrets.json'));
  await expect(vault.move('missing', 'new')).rejects.toThrow('no secret');
  expect(fs.readFileSync(path.join(dir, 'secrets.json'))).toEqual(before);
  await vault.put('next', 'fixture-2');
  expect(vault.reveal('retained')).toBe('fixture');
});

it('bounds secret writes and reads only the requested entry (AU-5)', async () => {
  const dir = directory();
  const vault = new Vault(dir);
  await expect(vault.put('oversized', 'x'.repeat(65_537))).rejects.toThrow(/size/);
  await vault.put('one', 'first');
  await vault.put('two', 'second');
  const read = vi.spyOn(fs, 'readFileSync');
  try {
    expect(vault.reveal('one')).toBe('first');
    expect(read.mock.calls.some(([file]) => String(file).endsWith('secrets.json'))).toBe(false);
  } finally { read.mockRestore(); }
});

it('migrates legacy ciphertext without losing readable secrets (AU-5)', async () => {
  const dir = directory();
  const vault = new Vault(dir);
  await vault.put('legacy', 'retained');
  const entries = path.join(dir, 'entries');
  const entry = JSON.parse(fs.readFileSync(path.join(entries, fs.readdirSync(entries).find(file => file.endsWith('.json'))!), 'utf8'));
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ [entry.handle]: entry.blob }));
  fs.rmSync(entries, { recursive: true });
  const reopened = new Vault(dir);
  expect(reopened.reveal('legacy')).toBe('retained');
  await reopened.put('next', 'new');
  expect(new Vault(dir).reveal('legacy')).toBe('retained');
  expect(reopened.list().sort()).toEqual(['legacy', 'next']);
});


it('retains five encrypted prior values on rotation and deletes them with the handle (AU-22)', async () => {
  const dir = directory();
  const vault = new Vault(dir);
  for (let i = 0; i < 8; i++) await vault.put('rotated', `rotation-secret-${i}`);
  const reopened = new Vault(dir);
  expect(reopened.reveal('rotated')).toBe('rotation-secret-7');
  expect(reopened.reveal('rotated', 1)).toBe('rotation-secret-6');
  expect(reopened.reveal('rotated', 5)).toBe('rotation-secret-2');
  expect(reopened.reveal('rotated', 6)).toBeUndefined();
  const files = fs.readdirSync(path.join(dir, 'entries')).filter(file => file.endsWith('.json'));
  expect(files).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, 'entries', files[0]!), 'utf8')).not.toContain('rotation-secret');
  await reopened.delete('rotated');
  expect(reopened.reveal('rotated', 1)).toBeUndefined();
});
