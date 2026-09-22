import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { replaceFileSync } from '../src/util/replace-file.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-config-publication-'));
  roots.push(root);
  return root;
}

it('publishes complete managed config while another process continuously reads it', async () => {
  const homes = new ConfigHomeManager(fixture());
  const home = homes.ensure('claude', 'fixture');
  const file = path.join(home, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ payload: 'x'.repeat(256 * 1024), mcpServers: {} }));
  const child = fork(fileURLToPath(new URL('./fixtures/config-reader.mjs', import.meta.url)), [file], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { PATH: process.env.PATH },
  });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toBe('ready');
    for (let i = 0; i < 80; i++) {
      homes.writeMcpConfig(home, 'claude', { browser: i % 2 ? 'playwright' : 'chrome-devtools' });
      await new Promise(resolve => setImmediate(resolve));
    }
    const reply = once(child, 'message');
    child.send('stop');
    const [result] = await reply;
    expect(result.errors).toEqual([]);
    expect(result.reads).toBeGreaterThan(1);
    await exited;
    expect(fs.readdirSync(home).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}, 15_000);

it('keeps symlinks and existing permissions, including an initially dangling link', () => {
  const root = fixture(), link = path.join(root, 'config.json'), target = path.join(root, 'actual.json');
  fs.symlinkSync('actual.json', link);
  replaceFileSync(link, 'first');
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe('first');
  fs.chmodSync(target, 0o640);
  replaceFileSync(link, 'second');
  expect(fs.readFileSync(target, 'utf8')).toBe('second');
  expect(fs.statSync(target).mode & 0o777).toBe(0o640);
});

it('retains the prior file and removes temporary data when publication fails', () => {
  const root = fixture(), file = path.join(root, 'config.json');
  fs.writeFileSync(file, 'prior');
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected rename failure'); });
  expect(() => replaceFileSync(file, 'replacement')).toThrow('injected rename failure');
  expect(fs.readFileSync(file, 'utf8')).toBe('prior');
  expect(fs.readdirSync(root)).toEqual(['config.json']);
});

it('treats a home removed during account discovery as absent', () => {
  const root = fixture();
  const homes = new ConfigHomeManager(root);
  homes.ensure('claude', 'fixture');
  const readdir = fs.readdirSync.bind(fs);
  vi.spyOn(fs, 'readdirSync').mockImplementation(((directory: string, options: any) => {
    if (String(directory) === root) fs.rmSync(root, { recursive: true, force: true });
    return readdir(directory, options);
  }) as typeof fs.readdirSync);
  expect(homes.list()).toEqual([]);
});
