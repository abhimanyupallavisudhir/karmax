import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';

/** Confirm on a task whose world parked at Review runs proposeUpstream first.
 *  Only a fork has anything to propose; for the project's own repositories the
 *  step must not wake the parked computer (task #826: 1–2½ minutes per Confirm,
 *  shown as "Confirming…", and up to 15 when the restore hung). */
describe('proposeUpstream on a parked world', () => {
  async function setup(upstream: boolean) {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Widgets');
    const connection = await store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '42', accountLogin: 'jane', accountType: 'User' });
    const repository = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: '77', owner: 'jane', name: 'widgets', sshUrl: 'git@github.com:jane/widgets.git', defaultBranch: 'main',
      private: false, gitConnectionId: connection.id,
      ...(upstream ? { upstream: { owner: 'acme', name: 'widgets', defaultBranch: 'main', private: false } } : {}) });
    await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    const task = await store.createTask({ projectId: project.id, title: 'Fix the widget', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'Fix it' } });
    const handle = { id: task.id, kind: 'e2b', root: '/workspace', branch: `tavya/${task.id}`, base: 'main',
      meta: { projectId: project.id },
      repos: [{ name: 'widgets', repo: 'git@github.com:jane/widgets.git', root: '/workspace/widgets',
        branch: `tavya/${task.id}`, base: 'main', target: 'main' }] };
    await store.setWorldState(handle as any, 'parked');
    const open = vi.fn(async () => { throw new Error('woke the parked world'); });
    const worlds = { get: () => ({ parkable: true }), open, status: async () => 'parked' };
    const core = makeCoreActivities({ store, worlds: worlds as any, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    return { store, core, handle, open };
  }

  it('leaves it asleep when no checkout is a fork', async () => {
    const { store, core, handle, open } = await setup(false);
    try {
      await expect(core.proposeUpstream(handle as any, 'main')).resolves.toEqual({ prs: [], pending: [] });
      expect(open).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('opens it to push a fork branch upstream', async () => {
    const { store, core, handle, open } = await setup(true);
    try {
      await core.proposeUpstream(handle as any, 'main').catch(() => undefined);
      expect(open).toHaveBeenCalled();
    } finally { await store.close(); }
  });
});
