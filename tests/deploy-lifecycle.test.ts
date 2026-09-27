import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function deployment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-lifecycle-'));
  roots.push(root);
  const deploy = path.join(root, 'deploy');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(deploy); fs.mkdirSync(bin);
  for (const file of ['karmax', 'compact-backups.sh', 'compose.turnkey.yml'])
    fs.copyFileSync(path.resolve('deploy', file), path.join(deploy, file));
  fs.mkdirSync(path.join(deploy, '.secrets'));
  for (const secret of ['auth_secret', 'vault_key', 'world_ref_key'])
    fs.writeFileSync(path.join(deploy, '.secrets', secret), `original-${secret}`);
  fs.writeFileSync(path.join(deploy, '.turnkey.env'), 'KARMAX_DOMAIN=example.com\nPOSTGRES_PASSWORD=fixture\nKEEP_SETTING=retained\n');
  const log = path.join(root, 'docker.jsonl');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_FAIL && args.join(' ').includes(process.env.FAKE_FAIL)) process.exit(17);
if (args.includes('cp')) {
  const destination = args.at(-1);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(destination, 'manifest.hmac'), 'fixture');
}
if (args.includes('pg_dump')) process.stdout.write('dump-' + args.at(-1));
if (args.includes('pg_restore')) fs.readFileSync(0);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const run = (args: string[], fail = '', input = '') => spawnSync('sh', [path.join(deploy, 'karmax'), ...args], {
    encoding: 'utf8', input, timeout: 30_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_FAIL: fail },
  });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [];
  return { root, deploy, run, calls, clear: () => fs.writeFileSync(log, '') };
}

it('publishes a complete backup atomically and verifies its checksums (CI-37)', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  const result = h.run(['backup', destination]);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readdirSync(destination).sort()).toEqual(['SHA256SUMS', 'control-plane', 'deployment-secrets', 'karmax.dump', 'temporal-visibility.dump', 'temporal.dump']);
  expect(spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: destination }).status).toBe(0);
  expect(fs.readdirSync(h.root).some(name => name.includes('.partial.'))).toBe(false);
  expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key'), 'utf8')).toBe('original-vault_key');
});

it('starts only after configuration validates, preserves secrets, and waits for readiness', () => {
  const h = deployment();
  const result = h.run(['up', 'example.com']);
  expect(result.status, result.stderr).toBe(0);
  const calls = h.calls().map(args => args.join(' '));
  expect(calls.findIndex(call => call.endsWith('config --quiet'))).toBeLessThan(calls.findIndex(call => call.includes('up -d --build')));
  expect(calls.findIndex(call => call.includes('up -d --build'))).toBeLessThan(calls.findIndex(call => call.includes('/api/health/ready')));
  expect(result.stdout).toContain('Karmax is ready');
  expect(fs.readFileSync(path.join(h.deploy, '.turnkey.env'), 'utf8')).toContain('KEEP_SETTING=retained');
  expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key'), 'utf8')).toBe('original-vault_key');
});

it('does not start containers when compose validation fails', () => {
  const h = deployment();
  expect(h.run(['up', 'example.com'], 'config --quiet').status).not.toBe(0);
  expect(h.calls().some(args => args.includes('up'))).toBe(false);
});

it('does not report readiness when the app never becomes ready', () => {
  const h = deployment();
  const result = h.run(['up', 'example.com'], '/api/health/ready');
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('Karmax is ready');
  expect(h.calls().some(args => args.includes('logs'))).toBe(true);
});

it.each(['cp app:', 'pg_dump -U temporal -Fc temporal'])('removes partial backup output when %s fails', fail => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination], fail).status).not.toBe(0);
  expect(fs.existsSync(destination)).toBe(false);
  expect(fs.readdirSync(h.root).some(name => name.includes('.partial.'))).toBe(false);
  expect(h.calls().some(args => args.includes('down'))).toBe(false);
});

it('verifies every restore input before stopping services, and waits for the restored app', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot with spaces');
  expect(h.run(['backup', destination]).status).toBe(0);
  h.clear();
  const result = h.run(['restore', destination], '', 'RESTORE\n');
  expect(result.status, result.stderr).toBe(0);
  const calls = h.calls();
  const stopped = calls.findIndex(args => args.includes('down'));
  expect(stopped).toBeGreaterThan(0);
  expect(calls.slice(0, stopped).filter(args => args.includes('pg_restore'))).toHaveLength(3);
  expect(calls.slice(0, stopped).some(args => args.includes('--verify'))).toBe(true);
  expect(calls.slice(stopped).filter(args => args.includes('dropdb'))).toHaveLength(3);
  expect(calls.slice(stopped).some(args => args.includes('restore') && !args.includes('--verify'))).toBe(true);
  expect(result.stdout).toContain('Restore complete');
});

it.each(['npm run restore -- --verify', 'pg_restore -f /dev/null'])('leaves services and secrets untouched when restore validation fails: %s', fail => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  h.clear();
  expect(h.run(['restore', destination], fail, 'RESTORE\n').status).not.toBe(0);
  expect(h.calls().some(args => args.includes('down') || args.includes('dropdb'))).toBe(false);
  expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key'), 'utf8')).toBe('original-vault_key');
});

it('rejects changed dump bytes and cancelled confirmation before stopping services', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  h.clear();
  expect(h.run(['restore', destination], '', 'NO\n').status).not.toBe(0);
  expect(h.calls().some(args => args.includes('down'))).toBe(false);
  h.clear();
  fs.appendFileSync(path.join(destination, 'temporal.dump'), 'tampered');
  expect(h.run(['restore', destination], '', 'RESTORE\n').status).not.toBe(0);
  expect(h.calls().some(args => args.includes('build') || args.includes('down'))).toBe(false);
});

it('keeps the authentication key outside snapshots and preserves it on restore (DB-10)', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  expect(fs.existsSync(path.join(destination, 'deployment-secrets', 'vault_key'))).toBe(false);
  expect(h.run(['restore', destination], '', 'RESTORE\n').status).toBe(0);
  expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key'), 'utf8')).toBe('original-vault_key');
});
