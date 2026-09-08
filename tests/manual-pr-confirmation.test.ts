import { describe, it, expect } from 'vitest';
import { Store } from '../src/store/db.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';

describe('deferred manual PR confirmation', () => {
  it.each(['authorized', 'wrong-user', 'disabled', 'agent', 'landing', 'revoked'])('%s', async (scenario) => {
    const store = new Store(':memory:');
    try {
      store.claimPersonalOrganization('owner');
      const project = store.createProject('Manual PR');
      const task = store.createTask({
        projectId: project.id, title: 'Proposal', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'work' },
        createdBy: { kind: 'user', userId: 'owner' },
      });
      store.saveView(task.id, {
        taskId: task.id, title: task.title, workflow: task.workflow,
        stage: scenario === 'landing' ? 'merge' : 'review', status: 'waiting',
        waitingFor: scenario === 'agent' ? { kind: 'confirm' } : { kind: 'human', audience: ['@creator'] },
        actions: [{ name: 'confirm', label: 'Confirm PR', kind: 'signal', enabled: scenario !== 'disabled' }],
        prs: [{ repo: 'repo', slug: 'owner/repo', number: 42, headSha: 'reviewed-head',
          url: 'https://github.com/owner/repo/pull/42', state: 'open' }],
        messages: [], state: {}, updatedAt: Date.now(),
      });
      const core = makeCoreActivities({
        store, worlds: new WorldRegistry(), adapters: new Map(),
        profiles: new ProfileResolver(store, 'mock'),
        ...(scenario === 'revoked' ? { authorization: { capabilities: () => [] } as any } : {}),
      });
      expect(await core.confirmManualPr(task.id, scenario === 'wrong-user' ? 'other' : 'owner'))
        .toBe(scenario === 'authorized');
      const votes = store.eventsSince(task.id, 0).filter((event) => event.type === 'task.confirmation-voted');
      expect(votes).toHaveLength(scenario === 'authorized' ? 1 : 0);
      if (scenario === 'authorized') expect(votes[0]!.payload).toMatchObject({
        userId: 'owner', satisfied: true, githubMergeAuthorized: true,
        githubMergeIntentAuthorized: true,
        githubPrHeads: [{ slug: 'owner/repo', number: 42, headSha: 'reviewed-head' }],
      });
    } finally {
      store.close();
    }
  });
});
