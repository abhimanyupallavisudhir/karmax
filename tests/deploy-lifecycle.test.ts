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
if (args.join(' ').includes('pg_stat_activity')) process.stdout.write(process.env.FAKE_SESSIONS ?? '');
if (args.includes('pg_restore')) {
  const input = fs.readFileSync(0);
  if (!args.includes('/dev/null') && process.env.FAKE_RESTORED) fs.appendFileSync(process.env.FAKE_RESTORED, args.at(-1) + '=' + input + '\\n');
} else if (args.includes('run') && !args.includes('-T')) fs.readFileSync(0); // like Compose, a one-off without -T reads stdin
// Change the backup the operator pointed at once it has been verified.
if (args.join(' ').includes('--verify-deployment') && process.env.FAKE_TAMPER) fs.writeFileSync(process.env.FAKE_TAMPER, 'tampered');
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const run = (args: string[], fail = '', input = '', env: Record<string, string> = {}) => spawnSync('sh', [path.join(deploy, 'karmax'), ...args], {
    encoding: 'utf8', input, timeout: 30_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_FAIL: fail, ...env },
  });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [];
  return { root, deploy, run, calls, clear: () => fs.writeFileSync(log, '') };
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
  // The Compose tag points at the running code again for the next restart.
  expect(calls.slice(check + 1).some(call => call.endsWith(' build app'))).toBe(true);
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
