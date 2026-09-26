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
const deploy = workflow.jobs.deploy;
const script: string = JSON.stringify(deploy.steps);
const operator = fs.readFileSync(path.join(repoRoot, 'deploy', 'karmax'), 'utf8');

describe('post-push deployment to the public instance', () => {
  it('schema-validates every workflow with a version-and-checksum-pinned actionlint', () => {
    expect(ciSource).toContain("ACTIONLINT_VERSION: '1.7.12'");
    expect(ciSource).toContain('ACTIONLINT_LINUX_AMD64_SHA256');
    expect(ciSource).toContain('Validate every repository workflow');
    expect(ciSource).toContain('unexpected key "queue"');
  });

  it('exists, so a landed commit reaches the VPS without anyone SSHing in by hand', () => {
    expect(deploy).toBeDefined();
    expect(script).toContain('deploy/.karmax-update update');
  });

  it('is separate from PR CI and starts only after the master CI workflow succeeds', () => {
    expect(ci.jobs.deploy).toBeUndefined();
    expect(workflow.on.workflow_run.workflows).toContain('CI');
    expect(workflow.on.workflow_run.branches).toContain('master');
    expect(deploy.if).toContain("workflow_run.conclusion == 'success'");
  });

  it('passes the exact SHA validated by CI instead of pulling an arbitrary newer master', () => {
    expect(JSON.stringify(deploy.env)).toContain('github.event.workflow_run.head_sha');
    expect(script).toContain("git show '$DEPLOY_SHA:deploy/karmax'");
    expect(script).toContain("./deploy/.karmax-update update '$DEPLOY_SHA'");
    expect(operator.split('cmd_update() {')[1]?.split('\n}')[0]).not.toContain('pull --ff-only');
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
  it('prunes old pre-deploy backups', () => {
    expect(script).toContain('deploy/backups');
    expect(script).toMatch(/-mtime \+\d+/);
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
    git('add', '.'); git('commit', '-qm', 'trusted');
    const trusted = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/master', trusted);
    git('checkout', '-qb', 'task');
    fs.writeFileSync(path.join(root, 'deploy/karmax'), '#!/bin/sh\necho unreviewed > executed\n');
    git('add', '.'); git('commit', '-qm', 'unreviewed');
    const unreviewed = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'master');
    const run = deploy.steps.find((step: any) => step.run?.includes('ssh -o')).run as string;
    const result = spawnSync('bash', ['-c', `
git() { if [ "$1" = fetch ]; then return 0; fi; command git "$@"; }
ssh() { bash -c "\${@: -1}"; }
export -f git
` + run.replace('cd /opt/karmax', `cd '${root}'`).replaceAll('~/.ssh', `'${root}/ssh'`)], { cwd: root, encoding: 'utf8', env: {
      ...process.env, DEPLOY_SHA: candidate === 'trusted' ? trusted : unreviewed,
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
