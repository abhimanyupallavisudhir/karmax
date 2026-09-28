import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));
const ciSource = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const workflow = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'deploy.yml'), 'utf8'));
const backupWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'backup.yml');
const deploy = workflow.jobs.deploy;
const script: string = JSON.stringify(deploy.steps);
const operator = fs.readFileSync(path.join(repoRoot, 'deploy', 'karmax'), 'utf8');

describe('post-push deployment to the public instance', () => {
  it('gives validation jobs read-only GitHub authority and does not persist checkout credentials', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(ci.jobs) as Array<{ steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });

  it('does not execute arbitrary dependency install scripts in CI', () => {
    for (const name of ['checks', 'test']) {
      const steps = JSON.stringify(ci.jobs[name].steps);
      expect(steps).toContain('npm ci --ignore-scripts');
      expect(steps).toContain('npm rebuild @swc/core esbuild node-pty protobufjs');
    }
  });
  it('schema-validates every workflow with a version-and-checksum-pinned actionlint', () => {
    expect(ciSource).toContain("ACTIONLINT_VERSION: '1.7.12'");
    expect(ciSource).toContain('ACTIONLINT_LINUX_AMD64_SHA256');
    expect(ciSource).toContain('Validate every repository workflow');
    expect(ciSource).toContain('unexpected key "queue"');
  });

  it('pins downloaded workflow tools to immutable hashes', () => {
    for (const job of Object.values(ci.jobs) as Array<{ steps?: Array<{ uses?: string }> }>) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/')) expect(step.uses).toMatch(/^actions\/[^@]+@[0-9a-f]{40}$/);
      }
    }
    expect(ciSource).toContain('TEMPORAL_CLI_LINUX_AMD64_SHA256');
    expect(ciSource).toContain('sha256sum -c -');
  });

  it('exists, so a landed commit reaches the VPS without anyone SSHing in by hand', () => {
    expect(deploy).toBeDefined();
    expect(script).toContain("./deploy/.karmax-runner start '$DEPLOY_SHA'");
  });

  it('is separate from PR CI and starts only after the master CI workflow succeeds', () => {
    expect(ci.jobs.deploy).toBeUndefined();
    expect(workflow.on.workflow_run.workflows).toContain('CI');
    expect(workflow.on.workflow_run.branches).toContain('master');
    expect(deploy.if).toContain("workflow_run.conclusion == 'success'");
  });

  it('requires deployment artifacts to build before the required CI check succeeds', () => {
    expect(ci.jobs.required.needs).toContain('deploy-artifacts');
    expect(JSON.stringify(ci.jobs['deploy-artifacts'].steps)).toContain('docker run --rm karmax-app');
  });

  it('runs the actual Docker integration suites on CI test shards', () => {
    expect(ci.jobs.test.env?.KARMAX_SKIP_DOCKER).toBeUndefined();
  });

  it('passes the exact SHA validated by CI instead of pulling an arbitrary newer master', () => {
    expect(JSON.stringify(deploy.env)).toContain('github.event.workflow_run.head_sha');
    expect(script).toContain("git show '$DEPLOY_SHA:deploy/karmax'");
    expect(script).toContain("./deploy/.karmax-runner start '$DEPLOY_SHA'");
    expect(operator.split('cmd_update() {')[1]?.split('\n}')[0]).not.toContain('pull --ff-only');
  });

  it('polls a detached host update so losing the runner connection cannot interrupt deployment', () => {
    expect(script).toContain('deploy/.updates/');
    expect(script).toContain('status');
    expect(script).toContain('sleep 10');
    expect(script).toContain('after $attempt polls');
  });

  it('accepts only a successful push from this repository and checks ancestry before executing candidate code', () => {
    expect(deploy.if).toContain("workflow_run.event == 'push'");
    expect(deploy.if).toContain('workflow_run.head_repository.full_name == github.repository');
    expect(script.indexOf('merge-base --is-ancestor')).toBeLessThan(script.indexOf("git show '$DEPLOY_SHA:deploy/karmax'"));
  });

  it('serialises deploys using only GitHub-supported concurrency fields', () => {
    expect(deploy.concurrency.group).toBe('deploy-production');
    expect(deploy.concurrency['cancel-in-progress']).toBe(false);
    // An unknown key invalidates the whole workflow before any run is created.
    // GitHub's concurrency schema supports exactly these two fields.
    expect(Object.keys(deploy.concurrency).sort()).toEqual(['cancel-in-progress', 'group']);
  });

  // Trust-on-first-use here would let anyone who can answer on port 22 collect
  // the deploy key, so the host key is pinned as a secret instead.
  it('pins the VPS host key rather than accepting an unknown one', () => {
    expect(script).toContain('StrictHostKeyChecking=yes');
    expect(script).toContain('secrets.VPS_KNOWN_HOSTS');
    expect(script).not.toContain('ssh-keyscan');
    expect(script).not.toContain('StrictHostKeyChecking=no');
    expect(script).not.toContain('accept-new');
  });

  // Every push snapshots the vault and Temporal history before rebuilding.
  // Unpruned, that grows without bound until the disk fills and the instance
  // stops taking writes.
  it('retains manual backups while pruning only automatic snapshots', () => {
    expect(script).toContain("-name 'predeploy-*'");
    const backup = parse(fs.readFileSync(backupWorkflowPath, 'utf8'));
    expect(backup.on.schedule).toBeDefined();
    const steps = JSON.stringify(backup.jobs.backup.steps);
    expect(steps).toContain('scheduled-');
    expect(steps).toMatch(/-name.*scheduled-\*/);
  });

  // `cmd_backup` runs inside the live app container. The backup API rejects a
  // live instance unless that choice is explicit; omitting the flag made every
  // post-push deploy fail before `git pull`, permanently stranding production.
  it('explicitly permits the pre-deploy online snapshot', () => {
    expect(operator).toContain('npm run backup -- --allow-running "$temporary"');
  });

  it('rolls back the source and service when readiness fails', () => {
    const update = operator.split('cmd_update() {')[1]?.split('\n}')[0] ?? '';
    expect(update).toContain('rolling back');
    expect(update).toContain('checkout --detach "$previous"');
    expect(update).toContain('wait_ready');
  });

  it('builds first and snapshots with the validated candidate instead of the old live image', () => {
    const update = operator.split('cmd_update() {')[1]?.split('\n}')[0] ?? '';
    expect(update.indexOf('dc build --pull app')).toBeLessThan(update.indexOf('cmd_backup_candidate'));
    expect(operator).toContain('dc run --rm --no-deps app npm run backup');
  });
});

it.each(['trusted', 'unreviewed'])('checks ancestry before executing a %s deployment updater', (candidate) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-provenance-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'master');
    git('config', 'user.name', 'Deployment Test');
    git('config', 'user.email', 'deploy@example.test');
    fs.mkdirSync(path.join(root, 'deploy'));
    fs.writeFileSync(path.join(root, 'deploy/karmax'), '#!/bin/sh\necho trusted > executed\n');
    // The real detached runner, as the deploy step loads it from the candidate.
    fs.copyFileSync(path.join(import.meta.dirname, '../deploy/update-runner.sh'), path.join(root, 'deploy/update-runner.sh'));
    git('add', '.'); git('commit', '-qm', 'trusted');
    const trusted = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/master', trusted);
    git('checkout', '-qb', 'task');
    fs.writeFileSync(path.join(root, 'deploy/karmax'), '#!/bin/sh\necho unreviewed > executed\n');
    git('add', '.'); git('commit', '-qm', 'unreviewed');
    const unreviewed = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'master');
    const run = deploy.steps.find((step: any) => step.run?.includes('ssh -o')).run as string;
    // GitHub runs `run:` steps with bash -e -o pipefail; the host is `root`.
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `
git() { if [ "$1" = fetch ]; then return 0; fi; command git "$@"; }
ssh() { bash -c "\${@: -1}"; }
export -f git
` + run.replaceAll('/opt/karmax', root).replaceAll('~/.ssh', `'${root}/ssh'`).replaceAll('sleep 10', 'sleep 0.2')], { cwd: root, encoding: 'utf8', env: {
      ...process.env, DEPLOY_SHA: candidate === 'trusted' ? trusted : unreviewed, RUN_KEY: '1-1',
      SSH_KEY: 'fake-key', KNOWN_HOSTS: 'fake-host', TARGET: 'fake-target',
    } });
    if (candidate === 'trusted') {
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(path.join(root, 'executed'), 'utf8')).toBe('trusted\n');
    } else {
      expect(result.status, result.stderr).not.toBe(0);
      expect(fs.existsSync(path.join(root, 'executed'))).toBe(false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// CI-3: the detached runner executes a copy of the updater from
// deploy/.updates/<key>/, which must still find the instance it updates. This
// runs the real deploy step, runner and updater against a configured checkout;
// only Docker (and the SSH hop) are fakes.
it('updates a configured instance through the detached copy of the updater', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-e2e-'));
  const origin = path.join(root, 'origin.git');
  const host = path.join(root, 'opt-karmax');
  const bin = path.join(root, 'bin');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    fs.mkdirSync(bin);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
    execFileSync('git', ['clone', '-q', origin, host]);
    git(host, 'config', 'user.name', 'Deployment Test');
    git(host, 'config', 'user.email', 'deploy@example.test');
    fs.mkdirSync(path.join(host, 'deploy'));
    for (const file of ['karmax', 'update-runner.sh', 'compact-backups.sh', 'compose.turnkey.yml'])
      fs.copyFileSync(path.join(repoRoot, 'deploy', file), path.join(host, 'deploy', file));
    git(host, 'add', '.'); git(host, 'commit', '-qm', 'live'); git(host, 'push', '-q', 'origin', 'master');
    const live = git(host, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(host, 'feature.txt'), 'candidate\n');
    git(host, 'add', '.'); git(host, 'commit', '-qm', 'candidate'); git(host, 'push', '-q', 'origin', 'master');
    const candidate = git(host, 'rev-parse', 'HEAD');
    git(host, 'checkout', '-q', '--detach', live);
    // The instance configuration lives beside the operator, outside Git.
    fs.writeFileSync(path.join(host, 'deploy/.turnkey.env'), 'KARMAX_DOMAIN=example.com\nPOSTGRES_PASSWORD=fixture\n');
    fs.mkdirSync(path.join(host, 'deploy/.secrets'));
    for (const secret of ['auth_secret', 'vault_key', 'world_ref_key'])
      fs.writeFileSync(path.join(host, 'deploy/.secrets', secret), secret);
    const log = path.join(root, 'docker.jsonl');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.includes('cp')) {
  fs.mkdirSync(args.at(-1), { recursive: true });
  fs.writeFileSync(path.join(args.at(-1), 'manifest.json'), '{}');
}
if (args.includes('pg_dump')) process.stdout.write('dump');
`, { mode: 0o755 });
    const run = deploy.steps.find((step: any) => step.run?.includes('ssh -o')).run as string;
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `
ssh() { (cd ${JSON.stringify(root)} && bash -c "\${@: -1}"); }
` + run.replaceAll('/opt/karmax', host).replaceAll('~/.ssh', `'${root}/ssh'`).replaceAll('sleep 10', 'sleep 0.2')], {
      cwd: root, encoding: 'utf8', timeout: 60_000, env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_SHA: candidate, RUN_KEY: '7-1',
        SSH_KEY: 'fake-key', KNOWN_HOSTS: 'fake-host', TARGET: 'fake-target',
      } });
    const status = path.join(host, 'deploy/.updates/7-1');
    expect(result.status, `${result.stdout}\n${result.stderr}\n${fs.existsSync(path.join(status, 'log')) ? fs.readFileSync(path.join(status, 'log'), 'utf8') : ''}`).toBe(0);
    expect(fs.readFileSync(path.join(status, 'status'), 'utf8').trim()).toBe('success');
    expect(fs.readFileSync(path.join(status, 'log'), 'utf8')).toContain(`Update complete at ${candidate}.`);
    expect(git(host, 'rev-parse', 'HEAD')).toBe(candidate);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    // The copy drove the instance's own Compose project and environment.
    expect(calls.some(args => args.includes('up') && args.includes(path.join(host, 'deploy/.turnkey.env')))).toBe(true);
    expect(fs.readdirSync(path.join(host, 'deploy/backups')).some(name => name.startsWith('predeploy-'))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
