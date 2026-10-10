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
  fs.writeFileSync(path.join(destination, 'manifest.sig'), 'fixture');
}
if (args.includes('--sign-checksums')) { fs.readFileSync(0); process.stdout.write('signature-fixture'); }
if (args.includes('pg_dump')) process.stdout.write('dump-' + args.at(-1));
if (args.join(' ').includes('shared_buffers')) {
  if (process.env.FAKE_PG_MEMORY === undefined) process.exit(1);
  process.stdout.write(process.env.FAKE_PG_MEMORY);
} else if (args.join(' ').includes('pg_stat_activity')) process.stdout.write(process.env.FAKE_SESSIONS ?? '');
if (args.includes('ps') && args.includes('-q')) process.stdout.write(process.env.FAKE_CONTAINERS ?? '');
if (args[0] === 'stats') process.stdout.write(process.env.FAKE_STATS ?? '');
if (args[0] === 'inspect') process.stdout.write(process.env.FAKE_CAPS ?? '');
if (args.join(' ').includes('object-store-check')) {
  process.stdout.write(process.env.FAKE_OBJECT_STORE ?? 'object store: local\\n');
  if (process.env.FAKE_OBJECT_STORE_FAIL) process.exit(1);
}
if (args.includes('pg_restore')) {
  const input = fs.readFileSync(0);
  if (!args.includes('/dev/null') && process.env.FAKE_RESTORED) fs.appendFileSync(process.env.FAKE_RESTORED, args.at(-1) + '=' + input + '\\n');
} else if (args.includes('run') && !args.includes('-T')) fs.readFileSync(0); // like Compose, a one-off without -T reads stdin
// Change the backup the operator pointed at once it has been verified.
if (args.join(' ').includes('--verify-deployment') && process.env.FAKE_TAMPER) fs.writeFileSync(process.env.FAKE_TAMPER, 'tampered');
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The edge: refuses connections for its first FAKE_EDGE_DOWN requests, as
  // Caddy does while it loads, then answers like Caddy's HTTPS redirect.
  const curls = path.join(root, 'curl.log');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
echo "$*" >> "${curls}"
[ "$(wc -l < "${curls}")" -gt "\${FAKE_EDGE_DOWN:-0}" ] || { printf 000; exit 7; }
printf 308
`, { mode: 0o755 });
  const run = (args: string[], fail = '', input = '', env: Record<string, string> = {}) => spawnSync('sh', [path.join(deploy, 'karmax'), ...args], {
    encoding: 'utf8', input, timeout: 30_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_FAIL: fail, ...env },
  });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [];
  const edgeRequests = () => fs.existsSync(curls) ? fs.readFileSync(curls, 'utf8').trim().split('\n') : [];
  return { root, deploy, run, calls, edgeRequests, clear: () => fs.writeFileSync(log, '') };
}

it('names a backup taken without a destination as the operator\'s, so pruning keeps it', () => {
  const h = deployment();
  const result = h.run(['backup']);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readdirSync(path.join(h.deploy, 'backups'))).toEqual([expect.stringMatching(/^manual-\d{8}T\d{6}Z$/)]);
});

it('publishes a complete backup atomically and verifies its checksums (CI-37)', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  const result = h.run(['backup', destination]);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readdirSync(destination).sort()).toEqual(['SHA256SUMS', 'SHA256SUMS.sig', 'control-plane', 'deployment-secrets', 'karmax.dump', 'temporal-visibility.dump', 'temporal.dump']);
  // The dumps are outside the signed control-plane manifest, so their checksums are signed too (DB-10).
  expect(fs.readFileSync(path.join(destination, 'SHA256SUMS.sig'), 'utf8')).toBe('signature-fixture');
  expect(h.calls().some(args => args.join(' ').includes('exec -T app npm run --silent backup -- --sign-checksums'))).toBe(true);
  expect(spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: destination }).status).toBe(0);
  // …and the control-plane manifest, so the two signatures vouch for one backup.
  expect(fs.readFileSync(path.join(destination, 'SHA256SUMS'), 'utf8')).toMatch(/ {2}control-plane\/manifest\.json$/m);
  expect(fs.readdirSync(h.root).some(name => name.includes('.partial.'))).toBe(false);
  expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key'), 'utf8')).toBe('original-vault_key');
});

// Every deploy snapshots fresh database dumps and agent transcripts. Kept
// forever they filled tavya.io's disk: 84 snapshots, 144 GB of 193 GB, in 15 days.
it('keeps the newest predeploy snapshots and two weeks of the old updater\'s, never an operator\'s', () => {
  const h = deployment();
  const backups = path.join(h.deploy, 'backups');
  const make = (name: string, daysOld = 0) => {
    const dir = path.join(backups, name);
    fs.mkdirSync(path.join(dir, 'control-plane'), { recursive: true });
    const when = new Date(Date.now() - daysOld * 86_400_000);
    fs.utimesSync(dir, when, when);
  };
  const predeploy = Array.from({ length: 12 }, (_, i) => `predeploy-202609${String(10 + i)}T000000Z`);
  // Creation order must not matter: names carry the time.
  [...predeploy].reverse().forEach(name => make(name));
  // Unprefixed stamps are the previous updater's automatic snapshots: they age
  // out like scheduled ones. Operator backups are named and kept.
  const kept = ['20260927T073452Z', 'manual-20260901T000000Z', 'incident-20260919-page-latency',
    'predeploy-20260901T000000Z.partial.7'];
  make(kept[0]!, 3); make(kept[1]!, 30); make(kept[2]!, 30); make(kept[3]!, 30);
  make('20260913T132143Z', 15);
  const result = h.run(['prune-backups']);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readdirSync(backups).sort()).toEqual([...kept, ...predeploy.slice(2)].sort());
  // Nothing to prune is not an error.
  expect(h.run(['prune-backups']).status).toBe(0);
  fs.rmSync(backups, { recursive: true });
  expect(h.run(['prune-backups']).status).toBe(0);
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

// Compose starts Caddy only once the app is healthy, so the app's own readiness
// arrives while the edge is still loading: master CI #1453 found port 80 closed
// 20 ms before Caddy listened. Plain HTTP needs neither DNS nor a certificate.
it('reports readiness only once the edge serves the domain', () => {
  const h = deployment();
  const result = h.run(['up', 'example.com'], '', '', { FAKE_EDGE_DOWN: '3' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Karmax is ready');
  expect(h.edgeRequests()).toHaveLength(4);
  expect(h.edgeRequests().at(-1)).toContain('--resolve example.com:80:127.0.0.1 http://example.com/');
});

it('fails with Caddy\'s logs when the edge never serves the domain', () => {
  const h = deployment();
  const result = h.run(['up', 'example.com'], '', '', { FAKE_EDGE_DOWN: '1000' });
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('Karmax is ready');
  expect(result.stderr).toContain('Caddy is not serving example.com');
  expect(h.calls().map(args => args.join(' '))).toContainEqual(expect.stringMatching(/logs --tail=50 caddy$/));
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

const LIVE = ['karmax', 'temporal', 'temporal_visibility'];
const into = (args: string[]) => args.includes('pg_restore') && args.includes('-d') ? args[args.indexOf('-d') + 1] : undefined;
const dropsLive = (args: string[]) => args.includes('dropdb') && LIVE.includes(args.at(-1)!);

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
  expect(calls.slice(0, stopped).filter(args => args.includes('pg_restore') && args.includes('/dev/null'))).toHaveLength(3);
  expect(calls.slice(0, stopped).some(args => args.includes('--verify-deployment'))).toBe(true);
  expect(calls.slice(stopped).filter(dropsLive)).toHaveLength(3);
  expect(calls.slice(stopped).some(args => args.join(' ').includes('npm run restore -- /restore'))).toBe(true);
  expect(result.stdout).toContain('Restore complete');
});

// A backup is private to the operator who took it, and the app image runs as
// its own uid, so the one-offs that read it run as root; the restored data is
// then handed back to the app's user.
it('reads the backup as root and gives the restored data to the app user', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  h.clear();
  expect(h.run(['restore', destination], '', 'RESTORE\n').status).toBe(0);
  // The verification reads the whole backup (/backup), the restore its control plane (/restore).
  const readers = h.calls().filter(args => args.includes('run') && args.some(arg => arg.endsWith(':/backup:ro') || arg.endsWith(':/restore:ro')));
  expect(readers).toHaveLength(2);
  for (const args of readers) expect(args.slice(args.indexOf('run'), args.indexOf('app'))).toEqual(expect.arrayContaining(['--user', 'root']));
  expect(readers[1]!.at(-1)).toBe('npm run restore -- /restore && chown -R karmax:karmax /var/lib/karmax');
});

// A new dump names the karmax role as owner, which a fresh PostgreSQL volume
// does not have: pg_restore failed after all three databases were dropped, and
// the stack stayed down with Temporal's databases empty.
it('restores every dump into a staging database before stopping or dropping anything', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  h.clear();
  const result = h.run(['restore', destination], '', 'RESTORE\n');
  expect(result.status, result.stderr).toBe(0);
  const calls = h.calls();
  const staged = calls.filter(into);
  expect(staged.map(into)).toEqual(['karmax_restore', 'temporal_restore', 'temporal_visibility_restore']);
  // Owners and grants are the role job's to apply on the next start.
  for (const args of staged) expect(args, into(args)).toEqual(expect.arrayContaining(['--no-owner', '--no-privileges']));
  const lastStaged = calls.lastIndexOf(staged.at(-1)!);
  expect(calls.findIndex(args => args.includes('down'))).toBeGreaterThan(lastStaged);
  expect(calls.findIndex(dropsLive)).toBeGreaterThan(lastStaged);
  const renames = calls.map(args => args.join(' ')).filter(call => call.includes('RENAME TO'));
  expect(renames.map(call => /ALTER DATABASE (\w+) RENAME TO (\w+)/.exec(call)?.slice(1))).toEqual(LIVE.map(db => [`${db}_restore`, db]));
});

it.each(['-d karmax_restore', '-d temporal_visibility_restore', 'createdb -U temporal temporal_restore'])(
  'keeps the live databases, services and secrets when staging fails: %s', fail => {
    const h = deployment();
    const destination = path.join(h.root, 'snapshot');
    expect(h.run(['backup', destination]).status).toBe(0);
    fs.writeFileSync(path.join(destination, 'deployment-secrets', 'vault_key'), 'restored-vault_key');
    spawnSync('sh', ['-c', 'sha256sum *.dump deployment-secrets/* > SHA256SUMS'], { cwd: destination });
    h.clear();
    const result = h.run(['restore', destination], fail, 'RESTORE\n');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/nothing on this instance was changed/);
    const calls = h.calls();
    expect(calls.some(args => args.includes('down') || dropsLive(args))).toBe(false);
    expect(calls.filter(args => args.includes('dropdb')).map(args => args.at(-1)).slice(-3))
      .toEqual(LIVE.map(db => `${db}_restore`));
    expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key'), 'utf8')).toBe('original-vault_key');
    expect(fs.readdirSync(h.deploy).filter(name => name.startsWith('.secrets'))).toEqual(['.secrets']);
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

// DB-10: a restore checks both signatures before anything stops; a backup from
// another host is trusted by fingerprint, and one from before signing needs
// the operator's explicit flag and a stronger confirmation.
it('verifies backup signatures first, and restores an unsigned backup only when told to', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  h.clear();
  const fingerprint = 'SHA256:AbCdEf+/0123456789abcdefghijklmnopqrstuvwxyz';
  expect(h.run(['restore', '--trust-key', fingerprint, destination], '', 'RESTORE\n').status).toBe(0);
  const calls = h.calls().map(args => args.join(' '));
  const stopped = calls.findIndex(call => call.endsWith(' down'));
  const checked = calls.findIndex(call => call.includes(`npm run restore -- --verify-deployment --check-vault-key --trust-key ${fingerprint} /backup`)
    && call.includes('KARMAX_VAULT_KEY_FILE=/backup/.restore-vault-key'));
  expect(checked).toBeGreaterThan(-1);
  expect(checked).toBeLessThan(stopped);
  expect(calls.slice(stopped).some(call => call.includes(`npm run restore -- --trust-key ${fingerprint} /restore`))).toBe(true);

  h.clear();
  expect(h.run(['restore', '--trust-key', 'not-a-fingerprint', destination], '', 'RESTORE\n').status).not.toBe(0);
  expect(h.calls().some(args => args.includes('build') || args.includes('run'))).toBe(false);
  // A plain RESTORE does not accept an unsigned backup.
  expect(h.run(['restore', '--accept-unsigned-v1', destination], '', 'RESTORE\n').status).not.toBe(0);
  expect(h.calls().some(args => args.includes('down'))).toBe(false);
  h.clear();
  const unsigned = h.run(['restore', '--accept-unsigned-v1', destination], '', 'RESTORE UNSIGNED\n');
  expect(unsigned.status, unsigned.stderr).toBe(0);
  expect(unsigned.stdout).toContain('This backup is unsigned');
  const accepted = h.calls().map(args => args.join(' '));
  expect(accepted.some(call => call.includes('--verify-deployment --check-vault-key --accept-unsigned-v1 /backup'))).toBe(true);
  expect(accepted.some(call => call.includes('npm run restore -- --accept-unsigned-v1 /restore'))).toBe(true);
});

// The previous release's updater wrote neither checksums nor signatures.
it('restores a snapshot from before checksums only with --accept-unsigned-v1', () => {
  const h = deployment();
  const destination = path.join(h.root, 'legacy');
  expect(h.run(['backup', destination]).status).toBe(0);
  fs.rmSync(path.join(destination, 'SHA256SUMS'));
  h.clear();
  const refused = h.run(['restore', destination], '', 'RESTORE\n');
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('--accept-unsigned-v1');
  expect(h.calls().some(args => args.includes('down'))).toBe(false);
  h.clear();
  const accepted = h.run(['restore', '--accept-unsigned-v1', destination], '', 'RESTORE UNSIGNED\n');
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(accepted.stdout).toContain('predates checksums');
  expect(h.calls().some(args => args.join(' ').includes('npm run restore -- --accept-unsigned-v1 /restore'))).toBe(true);
});

// DB-10 review: everything a restore uses comes from a private copy that was
// verified, not from the backup directory, which can change after the check.
it('restores from the private copy it verified', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  h.clear();
  const restored = path.join(h.root, 'restored');
  const result = h.run(['restore', destination], '', 'RESTORE\n',
    { FAKE_RESTORED: restored, FAKE_TAMPER: path.join(destination, 'temporal.dump') });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(restored, 'utf8')).toContain('temporal_restore=dump-temporal\n');
  expect(fs.readFileSync(restored, 'utf8')).not.toContain('tampered');
  const mounts = h.calls().map(args => args.join(' ')).filter(call => call.includes(':/backup:ro') || call.includes(':/restore:ro'));
  expect(mounts.length).toBeGreaterThan(0);
  for (const call of mounts) expect(call).not.toContain(`${destination}/`);
  expect(fs.readdirSync(h.deploy).filter(name => name.startsWith('.restore-stage'))).toEqual([]);
});

it('refuses a backup containing a symbolic link before building anything', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  fs.symlinkSync('/etc/hostname', path.join(destination, 'deployment-secrets', 'extra'));
  h.clear();
  const result = h.run(['restore', destination], '', 'RESTORE\n');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('symbolic link');
  expect(h.calls().some(args => args.includes('build') || args.includes('down'))).toBe(false);
});

// Compose no longer sets KARMAX_DATABASE_URL, so one left in the app's
// karmax.env would silently keep it on the superuser (CI-7).
it('doctor reports the role the app connects to PostgreSQL as, and warns on the superuser', () => {
  const h = deployment();
  const own = h.run(['doctor'], '', '', { FAKE_SESSIONS: 'karmax|f\n' });
  expect(own.status, own.stderr).toBe(0);
  expect(own.stdout).toContain('The app connects to PostgreSQL as karmax, not a superuser.');
  expect(own.stderr).not.toContain('superuser');
  const superuser = h.run(['doctor'], '', '', { FAKE_SESSIONS: 'temporal|t\n' });
  expect(superuser.stderr).toMatch(/warning: the app connects to PostgreSQL as the superuser temporal/);
  expect(superuser.stderr).toContain('KARMAX_DATABASE_URL');
  const idle = h.run(['doctor'], '', '', { FAKE_SESSIONS: '' });
  expect(idle.stdout).toContain('The app has no connection to the karmax database');
});

it('doctor prints each container\'s memory cap, what the caps leave the host, and PostgreSQL\'s sizing', () => {
  const h = deployment();
  const GiB = 1024 ** 3;
  const env = { FAKE_SESSIONS: 'karmax|f\n', FAKE_CONTAINERS: 'c-app\nc-pg\n',
    FAKE_STATS: '    karmax-app-1  1.1GiB / 7GiB\n    karmax-postgresql-1  356MiB / 3GiB\n',
    FAKE_PG_MEMORY: 'shared_buffers 768MB, effective_cache_size 2304MB, work_mem 7MB, maintenance_work_mem 192MB; 68 of 150 connections in use\n' };
  const small = h.run(['doctor'], '', '', { ...env, FAKE_CAPS: `${GiB / 4}\n${GiB / 4}\n` });
  expect(small.status, small.stderr).toBe(0);
  expect(small.stdout).toContain('Memory in use / cap:');
  expect(small.stdout).toContain('karmax-app-1  1.1GiB / 7GiB');
  expect(small.stdout).toMatch(/The caps add up to 512 of the host's \d+ MiB, leaving \d+ MiB for the host itself\./);
  expect(small.stdout).toContain('PostgreSQL: shared_buffers 768MB, effective_cache_size 2304MB, work_mem 7MB, maintenance_work_mem 192MB; 68 of 150 connections in use');
  expect(h.calls().some(args => args[0] === 'stats' && args.includes('--no-stream') && args.includes('c-app') && args.includes('c-pg'))).toBe(true);
  // Caps past the host's memory are a warning, not a failure; so is a
  // PostgreSQL that does not answer, and an uncapped container is not summed.
  const { FAKE_PG_MEMORY: _settings, ...postgresDown } = env;
  const over = h.run(['doctor'], '', '', { ...postgresDown, FAKE_CAPS: `${1024 * GiB}\n${GiB}\n` });
  expect(over.status, over.stderr).toBe(0);
  expect(over.stderr).toMatch(/warning: the running containers' memory caps add up to 1049600 MiB, more than the host's \d+ MiB/);
  expect(over.stderr).toContain('could not read PostgreSQL memory settings');
  const uncapped = h.run(['doctor'], '', '', { ...env, FAKE_CAPS: `0\n${GiB}\n` });
  expect(uncapped.stdout).not.toContain('The caps add up');
  const none = h.run(['doctor'], '', '', { FAKE_SESSIONS: 'karmax|f\n' });
  expect(none.status, none.stderr).toBe(0);
  expect(none.stdout).toContain('No container is running');
});

it('doctor reports the active object store and fails when an S3 store does not answer its probe', () => {
  const h = deployment();
  const local = h.run(['doctor'], '', '', { FAKE_SESSIONS: 'karmax|f\n' });
  expect(local.status, local.stderr).toBe(0);
  expect(local.stdout).toContain('object store: local');
  expect(h.calls().some(args => args.join(' ').includes('exec -T app npm run --silent object-store-check'))).toBe(true);
  const broken = h.run(['doctor'], '', '', { FAKE_SESSIONS: 'karmax|f\n',
    FAKE_OBJECT_STORE: 'object store: s3 bucket tavya-objects\nprobe failed: object store PUT failed (403)\n', FAKE_OBJECT_STORE_FAIL: '1' });
  expect(broken.status).not.toBe(0);
  expect(broken.stdout).toContain('probe failed');
  expect(broken.stderr).toContain('object store check failed');
  // The rest of the report still runs.
  expect(broken.stdout).toMatch(/Public HTTPS/);
});

it('migrates objects from a one-off app container, passing the options through', () => {
  const h = deployment();
  const result = h.run(['migrate-objects', '--verify-only', '--concurrency', '4']);
  expect(result.status, result.stderr).toBe(0);
  expect(h.calls()).toContainEqual(expect.arrayContaining(['run', '--rm', '--no-deps', '-T', 'app', 'npm', 'run', '--silent',
    'migrate-objects', '--', '--verify-only', '--concurrency', '4']));
  expect(h.calls().some(args => args.includes('exec'))).toBe(false);
  const failed = h.run(['migrate-objects'], 'migrate-objects');
  expect(failed.status).not.toBe(0);
});

/** A deployment whose source is a Git checkout at `previous`, with `target`
 *  one commit ahead on origin/master. */
function checkout() {
  const h = deployment();
  const git = (...args: string[]) => spawnSync('git', args, { cwd: h.root, encoding: 'utf8' }).stdout.trim();
  const origin = path.join(h.root, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', origin]);
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(h.root, '.gitignore'), 'deploy/.secrets/\ndeploy/.turnkey.env\ndocker.jsonl\nbin/\norigin.git/\n');
  git('add', '.'); git('commit', '-q', '-m', 'previous');
  const previous = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(h.root, 'release'), 'target\n');
  git('add', '.'); git('commit', '-q', '-m', 'target');
  const target = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'master');
  git('checkout', '-q', '--detach', previous);
  return { ...h, git, previous, target };
}

// The image copies the checkout with its modes and runs as the app user, so no
// private umask may reach the checkout, including a staged domain move's.
it('checks out a release readable by the app, even while moving domains', () => {
  const h = checkout();
  fs.appendFileSync(path.join(h.deploy, '.turnkey.env'), 'KARMAX_PENDING_DOMAIN=moved.example.com\n');
  const result = spawnSync('sh', ['-c', `umask 022; exec sh ${JSON.stringify(path.join(h.deploy, 'karmax'))} update ${h.target}`], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${path.join(h.root, 'bin')}:${process.env.PATH}`, FAKE_LOG: path.join(h.root, 'docker.jsonl'), FAKE_FAIL: '' } });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(path.join(h.deploy, '.turnkey.env'), 'utf8')).toContain('KARMAX_DOMAIN=moved.example.com');
  expect(fs.statSync(path.join(h.root, 'release')).mode & 0o044).toBe(0o044);
  expect(fs.statSync(path.join(h.deploy, '.turnkey.env')).mode & 0o077).toBe(0);
});

it('updates an exact master revision', () => {
  const h = checkout();
  const result = h.run(['update', h.target]);
  expect(result.status, result.stderr).toBe(0);
  expect(h.git('rev-parse', 'HEAD')).toBe(h.target);
  expect(result.stdout).toContain(`Update complete at ${h.target}`);
});

// A running workflow replays its recorded history under whatever code is
// loaded, so a release that cannot replay one wedges it at its next event
// (WF-34 would have wedged every task on tavya.io). The candidate replays them
// all before anything is backed up or restarted.
it('replays the running workflows under the candidate before backing up or restarting', () => {
  const h = checkout();
  const result = h.run(['update', h.target]);
  expect(result.status, result.stderr).toBe(0);
  const calls = h.calls().map(args => args.join(' '));
  const check = calls.findIndex(call => call.includes('run --rm --no-deps -T app npm run --silent replay-check'));
  expect(check).toBeGreaterThan(calls.findIndex(call => call.includes('build --pull app')));
  expect(check).toBeLessThan(calls.findIndex(call => call.includes('pg_dump')));
  expect(check).toBeLessThan(calls.findIndex(call => call.includes('up -d')));
});

it('refuses a release that cannot replay a running workflow, leaving production as it was', () => {
  const h = checkout();
  const result = h.run(['update', h.target], 'replay-check');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('stopped by the replay check');
  expect(result.stderr).toContain(`production remains at ${h.previous}`);
  expect(h.git('rev-parse', 'HEAD')).toBe(h.previous);
  const calls = h.calls().map(args => args.join(' '));
  const check = calls.findIndex(call => call.includes('replay-check'));
  expect(calls.some(call => call.includes('pg_dump') || call.includes('up -d'))).toBe(false);
  // The Compose tags (app and PostgreSQL) point at the running code again for the next restart.
  expect(calls.slice(check + 1).some(call => call.endsWith(' build app postgresql'))).toBe(true);
});

// The two gates in the real updater: replay check before the backup, vault
// preflight after it and before anything restarts.
it('runs build, replay check, backup, vault preflight and restart in that order', () => {
  const h = checkout();
  const result = h.run(['update', h.target]);
  expect(result.status, result.stderr).toBe(0);
  const calls = h.calls().map(args => args.join(' '));
  const at = (text: string) => calls.findIndex(call => call.includes(text));
  const order = ['build --pull app', 'npm run --silent replay-check', 'pg_dump', 'npm run --silent vault-preflight', 'up -d'].map(at);
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

it('keeps production when the vault preflight finds something, after the backup', () => {
  const h = checkout();
  const result = h.run(['update', h.target], 'vault-preflight');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`production remains at ${h.previous}`);
  expect(h.git('rev-parse', 'HEAD')).toBe(h.previous);
  const calls = h.calls().map(args => args.join(' '));
  expect(calls.some(call => call.includes('pg_dump'))).toBe(true);
  expect(calls.some(call => call.includes('up -d'))).toBe(false);
});

it('lets an operator skip the replay check explicitly, and says so', () => {
  const h = checkout();
  const result = h.run(['update', h.target], 'replay-check', '', { KARMAX_SKIP_REPLAY_CHECK: '1' });
  expect(result.status, result.stderr).toBe(0);
  expect(h.calls().some(args => args.join(' ').includes('replay-check'))).toBe(false);
  expect(result.stderr).toContain('replay check skipped');
});

// HEAD is the running revision: a failure before the new release starts must
// leave the checkout at the one still serving.
it('returns the checkout to the running revision when the target secrets cannot be written', () => {
  const h = checkout();
  // The first secret, so a later one cannot mask the failure.
  fs.rmSync(path.join(h.deploy, '.secrets', 'auth_secret'));
  fs.symlinkSync(path.join(h.root, 'missing', 'auth_secret'), path.join(h.deploy, '.secrets', 'auth_secret'));
  const result = h.run(['update', h.target]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`production remains at ${h.previous}`);
  expect(h.git('rev-parse', 'HEAD')).toBe(h.previous);
  expect(h.calls().some(args => args.includes('build') || args.includes('up'))).toBe(false);
});

// SS-2: backups leave the vault key out; restore keeps this instance's key, or
// installs the one the operator kept off-host, and keeps retired keys.
it('restores a backup without its vault key using the live key, or the one supplied', () => {
  const h = deployment();
  const destination = path.join(h.root, 'snapshot');
  expect(h.run(['backup', destination]).status).toBe(0);
  expect(fs.existsSync(path.join(destination, 'deployment-secrets', 'vault_key'))).toBe(false);
  fs.writeFileSync(path.join(h.deploy, '.secrets', 'vault_key.retired-20261001T000000Z'), 'retired-key');
  h.clear();
  expect(h.run(['restore', destination], '', 'RESTORE\n').status).toBe(0);
  expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key'), 'utf8')).toBe('original-vault_key');
  expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key.retired-20261001T000000Z'), 'utf8')).toBe('retired-key');
  const kept = path.join(h.root, 'kept-vault_key');
  fs.writeFileSync(kept, 'off-host-vault_key');
  h.clear();
  const supplied = h.run(['restore', '--vault-key', kept, destination], '', 'RESTORE\n');
  expect(supplied.status, supplied.stderr).toBe(0);
  expect(fs.readFileSync(path.join(h.deploy, '.secrets', 'vault_key'), 'utf8')).toBe('off-host-vault_key');
  // The supplied key is what the verification checked, before anything stopped.
  const calls = h.calls().map(args => args.join(' '));
  expect(calls.findIndex(call => call.includes('--check-vault-key'))).toBeLessThan(calls.findIndex(call => call.endsWith(' down')));
});

// Off-host PostgreSQL backups (deploy/postgres/pg-backup.sh, wiki ops/production-tavya).
const PUBLIC_KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture\n-----END PGP PUBLIC KEY BLOCK-----\n';
const PRIVATE_KEY = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nfixture\n-----END PGP PRIVATE KEY BLOCK-----\n';
const BUCKET_KEY = { KARMAX_PG_BACKUP_ACCESS_KEY_ID: 'backup-id', KARMAX_PG_BACKUP_SECRET_ACCESS_KEY: 'backup-secret' };

it('doctor says backups are off until configured, then fails while they are not current', () => {
  const h = deployment();
  const off = h.run(['doctor'], '', '', { FAKE_SESSIONS: 'karmax|f\n' });
  expect(off.status, off.stderr).toBe(0);
  expect(off.stdout).toContain('Off-host PostgreSQL backups are off');
  expect(h.calls().some(args => args.includes('pg-backup'))).toBe(false);
  fs.appendFileSync(path.join(h.deploy, '.turnkey.env'), 'KARMAX_PG_BACKUP_PREFIX=s3://tavya-db-backups/tavya.io\n');
  const current = h.run(['doctor'], '', '', { FAKE_SESSIONS: 'karmax|f\n' });
  expect(current.status, current.stderr).toBe(0);
  expect(h.calls().some(args => args.join(' ').includes('exec -T pg-backup karmax-pg-backup status'))).toBe(true);
  const stale = h.run(['doctor'], 'karmax-pg-backup status', '', { FAKE_SESSIONS: 'karmax|f\n' });
  expect(stale.status).not.toBe(0);
  expect(stale.stderr).toContain('off-host PostgreSQL backups are not current');
});

it('configure-backups writes the bucket key and public key, never a private key, and restarts PostgreSQL', () => {
  const h = deployment();
  const key = path.join(h.root, 'backup.asc');
  fs.writeFileSync(key, PRIVATE_KEY);
  const args = ['configure-backups', 's3://tavya-db-backups/tavya.io', 'https://acct.eu.r2.cloudflarestorage.com', key];
  const leaked = h.run(args, '', '', BUCKET_KEY);
  expect(leaked.status).not.toBe(0);
  expect(leaked.stderr).toMatch(/not an armored OpenPGP public key|holds a private key/);
  fs.writeFileSync(key, PUBLIC_KEY);
  expect(h.run(args, '', '', {}).stderr).toContain('KARMAX_PG_BACKUP_ACCESS_KEY_ID');
  expect(h.run(['configure-backups', 's3://Bad Bucket', 'https://x', key], '', '', BUCKET_KEY).stderr).toContain('prefix');
  expect(h.calls().some(args => args.includes('up'))).toBe(false);

  const ok = h.run(args, '', '', BUCKET_KEY);
  expect(ok.status, ok.stderr).toBe(0);
  const secret = (name: string) => fs.readFileSync(path.join(h.deploy, '.secrets', name), 'utf8');
  expect(secret('pg_backup_access_key_id')).toBe('backup-id\n');
  expect(secret('pg_backup_secret_access_key')).toBe('backup-secret\n');
  expect(secret('pg_backup_public_key')).toBe(PUBLIC_KEY);
  const env = fs.readFileSync(path.join(h.deploy, '.turnkey.env'), 'utf8');
  expect(env).toContain('KARMAX_PG_BACKUP_PREFIX=s3://tavya-db-backups/tavya.io\n');
  expect(env).toContain('KARMAX_PG_BACKUP_ENDPOINT=https://acct.eu.r2.cloudflarestorage.com\n');
  expect(env).toContain('KEEP_SETTING=retained');
  expect(h.calls().some(args => args.join(' ').endsWith('up -d --remove-orphans'))).toBe(true);
  // Never on a command line, where any user on the host could read it.
  expect(h.calls().flat().join(' ')).not.toContain('backup-secret');
  // Reconfiguring replaces the settings instead of repeating them.
  h.run(['configure-backups', 's3://tavya-db-backups/other', 'https://acct.eu.r2.cloudflarestorage.com', key], '', '', BUCKET_KEY);
  const again = fs.readFileSync(path.join(h.deploy, '.turnkey.env'), 'utf8');
  expect(again.match(/KARMAX_PG_BACKUP_PREFIX=/g)).toHaveLength(1);
  expect(again).toContain('KARMAX_PG_BACKUP_PREFIX=s3://tavya-db-backups/other\n');
});

it('pg-restore restores into a scratch volume with the off-host private key, and removes both afterwards', () => {
  const h = deployment();
  const key = path.join(h.root, 'backup.asc');
  fs.writeFileSync(key, PUBLIC_KEY);
  expect(h.run(['pg-restore', '--private-key', key]).stderr).toContain('not configured');
  fs.appendFileSync(path.join(h.deploy, '.turnkey.env'), 'KARMAX_PG_BACKUP_PREFIX=s3://tavya-db-backups/tavya.io\n');
  expect(h.run(['pg-restore', '--private-key', key]).stderr).toContain('not an armored OpenPGP private key');
  fs.writeFileSync(key, PRIVATE_KEY);
  const ok = h.run(['pg-restore', '--private-key', key, '--to', '2026-10-08 12:00:00+00']);
  expect(ok.status, ok.stderr).toBe(0);
  const calls = h.calls().map(args => args.join(' '));
  const volume = calls.find(call => call.startsWith('volume create '))!.split(' ').at(-1)!;
  expect(volume).toMatch(/^karmax-pitr-\d{8}T\d{6}Z$/);
  const restore = calls.find(call => call.includes('karmax-pg-backup restore'))!;
  expect(restore).toContain(`run --rm --no-deps -T --user root -v ${volume}:/restore`);
  expect(restore).toContain('TARGET=2026-10-08 12:00:00+00');
  expect(restore).toContain('KARMAX_PG_BACKUP_PRIVATE_KEY=/run/pitr/private.asc');
  expect(calls.at(-1)).toBe(`volume rm -f ${volume}`);
  // The staged copy of the private key is gone.
  const staged = restore.match(/-v (\S+):\/run\/pitr\/private\.asc:ro/)![1]!;
  expect(fs.existsSync(staged)).toBe(false);
  const kept = h.run(['pg-restore', '--private-key', key, '--keep']);
  expect(kept.stdout).toMatch(/Kept the restored data directory in volume karmax-pitr-/);
});
