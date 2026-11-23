import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exposeRemoteNodeCommand, installRemoteNodeCommand, PINNED_REMOTE_NODE_VERSION, PINNED_REMOTE_NPM_VERSION,
  REMOTE_NODE_TARBALL_SHA512 } from '../src/agent/remote-node.js';

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
  const command = installRemoteNodeCommand(destination, process.versions.node, '10.9.2', { bakedRoot: baked });
  const run = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  const copied = path.join(destination, 'node_modules/npm/package.json');
  expect(JSON.parse(fs.readFileSync(copied, 'utf8')).version).toBe('10.9.2');
  expect(fs.realpathSync(path.join(destination, 'node_modules/node/bin/node'))).toBe(fs.realpathSync(process.execPath));
  expect(fs.lstatSync(path.join(destination, 'node_modules/npm')).isSymbolicLink()).toBe(true);
});

/** A registry directory (file://) serving fake node-linux-* and npm tarballs. */
function registryFixture(base: string, nodeVersion: string, npmVersion: string) {
  const registry = path.join(base, 'registry');
  const sha512: Record<string, string> = {};
  const pack = (name: string, version: string, files: Record<string, string>) => {
    const source = path.join(base, `src-${name}`, 'package');
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      fs.writeFileSync(path.join(source, file), content, { mode: 0o755 });
    }
    fs.mkdirSync(path.join(registry, name, '-'), { recursive: true });
    const tarball = path.join(registry, name, '-', `${name}-${version}.tgz`);
    const tar = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(source), 'package']);
    expect(tar.status, String(tar.stderr)).toBe(0);
    sha512[`${name}@${version}`] = crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('hex');
  };
  for (const name of ['node-linux-x64', 'node-linux-arm64'])
    pack(name, nodeVersion, { 'bin/node': `#!/bin/sh\necho ${name}-${nodeVersion}\n` });
  pack('npm', npmVersion, { 'package.json': JSON.stringify({ version: npmVersion }), 'bin/npm-cli.js': '#!/bin/sh\necho npm-cli\n' });
  return { registry: pathToFileURL(registry).href, sha512 };
}

/** An image whose `npm` must not be used (it fails loudly; E2B's desktop template has none). */
function withoutNpm(system: string) {
  fs.writeFileSync(path.join(system, 'npm'), '#!/bin/sh\necho "npm: command not found" >&2; exit 127\n', { mode: 0o755 });
  return { ...process.env, PATH: `${system}:/usr/bin:/bin` };
}

// tavya-error 88b6473390db0033 (2026-11-19): a task whose Computer is a desktop
// starts from E2B's own `desktop` template, which has neither the baked pair nor
// any npm, and every turn failed "bash: line 9: npm: command not found".
it('installs the pinned pair from the registry tarballs on an image without the baked pair or npm', () => {
  const { runtime, system } = fixture();
  const { registry, sha512 } = registryFixture(runtime, '22.16.0', '10.9.2');
  const destination = path.join(runtime, 'task runtime');
  // A partial pair an interrupted install left behind is replaced.
  fs.mkdirSync(path.join(destination, 'node_modules/node/stale'), { recursive: true });
  // The image's configured registry (a mirror) serves them: the pins check the bytes.
  const command = installRemoteNodeCommand(destination, '22.16.0', '10.9.2', { bakedRoot: path.join(runtime, 'none'), sha512 });
  const run = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...withoutNpm(system), npm_config_registry: `${registry}/` } });
  expect(run.status, run.stderr).toBe(0);
  const node = spawnSync(path.join(destination, 'node_modules/node/bin/node'), { encoding: 'utf8' });
  expect(node.stdout.trim()).toMatch(/^node-linux-(x64|arm64)-22\.16\.0$/);
  expect(JSON.parse(fs.readFileSync(path.join(destination, 'node_modules/npm/package.json'), 'utf8')).version).toBe('10.9.2');
  expect(fs.existsSync(path.join(destination, 'node_modules/node/stale'))).toBe(false);
  expect(fs.existsSync(path.join(destination, '.download'))).toBe(false);
});

it('refuses a tarball that does not match its pin and keeps what was there', () => {
  const { runtime, system } = fixture();
  const { registry, sha512 } = registryFixture(runtime, '22.16.0', '10.9.2');
  const destination = path.join(runtime, 'task runtime');
  const tampered = { ...sha512, 'npm@10.9.2': '0'.repeat(128) };
  const run = spawnSync('bash', ['-c', installRemoteNodeCommand(destination, '22.16.0', '10.9.2',
    { bakedRoot: path.join(runtime, 'none'), registry, sha512: tampered })], { encoding: 'utf8', env: withoutNpm(system) });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('does not match its pinned sha512');
  expect(fs.existsSync(path.join(destination, 'node_modules/node'))).toBe(false);
  expect(fs.existsSync(path.join(destination, '.download'))).toBe(false);
});

it('pins the published tarballs of the pinned pair for every architecture', () => {
  for (const name of ['node-linux-x64', 'node-linux-arm64'])
    expect(REMOTE_NODE_TARBALL_SHA512[`${name}@${PINNED_REMOTE_NODE_VERSION}`]).toMatch(/^[0-9a-f]{128}$/);
  expect(REMOTE_NODE_TARBALL_SHA512[`npm@${PINNED_REMOTE_NPM_VERSION}`]).toMatch(/^[0-9a-f]{128}$/);
});

it('falls back to the image\'s npm for a version without pins when the baked pair is missing or mismatched', () => {
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
    const run = spawnSync('bash', ['-c', installRemoteNodeCommand(runtime, process.versions.node, '10.9.2', { bakedRoot: source, sha512: {} })], {
      encoding: 'utf8', env: { ...process.env, PATH: `${system}:/usr/bin:/bin` },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`node@${process.versions.node}`);
    expect(run.stdout).toContain('npm@10.9.2');
  }
});

// CI #2267 (2026-10-22): with the registry's audit endpoint down, installing
// node@<v> hung. Its preinstall runs a nested `npm install`, which is handed
// `--no-audit` as an empty npm_config_audit (read as "unset", so it audits),
// but reads its global config from <prefix>/etc/npmrc.
it('turns the audit off for the npm the node package runs itself', () => {
  const { runtime, system } = fixture();
  // Like the nested npm: audit (here, stall) unless <prefix>/etc/npmrc says not to.
  fs.writeFileSync(path.join(system, 'npm'), [
    '#!/bin/sh', 'while [ "$1" != --prefix ]; do shift; done',
    'grep -qx audit=false "$2/etc/npmrc" 2>/dev/null || { echo audited; exit 7; }', 'echo installed',
  ].join('\n'), { mode: 0o755 });
  const run = spawnSync('bash', ['-c', installRemoteNodeCommand(runtime, process.versions.node, '10.9.2', { bakedRoot: `${runtime}/none`, sha512: {} })], {
    encoding: 'utf8', env: { ...process.env, PATH: `${system}:/usr/bin:/bin` },
  });
  expect(run.stdout.trim(), run.stderr).toBe('installed');
  expect(fs.readFileSync(path.join(runtime, 'etc/npmrc'), 'utf8')).toContain('fund=false');
});
