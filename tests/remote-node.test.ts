import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { exposeRemoteNodeCommand, installRemoteNodeCommand } from '../src/agent/remote-node.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-node-'));
  roots.push(root);
  const runtime = path.join(root, "managed runtime's bin");
  const system = path.join(root, 'system-bin');
  fs.mkdirSync(runtime);
  fs.mkdirSync(system);
  for (const name of ['node', 'npm', 'npx']) {
    fs.writeFileSync(path.join(runtime, name), `#!/bin/sh\n${name === 'node' ? 'echo modern-node' : `node; echo managed-${name}`}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(system, name), '#!/bin/sh\necho old-toolchain\n', { mode: 0o755 });
  }
  return { runtime, system };
}

it('keeps the paired toolchain after a shell discards the injected PATH, including repeated provisioning', () => {
  const { runtime, system } = fixture();
  for (let turn = 0; turn < 2; turn++) {
    const installed = spawnSync('bash', ['-c', exposeRemoteNodeCommand(runtime, system)], { encoding: 'utf8' });
    expect(installed.status, installed.stderr).toBe(0);
    // Only the image's standard bin directory is on PATH, as after /etc/profile.
    const result = spawnSync('/bin/bash', ['-c', 'node; npm; npx'], {
      env: { ...process.env, PATH: `${system}:/usr/bin:/bin` }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'modern-node', 'modern-node', 'managed-npm', 'modern-node', 'managed-npx',
    ]);
  }
});

it('leaves the system toolchain intact if the managed pair is incomplete', () => {
  const { runtime, system } = fixture();
  fs.unlinkSync(path.join(runtime, 'npm'));
  const result = spawnSync('bash', ['-c', exposeRemoteNodeCommand(runtime, system)]);
  expect(result.status).not.toBe(0);
  for (const name of ['node', 'npm', 'npx']) expect(fs.lstatSync(path.join(system, name)).isSymbolicLink()).toBe(false);
});

it('links a matching baked pair without npm downloads', () => {
  const { runtime, system } = fixture();
  const baked = path.join(runtime, "baked pair's root");
  fs.mkdirSync(path.join(baked, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(baked, 'node_modules/npm'), { recursive: true });
  fs.mkdirSync(path.join(baked, 'node_modules/node/bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(baked, 'node_modules/node/bin/node'));
  fs.symlinkSync(process.execPath, path.join(baked, 'bin/node'));
  fs.writeFileSync(path.join(baked, 'node_modules/npm/package.json'), '{"version":"10.9.2"}');
  const destination = path.join(system, 'task runtime');
  fs.mkdirSync(destination);
  const command = installRemoteNodeCommand(destination, process.versions.node, '10.9.2', baked);
  const run = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  const copied = path.join(destination, 'node_modules/npm/package.json');
  expect(JSON.parse(fs.readFileSync(copied, 'utf8')).version).toBe('10.9.2');
  expect(fs.realpathSync(path.join(destination, 'node_modules/node/bin/node'))).toBe(fs.realpathSync(process.execPath));
  expect(fs.lstatSync(path.join(destination, 'node_modules/npm')).isSymbolicLink()).toBe(true);
});

it('falls back to npm for missing or mismatched baked runtimes', () => {
  const { runtime, system } = fixture();
  const baked = path.join(runtime, 'baked');
  fs.mkdirSync(path.join(baked, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(baked, 'node_modules/npm'), { recursive: true });
  fs.mkdirSync(path.join(baked, 'node_modules/node/bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(baked, 'node_modules/node/bin/node'));
  fs.symlinkSync(process.execPath, path.join(baked, 'bin/node'));
  fs.writeFileSync(path.join(baked, 'node_modules/npm/package.json'), '{"version":"wrong"}');
  fs.writeFileSync(path.join(system, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  for (const source of [baked, `${baked}-missing`]) {
    const run = spawnSync('bash', ['-c', installRemoteNodeCommand(runtime, process.versions.node, '10.9.2', source)], {
      encoding: 'utf8', env: { ...process.env, PATH: `${system}:/usr/bin:/bin` },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`node@${process.versions.node}`);
    expect(run.stdout).toContain('npm@10.9.2');
  }
});
