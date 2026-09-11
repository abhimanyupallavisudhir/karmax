import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi, CapabilityError, NotFoundError } from '../src/platform/api.js';

describe('task-scoped GitHub Actions authority', () => {
  it('allows bounded reads only for attached repositories, audits them, and separates mutations', async () => {
    const store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Application', {}, organization.id);
    const other = store.createProject('Other', {}, organization.id);
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '9', accountLogin: 'acme', accountType: 'Organization' });
    const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: '11',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true,
      gitConnectionId: connection.id });
    const outside = store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: '12',
      owner: 'acme', name: 'outside', sshUrl: 'git@github.com:acme/outside.git', defaultBranch: 'main', private: true,
      gitConnectionId: connection.id });
    store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    store.attachProjectRepository({ projectId: other.id, repositoryId: outside.id });
    const task = store.createTask({ projectId: project.id, title: 'Repair deploy', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'diagnose it' } });
    const actions = {
      listWorkflows: vi.fn(async () => ({ page: 1, workflows: [] })),
      listRuns: vi.fn(async () => ({ total: 1, page: 1, perPage: 30, runs: [{ id: 42 }] })),
      inspectRun: vi.fn(async () => ({ run: { id: 42 }, jobs: [], failedJobs: [], artifacts: [], notices: [] })),
      rerun: vi.fn(async () => ({ accepted: true, action: 'rerun-failed' })),
      cancel: vi.fn(async () => ({ accepted: true, action: 'cancel' })),
      dispatch: vi.fn(async () => ({ accepted: true, workflow: 'deploy.yml', ref: 'main' })),
    };
    const githubApp = { actions: vi.fn(() => actions) } as any;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens, githubApp });
    const read = tokens.mint({ taskId: task.id, profileId: 'do', principal: 'user:owner', projectId: project.id,
      ceiling: ['github:actions:read'], grantorCaps: ['github:actions:read'] }).token;

    await expect(api.listGithubActionsRuns(read, { repository: 'acme/app', branch: 'main' }))
      .resolves.toMatchObject({ total: 1, runs: [{ id: 42 }] });
    expect(actions.listRuns).toHaveBeenCalledWith('acme/app', expect.objectContaining({ branch: 'main' }));
    await expect(api.inspectGithubActionsRun(read, { repository: repository.id, runId: 42 }))
      .resolves.toMatchObject({ run: { id: 42 } });
    await expect(api.listGithubActionsRuns(read, { repository: 'acme/outside' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.manageGithubActionsRun(read, { repository: 'app', runId: 42, action: 'rerun-failed' }))
      .rejects.toBeInstanceOf(CapabilityError);
    expect(store.eventsSince(task.id, 0).map((event) => event.type)).toEqual([
      'github.actions.runs-read', 'github.actions.run-inspected',
    ]);
    expect(JSON.stringify(store.eventsSince(task.id, 0))).not.toContain('token');

    const write = tokens.mint({ taskId: task.id, profileId: 'do', principal: 'user:owner', projectId: project.id,
      ceiling: ['github:actions:write'], grantorCaps: ['github:actions:write'] }).token;
    await expect(api.manageGithubActionsRun(write, { repository: 'app', runId: 42, action: 'rerun-failed' }))
      .resolves.toMatchObject({ accepted: true });
    await expect(api.dispatchGithubActionsWorkflow(write, {
      repository: 'app', workflow: 'deploy.yml', ref: 'main', inputs: { environment: 'production' },
    })).resolves.toMatchObject({ accepted: true });
    expect(actions.rerun).toHaveBeenCalledWith('acme/app', 42, true);
    expect(actions.dispatch).toHaveBeenCalledWith('acme/app', 'deploy.yml', 'main', { environment: 'production' });
    expect(store.eventsSince(task.id, 0).map((event) => event.type)).toEqual([
      'github.actions.runs-read', 'github.actions.run-inspected',
      'github.actions.run-operated', 'github.actions.workflow-dispatched',
    ]);
    for (const view of ['jobs', 'log', 'artifacts', 'annotations', 'pending-deployments'] as const) {
      await api.inspectGithubActionsRun(read, { runId: 42, view, attempt: 1, jobId: 99, page: 2 });
      expect(actions.inspectRun).toHaveBeenLastCalledWith('acme/app', 42, { view, attempt: 1, jobId: 99, page: 2 });
      await expect(api.inspectGithubActionsRun(write, { runId: 42, view })).rejects.toBeInstanceOf(CapabilityError);
      await expect(api.inspectGithubActionsRun(read, { runId: 42, view, repository: 'acme/outside' })).rejects.toBeInstanceOf(NotFoundError);
    }
    await api.listGithubActionsWorkflows(read, { page: 1 });
    await expect(api.listGithubActionsWorkflows(write, {})).rejects.toBeInstanceOf(CapabilityError);
    await expect(api.listGithubActionsWorkflows(read, { repository: 'acme/outside' })).rejects.toBeInstanceOf(NotFoundError);
    const wrongProject = tokens.mint({ taskId: task.id, profileId: 'do', principal: 'user:owner', projectId: other.id,
      ceiling: ['github:actions:read'], grantorCaps: ['github:actions:read'] }).token;
    await expect(api.inspectGithubActionsRun(wrongProject, { runId: 42, view: 'log', jobId: 99 })).rejects.toBeInstanceOf(CapabilityError);
    expect(JSON.stringify(store.eventsSince(task.id, 0))).not.toMatch(/excerpt|failedJobs|installation-secret/);
    store.close();
  });

  it('requires an explicit repository when a task project has several attachments', async () => {
    const store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Multi', {}, organization.id);
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '9', accountLogin: 'acme', accountType: 'Organization' });
    for (const [id, name] of [['1', 'one'], ['2', 'two']] as Array<[string, string]>) {
      const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: id,
        owner: 'acme', name, sshUrl: `git@github.com:acme/${name}.git`, defaultBranch: 'main', private: true,
        gitConnectionId: connection.id });
      store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    }
    const task = store.createTask({ projectId: project.id, title: 'Choose repo', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const token = tokens.mint({ taskId: task.id, profileId: 'do', principal: 'user:owner', projectId: project.id,
      ceiling: ['github:actions:read'], grantorCaps: ['github:actions:read'] }).token;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens,
      githubApp: { actions: () => ({ listRuns: async () => ({}) }) } as any });
    await expect(api.listGithubActionsRuns(token, {})).rejects.toThrow('repository is required');
    store.close();
  });
});
