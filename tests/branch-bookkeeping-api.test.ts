import { describe, expect, it } from 'vitest';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';

describe('task branch policy persistence', () => {
  function setup(updateResult: { applied: string[] } = { applied: ['target'] }) {
    const store = new Store(':memory:');
    store.claimPersonalOrganization('owner');
    const project = store.createProject('Branch policy');
    const tokens = new TokenAuthority(store);
    const token = tokens.mintPrincipal('user:owner', ['task:*'], project.id, 60_000,
      project.organizationId).token;
    const client = { workflow: {
      start: async (_type: string, options: any) => ({ workflowId: options.workflowId }),
      getHandle: () => ({ executeUpdate: async () => updateResult }),
    } } as any;
    return { store, project, token, api: new KarmaxApi({ store, tokens, client, taskQueue: 'test' }) };
  }

  it('creates an independent agent fork on an explicit parent target atomically', async () => {
    const { store, project, token, api } = setup();
    const source = store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'source' } });
    store.kvSet(`session:${source.id}:do`, 'preserved-session');
    const parent = 'karmax/task_parent';

    const fork = await api.forkTaskAgent(token, {
      taskId: source.id,
      message: 'recover the preserved work',
      target: parent,
    });

    expect(fork.params).toMatchObject({ base: parent, target: parent,
      _repositoryBranchesResolved: true,
      'agent:do': { resumeFrom: { taskId: source.id, role: 'do' } } });
    store.close();
  });

  it('carries durable file references through repeated agent forks', async () => {
    const { store, project, token, api } = setup();
    const file = { id: 'a'.repeat(64), name: 'requirements.pdf', mediaType: 'application/pdf', bytes: 2048 };
    store.grantAttachment(file.id, project.id);
    const source = store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'source', files: [file] } });
    store.kvSet(`session:${source.id}:do`, 'source-session');

    const first = await api.forkTaskAgent(token, { taskId: source.id, message: 'continue once' });
    store.kvSet(`session:${first.id}:do`, 'first-session');
    const second = await api.forkTaskAgent(token, { taskId: first.id, message: 'continue twice' });

    expect(first.params.files).toEqual([file]);
    expect(second.params.files).toEqual([file]);
    expect(store.attachmentAllowed(file.id, project.id)).toBe(true);
    store.close();
  });

  it('keeps an independent fork coherent when it is immediately retargeted before lock', async () => {
    const { store, project, token, api } = setup();
    const source = store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'source' } });
    store.kvSet(`session:${source.id}:do`, 'preserved-session');
    const fork = await api.forkTaskAgent(token, { taskId: source.id, message: 'recover independently' });
    const parent = 'karmax/task_parent';

    await expect(api.updateParams(token, fork.id, { target: parent })).resolves.toEqual({ applied: ['target'] });

    expect(store.getTask(fork.id)?.params).toMatchObject({ base: 'main', target: parent,
      _repositoryBranchesResolved: true,
      'agent:do': { resumeFrom: { taskId: source.id, role: 'do' } } });
    store.close();
  });

  it('persists an accepted immediate retarget without rewriting the provisioned base', async () => {
    const { store, project, token, api } = setup();
    const task = store.createTask({ projectId: project.id, title: 'Recovery', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'recover', base: 'master', target: 'master',
        _repositoryBranchesResolved: true } });
    const baseSha = 'a'.repeat(40);
    const handle = store.registerWorld({
      kind: 'e2b', id: task.id, root: '/workspace', branch: `karmax/${task.id}`,
      base: 'master', target: 'master',
      repos: [{ name: 'app', repo: 'git@github.com:acme/app.git', root: '/workspace',
        branch: `karmax/${task.id}`, base: 'master', target: 'master', targetPinned: false, baseSha }],
    }, project.id);
    const parent = 'karmax/task_parent';

    await expect(api.updateParams(token, task.id, { target: parent })).resolves.toEqual({ applied: ['target'] });

    expect(store.getTask(task.id)?.params).toMatchObject({ base: 'master', target: parent,
      _repositoryBranchesResolved: true });
    expect(store.currentWorld(task.id)).toMatchObject({ base: 'master', target: parent,
      repos: [{ base: 'master', target: parent, baseSha }] });
    expect(store.currentWorld(task.id)?.generation).toBe(handle.generation);
    store.close();
  });
});
