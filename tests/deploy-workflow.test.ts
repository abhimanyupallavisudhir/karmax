import fs from 'node:fs';
import path from 'node:path';
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
    expect(JSON.stringify(ci.jobs['deploy-artifacts'].steps)).toContain('docker run --rm karmax:ci');
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
