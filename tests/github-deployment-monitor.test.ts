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

async function repositoryFixture(store: Store) {
  const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
  const project = (await store.createProject('App', {}, organization.id));
  const repository = (await store.upsertRepository({
    organizationId: organization.id,
    provider: 'github',
    providerId: '99',
    owner: 'acme',
    name: 'app',
    sshUrl: 'git@github.com:acme/app.git',
    defaultBranch: 'master',
    private: true,
  }));
  (await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id }));
  await store.setSettings(`organization:${organization.id}`, 'github-deployment-monitor', {
    repositories: { [repository.id]: { sourceWorkflow: 'CI', workflow: 'Deploy', file: '.github/workflows/deploy.yml' } },
  });
  return { project, repository };
}

const successfulCi = (sha = 'a'.repeat(40)) => ({
  event: 'push', head_repository: { id: 99 }, id: 700,
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
  it('requires explicit repository monitoring and defers API outages', async () => {
    const store = await Store.create(':memory:');
    try {
      const { repository } = await repositoryFixture(store);
      const scope = `organization:${repository.organizationId}`;
      const configured = await store.getSettings(scope, 'github-deployment-monitor');
      await store.setSettings(scope, 'github-deployment-monitor', {});
      await observeDeploymentWorkflowRun(store, repository, successfulCi(), { now: 1000 });
      expect(await store.kvEntries('github:deployment-expectation:')).toEqual([]);
      await store.setSettings(scope, 'github-deployment-monitor', configured!);
      await observeDeploymentWorkflowRun(store, repository, successfulCi(), { now: 1000 });
      const { github, listRuns } = githubWithRuns();
      listRuns.mockRejectedValue(new Error('GitHub unavailable'));
      const monitor = new GitHubDeploymentMonitor(store, github);
      expect(await monitor.reconcile(1000 + DEPLOYMENT_RUN_GRACE_MS)).toEqual([]);
      expect(await store.kvEntries('github:deployment-expectation:')).toHaveLength(1);
      listRuns.mockResolvedValue({ total: 0, page: 1, perPage: 100, runs: [] });
      github.repositoryFileStatus.mockResolvedValue({ status: 'unreadable', error: 'GitHub unavailable' } as any);
      expect(await monitor.reconcile(1000 + DEPLOYMENT_RUN_GRACE_MS)).toEqual([]);
    } finally { await store.close(); }
  });

  it('reports no Deploy run after successful master CI and the bounded grace period', async () => {
    const store = (await Store.create(':memory:'));
    const { project, repository } = (await repositoryFixture(store));
    const observedAt = 1_000_000;
    (await observeDeploymentWorkflowRun(store, repository, successfulCi(), { now: observedAt }));
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
    (await store.close());
  });

  it('accepts a delayed Deploy run found by polling even when its webhook did not arrive', async () => {
    const store = (await Store.create(':memory:'));
    const { repository } = (await repositoryFixture(store));
    const observedAt = 2_000_000;
    const ci = successfulCi();
    (await observeDeploymentWorkflowRun(store, repository, ci, { now: observedAt }));
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
    expect((await store.kvEntries('github:deployment-expectation:'))).toEqual([]);
    (await store.close());
  });

  it('does not extend the deadline or duplicate state across repeated observations', async () => {
    const store = (await Store.create(':memory:'));
    const { repository } = (await repositoryFixture(store));
    const ci = successfulCi();
    (await observeDeploymentWorkflowRun(store, repository, ci, { now: 3_000_000 }));
    (await observeDeploymentWorkflowRun(store, repository, ci, { now: 4_000_000 }));

    const entries = (await store.kvEntries('github:deployment-expectation:'));
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.value)).toMatchObject({
      observedAt: 3_000_000,
      deadlineAt: 3_000_000 + DEPLOYMENT_RUN_GRACE_MS,
    });
    (await store.close());
  });

  it('reports a deployment workflow file that disappears after the repository was monitored', async () => {
    const store = (await Store.create(':memory:'));
    const { repository } = (await repositoryFixture(store));
    (await observeDeploymentWorkflowRun(store, repository, {
      event: 'workflow_run', head_repository: { id: 99 }, id: 699, name: 'Deploy', status: 'completed', conclusion: 'success',
      head_branch: 'master', head_sha: 'b'.repeat(40),
    }));
    (await observeDeploymentWorkflowRun(store, repository, successfulCi(), { now: 4_500_000 }));
    const { github } = githubWithRuns();
    github.repositoryFileStatus.mockResolvedValue({ status: 'missing' } as any);

    const findings = await new GitHubDeploymentMonitor(store, github as any)
      .reconcile(4_500_000 + DEPLOYMENT_RUN_GRACE_MS);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.events[0]!.payload.evidence).toMatchObject({
      workflowFile: { status: 'missing' },
      interpretation: expect.stringContaining('previously exposed'),
    });
    (await store.close());
  });

  it('recovers persisted expectations after restart and stays idempotent after reporting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deployment-monitor-'));
    const database = path.join(dir, 'state.db');
    const first = (await Store.create(database));
    const { repository } = (await repositoryFixture(first));
    (await observeDeploymentWorkflowRun(first, repository, successfulCi(), { now: 5_000_000 }));
    (await first.close());

    const restarted = (await Store.create(database));
    const { github } = githubWithRuns();
    const monitor = new GitHubDeploymentMonitor(restarted, github as any);
    const findings = await monitor.reconcile(5_000_000 + DEPLOYMENT_RUN_GRACE_MS);
    expect(findings).toHaveLength(1);
    (await monitor.markReported(findings[0]!));
    (await restarted.close());

    const again = (await Store.create(database));
    expect(await new GitHubDeploymentMonitor(again, github as any)
      .reconcile(6_000_000)).toEqual([]);
    (await again.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
