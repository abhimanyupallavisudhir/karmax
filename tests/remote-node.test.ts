import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { exposeRemoteNodeCommand } from '../src/agent/remote-node.js';

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
