import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import {
  DEPLOYMENT_RUN_GRACE_MS,
  GitHubDeploymentMonitor,
  observeDeploymentWorkflowRun,
} from '../src/integrations/github-deployment-monitor.js';

function repositoryFixture(store: Store) {
  const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = store.createProject('App', {}, organization.id);
  const repository = store.upsertRepository({
    organizationId: organization.id,
    provider: 'github',
    providerId: '99',
    owner: 'acme',
    name: 'app',
    sshUrl: 'git@github.com:acme/app.git',
    defaultBranch: 'master',
    private: true,
  });
  store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
  return { project, repository };
}

const successfulCi = (sha = 'a'.repeat(40)) => ({
  id: 700,
  name: 'CI',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'master',
  head_sha: sha,
  html_url: 'https://github.com/acme/app/actions/runs/700',
  updated_at: '2026-08-13T12:00:00Z',
});

function githubWithRuns(runs: any[] = []) {
  const listRuns = vi.fn(async () => ({ total: runs.length, page: 1, perPage: 100, runs }));
  return {
    github: {
      repositoryFileStatus: vi.fn(async () => ({ status: 'present' as const, bytes: 1200 })),
      actions: vi.fn(() => ({ listRuns } as any)),
    },
    listRuns,
  };
}

describe('missing GitHub deployment runs', () => {
  it('reports no Deploy run after successful master CI and the bounded grace period', async () => {
    const store = new Store(':memory:');
    const { project, repository } = repositoryFixture(store);
    const observedAt = 1_000_000;
    observeDeploymentWorkflowRun(store, repository, successfulCi(), { now: observedAt });
    const { github } = githubWithRuns();

    const findings = await new GitHubDeploymentMonitor(store, github as any)
      .reconcile(observedAt + DEPLOYMENT_RUN_GRACE_MS);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.events).toEqual([expect.objectContaining({
      projectId: project.id,
      type: 'github.workflow.failed',
      payload: expect.objectContaining({
        source: 'deployment_monitor',
        conclusion: 'missing',
        workflow: 'Deploy',
        headSha: 'a'.repeat(40),
        incidentKey: expect.stringContaining('missing:'),
        evidence: expect.objectContaining({
          workflowFile: { status: 'present', bytes: 1200 },
          actionsQuery: expect.objectContaining({ status: 'ok', runsChecked: 0 }),
        }),
      }),
    })]);
    store.close();
  });

  it('accepts a delayed Deploy run found by polling even when its webhook did not arrive', async () => {
    const store = new Store(':memory:');
    const { repository } = repositoryFixture(store);
    const observedAt = 2_000_000;
    const ci = successfulCi();
    observeDeploymentWorkflowRun(store, repository, ci, { now: observedAt });
    const { github, listRuns } = githubWithRuns([{
      id: 701,
      name: 'Deploy',
      status: 'waiting',
      headSha: ci.head_sha,
      url: 'https://github.com/acme/app/actions/runs/701',
      createdAt: '2026-08-13T12:00:30Z',
    }]);

    expect(await new GitHubDeploymentMonitor(store, github as any)
      .reconcile(observedAt + DEPLOYMENT_RUN_GRACE_MS + 1)).toEqual([]);
    expect(listRuns).toHaveBeenCalledOnce();
    expect(store.kvEntries('github:deployment-expectation:')).toEqual([]);
    store.close();
  });

  it('does not extend the deadline or duplicate state across repeated observations', () => {
    const store = new Store(':memory:');
    const { repository } = repositoryFixture(store);
    const ci = successfulCi();
    observeDeploymentWorkflowRun(store, repository, ci, { now: 3_000_000 });
    observeDeploymentWorkflowRun(store, repository, ci, { now: 4_000_000 });

    const entries = store.kvEntries('github:deployment-expectation:');
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.value)).toMatchObject({
      observedAt: 3_000_000,
      deadlineAt: 3_000_000 + DEPLOYMENT_RUN_GRACE_MS,
    });
    store.close();
  });

  it('reports a deployment workflow file that disappears after the repository was monitored', async () => {
    const store = new Store(':memory:');
    const { repository } = repositoryFixture(store);
    observeDeploymentWorkflowRun(store, repository, {
      id: 699, name: 'Deploy', status: 'completed', conclusion: 'success',
      head_branch: 'master', head_sha: 'b'.repeat(40),
    });
    observeDeploymentWorkflowRun(store, repository, successfulCi(), { now: 4_500_000 });
    const { github } = githubWithRuns();
    github.repositoryFileStatus.mockResolvedValue({ status: 'missing' } as any);

    const findings = await new GitHubDeploymentMonitor(store, github as any)
      .reconcile(4_500_000 + DEPLOYMENT_RUN_GRACE_MS);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.events[0]!.payload.evidence).toMatchObject({
      workflowFile: { status: 'missing' },
      interpretation: expect.stringContaining('previously exposed'),
    });
    store.close();
  });

  it('recovers persisted expectations after restart and stays idempotent after reporting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deployment-monitor-'));
    const database = path.join(dir, 'state.db');
    const first = new Store(database);
    const { repository } = repositoryFixture(first);
    observeDeploymentWorkflowRun(first, repository, successfulCi(), { now: 5_000_000 });
    first.close();

    const restarted = new Store(database);
    const { github } = githubWithRuns();
    const monitor = new GitHubDeploymentMonitor(restarted, github as any);
    const findings = await monitor.reconcile(5_000_000 + DEPLOYMENT_RUN_GRACE_MS);
    expect(findings).toHaveLength(1);
    monitor.markReported(findings[0]!);
    restarted.close();

    const again = new Store(database);
    expect(await new GitHubDeploymentMonitor(again, github as any)
      .reconcile(6_000_000)).toEqual([]);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
