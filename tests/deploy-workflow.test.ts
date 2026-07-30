import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));
const deploy = workflow.jobs.deploy;
const script: string = JSON.stringify(deploy.steps);
const operator = fs.readFileSync(path.join(repoRoot, 'deploy', 'karmax'), 'utf8');

describe('post-push deployment to the public instance', () => {
  it('exists, so a landed commit reaches the VPS without anyone SSHing in by hand', () => {
    expect(deploy).toBeDefined();
    expect(script).toContain('deploy/karmax update');
  });

  // The instance this deploys to is public. Shipping a commit that does not
  // even typecheck would take it down for everyone, and `deploy/karmax update`
  // restarts the stack in place — there is no staging tier to catch it.
  it('runs only after the suite and the deploy artifacts have both passed', () => {
    expect(deploy.needs).toEqual(expect.arrayContaining(['test', 'deploy-artifacts']));
  });

  it('never deploys anything but master', () => {
    expect(deploy.if).toContain("github.ref == 'refs/heads/master'");
  });

  // `update` snapshots, pulls, rebuilds and restarts one working tree. A second
  // run entering that while the first is mid-rebuild corrupts both, so the
  // queue must hold rather than cancel — cancelling would also silently skip
  // deploying whichever commit lost the race.
  it('serialises deploys instead of cancelling the one in flight', () => {
    expect(deploy.concurrency.group).toBe('deploy-production');
    expect(deploy.concurrency['cancel-in-progress']).toBe(false);
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
});
