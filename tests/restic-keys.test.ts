import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAST_KEY_PARAMS, fastKeyFile, isFastKey, openKeyFile, type ResticKeyFile } from '../src/world/restic-keys.js';
import { hostResticBinary } from '../src/world/restic.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A repository made by restic itself, on disk. */
function repository(password: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-restic-keys-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const restic = (args: string[], env: Record<string, string> = {}) => execFileSync(hostResticBinary(), args,
    { env: { PATH: process.env.PATH ?? '', HOME: dir, RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: password, ...env }, encoding: 'utf8', stdio: 'pipe' });
  restic(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'restored through a fast key');
  restic(['backup', '-q', '--host', 'tavya', path.join(dir, 'file.txt')]);
  const keys = () => fs.readdirSync(path.join(repo, 'keys'));
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(repo, 'keys', name), 'utf8')) as ResticKeyFile;
  return { dir, repo, restic, keys, read };
}

it('opens a key restic made, and refuses a wrong password or a changed key', async () => {
  const r = repository('correct horse');
  const key = r.read(r.keys()[0]!);
  expect(isFastKey(key)).toBe(false);
  const master = await openKeyFile(key, 'correct horse');
  expect(JSON.parse(master!.toString('utf8'))).toMatchObject({ mac: { k: expect.any(String), r: expect.any(String) }, encrypt: expect.any(String) });
  expect(await openKeyFile(key, 'wrong horse')).toBeUndefined();
  const data = Buffer.from(key.data, 'base64');
  data[20] = data[20]! ^ 1;
  expect(await openKeyFile({ ...key, data: data.toString('base64') }, 'correct horse')).toBeUndefined();
});

it('writes a fast key restic opens on its own, named by its content', async () => {
  const r = repository('correct horse');
  const [slow] = r.keys();
  const master = (await openKeyFile(r.read(slow!), 'correct horse'))!;
  const { name, body } = await fastKeyFile(master, 'correct horse');
  fs.writeFileSync(path.join(r.repo, 'keys', name), body);
  expect(isFastKey(r.read(name))).toBe(true);
  expect(r.read(name)).toMatchObject({ kdf: 'scrypt', ...FAST_KEY_PARAMS });
  // restic finds it by the hint, and needs no other key: the master key is the same.
  fs.rmSync(path.join(r.repo, 'keys', slow!));
  const out = path.join(r.dir, 'out');
  r.restic(['restore', 'latest', '--target', out, '-q', '--no-lock'], { RESTIC_KEY_HINT: name });
  expect(fs.readFileSync(path.join(out, r.dir, 'file.txt'), 'utf8')).toBe('restored through a fast key');
  r.restic(['check', '-q'], { RESTIC_KEY_HINT: name });
  expect(() => r.restic(['snapshots', '-q'], { RESTIC_PASSWORD: 'wrong horse', RESTIC_KEY_HINT: name })).toThrow(/wrong password/);
  // It costs about a millisecond to open, against restic's half a second.
  const started = performance.now();
  await openKeyFile(r.read(name), 'correct horse');
  expect(performance.now() - started).toBeLessThan(100);
});
