import fs from 'node:fs';
import path from 'node:path';
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

  it('serialises deploys using only GitHub-supported concurrency keys', () => {
    expect(deploy.concurrency.group).toBe('deploy-production');
    expect(deploy.concurrency['cancel-in-progress']).toBe(false);
    expect(deploy.concurrency.queue).toBeUndefined();
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
