import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { hostedRepositoryUrl } from '../src/domain/hosted-repository.js';
import type { TaskInput } from '../src/domain/types.js';

/**
 * tavya-error 5b7a123b7e52ac15: a hosted project whose code lives on tavya
 * (no GitHub) stopped every task at "stage pr" with `remote policy "pr" is
 * on, but no repository in this world has a GitHub origin remote`. The
 * project's effective config said `push`, but the task's resolved `remote`
 * param (from the stored project config, settings rows, or the hosted coercion
 * of `none`) was copied over it into the workflow input. Pull requests need
 * GitHub, so whatever any layer names, such a task must land by push.
 */
describe('a task on repositories tavya hosts', () => {
  let previousDeployment: string | undefined;
  beforeEach(() => { previousDeployment = process.env.KARMAX_DEPLOYMENT; process.env.KARMAX_DEPLOYMENT = 'hosted'; });
  afterEach(() => {
    if (previousDeployment === undefined) delete process.env.KARMAX_DEPLOYMENT;
    else process.env.KARMAX_DEPLOYMENT = previousDeployment;
  });

  async function fixture(on: 'tavya' | 'github' = 'tavya') {
    const store = await Store.create(':memory:');
    await store.claimPersonalOrganization('creator');
    const organizationId = 'org_personal';
    const id = 'repo_notes1';
    const repository = on === 'tavya'
      ? await store.upsertRepository({ id, organizationId, provider: 'tavya', providerId: id, owner: organizationId,
        name: 'notes', sshUrl: hostedRepositoryUrl(id, 'notes'), defaultBranch: 'main', private: true })
      : await store.upsertRepository({ organizationId, provider: 'github', providerId: '1', owner: 'nadia', name: 'notes',
        sshUrl: 'git@github.com:nadia/notes.git', defaultBranch: 'main', private: true,
        gitConnectionId: (await store.upsertGitConnection({ organizationId, provider: 'github', installationId: 'inst',
          accountLogin: 'nadia', accountType: 'User' })).id });
    // As the gateway stores a new hosted project: `remote` defaulted to `pr`.
    const project = await store.createProject('Notes', { repos: [repository.sshUrl], remote: 'pr', defaultBase: 'main', defaultTarget: 'main' } as any);
    await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    const tokens = new TokenAuthority();
    const token = (await tokens.mintPrincipal('user:creator', ['*'], project.id)).token;
    const inputs: TaskInput[] = [];
    const client = { workflow: { start: async (_type: string, options: { args: [TaskInput] }) => { inputs.push(options.args[0]); } } } as any;
    const api = new KarmaxApi({ store, tokens, client, taskQueue: 'test', hosted: true });
    return { store, api, token, project, inputs };
  }

  it.each([
    ['the project\'s stored policy', {}, undefined],
    ['a project settings row', {}, { remote: 'pr' }],
    ['the task\'s own value', { remote: 'pr' }, undefined],
  ])('lands by push whatever %s says', async (_label, overrides, settings) => {
    const f = await fixture();
    try {
      if (settings) await f.store.setSettings(f.project.id, 'software-dev', settings);
      expect(await f.store.effectiveProjectConfig(f.project.id)).toMatchObject({ remote: 'push' });
      await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'software-dev', prompt: 'write notes', ...overrides } as any);
      expect(f.inputs).toHaveLength(1);
      expect(f.inputs[0]!.project.remote).toBe('push');
    } finally { await f.store.close(); }
  });

  // Every later start — a queued draft, a retry, a stage move — rebuilds the
  // input the same way (buildStart), so a task stopped by this error recovers.
  it('lands by push when a draft is queued later', async () => {
    const f = await fixture();
    try {
      const draft = await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'software-dev', prompt: 'write notes', draft: true } as any);
      expect(f.inputs).toHaveLength(0);
      await f.api.queueTask(f.token, draft.id);
      expect(f.inputs[0]!.project.remote).toBe('push');
    } finally { await f.store.close(); }
  });

  it('opens pull requests when the repository is on GitHub', async () => {
    const f = await fixture('github');
    try {
      await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'software-dev', prompt: 'write notes' } as any);
      expect(f.inputs[0]!.project.remote).toBe('pr');
    } finally { await f.store.close(); }
  });
});
