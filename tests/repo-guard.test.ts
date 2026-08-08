import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { RESOLVE_AGENT_ENABLED } from '../src/config/features.js';

/** Repository selection validation before a workflow is started. */
describe('repository selection validation', () => {
  let store: Store;
  let api: KarmaxApi;
  let token: string;
  let tokens: TokenAuthority;
  let started: unknown[][];
  let startError: Error | undefined;

  beforeEach(() => {
    store = new Store(':memory:');
    store.claimPersonalOrganization('a');
    tokens = new TokenAuthority();
    started = [];
    startError = undefined;
    const client = {
      workflow: {
        start: async (...a: unknown[]) => {
          if (startError) throw startError;
          started.push(a);
          return {};
        },
      },
    } as any;
    api = new KarmaxApi({ store, client, taskQueue: 'tq', tokens });
    token = tokens.mint({
      taskId: 't',
      profileId: 'do',
      principal: 'user:a',
      ceiling: ['create-task', 'read-task'],
      grantorCaps: ['create-task', 'read-task'],
    }).token;
  });

  it('allows software-development work when no repo is configured', async () => {
    const p = store.createProject('NoRepo', {}); // repos unset
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'do a thing' });
    expect(task.workflow).toBe('software-dev');
    expect(started).toHaveLength(1);
    expect((started[0]![1] as any).args[0].project.repos ?? []).toEqual([]);
  });

  it('normalizes blank repository entries to the zero-repo case', async () => {
    const p = store.createProject('Blank', { repos: ['', '   '] });
    await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(started).toHaveLength(1);
    expect((started[0]![1] as any).args[0].project.repos).toEqual([]);
  });

  it('allows the run once a repository is configured', async () => {
    const p = store.createProject('HasRepo', { repos: ['/some/repo'] });
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(task.workflow).toBe('software-dev');
    expect(started).toHaveLength(1); // guard passed → workflow started
    expect((started[0]![1] as any).args[0].resolveAgentEnabled).toBe(false);
  });

  it('allows a hosted zero-repo task without requiring a GitHub connection', async () => {
    const p = store.createProject('Hosted state', { worldProvider: 'e2b', repos: [] });
    // Model an existing hosted installation whose settings predate the hosted
    // PR default. KarmaxApi must normalize new workflow inputs even before the
    // Store's boot migration gets another chance to rewrite the row.
    store.setSettings(p.id, '__common__', { remote: 'none' });
    api = new KarmaxApi({ store, client: { workflow: { start: async (...a: unknown[]) => { started.push(a); return {}; } } } as any,
      taskQueue: 'tq', tokens, hosted: true });
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'update state' });
    expect(task.workflow).toBe('software-dev');
    expect(started).toHaveLength(1);
    expect((started[0]![1] as any).args[0].project.remote).toBe('pr');

    const remote = (api.workflowSchemas().find((schema) => schema.name === 'software-dev')!.params as any[])
      .find((field) => field.name === 'remote');
    expect(remote).toMatchObject({ default: 'pr', options: ['pr', 'push'] });
    expect(remote.help).not.toMatch(/none/i);
  });

  it('requires a first-class organization repository in hosted mode', async () => {
    const p = store.createProject('Hosted', { worldProvider: 'e2b', repos: ['git@github.com:acme/app.git'] });
    api = new KarmaxApi({ store, client: { workflow: { start: async (...a: unknown[]) => { started.push(a); return {}; } } } as any,
      taskQueue: 'tq', tokens, hosted: true });
    await expect(api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' }))
      .rejects.toThrow(/connect GitHub in organization settings/i);
    const repository = store.upsertRepository({ organizationId: p.organizationId!, provider: 'github',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'trunk', private: true });
    store.attachProjectRepository({ projectId: p.id, repositoryId: repository.id });
    await expect(api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x',
      params: { repos: ['git@github.com:other/not-attached.git'] } })).rejects.toThrow(/choose a GitHub repo attached/i);
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(task.workflow).toBe('software-dev');
    expect(store.getProject(p.id)?.config).toMatchObject({ repos: [repository.sshUrl], defaultBase: 'trunk', defaultTarget: 'trunk' });
  });

  it('snapshots and reports the exact Codex selection for the Software Dev Do agent', async () => {
    const p = store.createProject('Codex', { repos: ['/some/repo'] });
    const selected = { provider: 'codex' as const, model: 'gpt-5.6-sol', effort: 'high' as const };
    const task = await api.createTask(token, {
      projectId: p.id,
      workflow: 'software-dev',
      prompt: 'x',
      params: { separateAgents: false, 'agent:unified': selected },
    });

    const expected = { do: selected };
    const input = startedInput();
    expect(input.agents).toEqual(expected);

    // Workflows intentionally do not publish execution metadata (their histories
    // are immutable); the platform enriches any stored/live view with its durable
    // queue-time snapshot instead.
    store.saveView(task.id, {
      taskId: task.id,
      title: task.title,
      workflow: task.workflow,
      stage: 'setup',
      status: 'active',
      messages: [],
      actions: [],
      state: {},
      updatedAt: 1,
    });
    const view = await api.getTaskView(token, task.id);
    expect(view?.agents).toEqual(expected);
  });

  it('lets a draft be saved and queued without a repo', async () => {
    const p = store.createProject('Draft', {});
    const draft = await api.createTask(token, {
      projectId: p.id,
      workflow: 'software-dev',
      prompt: 'x',
      draft: true,
    });
    expect(started).toHaveLength(0); // a draft starts nothing
    await api.queueTask(token, draft.id);
    expect(started).toHaveLength(1);
  });

  it('does not retain a number when the durable engine refuses the queue', async () => {
    const p = store.createProject('QueueFailure', { repos: ['/some/repo'] });
    const draft = await api.createTask(token, {
      projectId: p.id,
      workflow: 'software-dev',
      prompt: 'x',
      draft: true,
    });
    expect(draft.num).toBeUndefined();

    startError = new Error('engine unavailable');
    await expect(api.queueTask(token, draft.id)).rejects.toThrow(/still saved as a draft/i);
    expect(store.getTask(draft.id)).toMatchObject({ num: undefined, params: { draft: true } });

    startError = undefined;
    const queued = await api.queueTask(token, draft.id);
    expect(queued.num).toBe(1);
    expect(queued.params.draft).toBe(false);
    expect((started[0]![1] as any).workflowIdReusePolicy).toBe(WorkflowIdReusePolicy.REJECT_DUPLICATE);
  });

  it('repairs a stale draft when Temporal already accepted its workflow', async () => {
    const p = store.createProject('LostAcknowledgement', { repos: ['/some/repo'] });
    const draft = await api.createTask(token, {
      projectId: p.id,
      workflow: 'software-dev',
      prompt: 'x',
      draft: true,
    });

    // This is what a retry sees when the earlier start reached Temporal but its
    // acknowledgement did not reach Karmax: durable execution exists, metadata
    // still says draft.
    startError = new WorkflowExecutionAlreadyStartedError(
      'Workflow execution already started',
      draft.id,
      'softwareDev@1.0.0',
    );
    const queued = await api.queueTask(token, draft.id);

    expect(queued.num).toBe(1);
    expect(queued.params.draft).toBe(false);
    expect(store.getTask(draft.id)).toMatchObject({ num: 1, params: { draft: false } });
  });

  // Repository selection validation and the world builder must read the same
  // effective list, including settings overlays.
  const startedInput = () => (started[0]![1] as any).args[0];

  it('an empty project-settings repos list does not shadow the configured repo', async () => {
    const p = store.createProject('OverlayEmpty', { repos: ['/some/repo'] });
    store.setSettings(p.id, 'software-dev', { repos: [] }); // blank list saved in settings
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(task.workflow).toBe('software-dev');
    expect(started).toHaveLength(1); // runs — falls back to the configured repo, no scratch world
    expect(startedInput().project.repos).toEqual(['/some/repo']);
  });

  it('allows the run when the repo comes only from the settings overlay (not project config)', async () => {
    const p = store.createProject('OverlayOnly', {}); // config has no repo…
    store.setSettings(p.id, 'software-dev', { repos: ['/from/settings'] }); // …but settings does
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(task.workflow).toBe('software-dev');
    expect(started).toHaveLength(1); // guard reads the effective repos, so this passes
    expect(startedInput().project.repos).toEqual(['/from/settings']);
  });

  it('treats an explicitly empty effective repository list as repository-less work', async () => {
    const p = store.createProject('AllEmpty', { repos: ['/cfg'] });
    store.setSettings(p.id, 'software-dev', { repos: ['   '] }); // whitespace-only overlay wins, resolves empty
    await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(started).toHaveLength(1);
    expect(startedInput().project.repos).toEqual([]);
  });
});
