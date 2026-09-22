import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { describe, it, expect } from 'vitest';
import { Store } from '../src/store/db.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';

describe('deferred manual PR confirmation', () => {
  it('preserves identical deferred-review intent for a human and its authorized delegate', async () => {
    const store = (await Store.create(':memory:'));
    try {
      const project = (await store.createProject('Delegate review'));
      const task = (await store.createTask({ projectId: project.id, title: 'Review', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'work' } }));
      const tokens = new TokenAuthority();
      const human = (await tokens.mintPrincipal('user:reviewer', ['task:signal'], project.id));
      const delegation = (await tokens.delegateHuman(human.token, { taskId: 'reviewer-agent', projectId: project.id }))!;
      const agent = (await tokens.mint({ taskId: 'reviewer-agent', profileId: 'developer', principal: 'task:reviewer-agent',
        projectId: project.id, ceiling: ['task:signal'], grantorCaps: ['task:signal'], delegationId: delegation.id }));
      const signals: unknown[][] = [];
      const client = { workflow: { getHandle: () => ({ signal: async (...args: unknown[]) => { signals.push(args); } }) } } as any;
      const api = new KarmaxApi({ store, tokens, client, taskQueue: 'test' });
      for (const token of [human.token, agent.token]) await api.signalTask(token, task.id, 'openPr');
      expect(signals).toEqual([['openPr', { userId: 'reviewer' }], ['openPr', { userId: 'reviewer' }]]);
    } finally { (await store.close()); }
  });

  it.each(['authorized', 'wrong-user', 'disabled', 'agent', 'landing', 'revoked'])('%s', async (scenario) => {
    const store = (await Store.create(':memory:'));
    try {
      (await store.claimPersonalOrganization('owner'));
      const project = (await store.createProject('Manual PR'));
      const task = (await store.createTask({
        projectId: project.id, title: 'Proposal', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'work' },
        createdBy: { kind: 'user', userId: 'owner' },
      }));
      (await store.saveView(task.id, {
        taskId: task.id, title: task.title, workflow: task.workflow,
        stage: scenario === 'landing' ? 'merge' : 'review', status: 'waiting',
        waitingFor: scenario === 'agent' ? { kind: 'confirm' } : { kind: 'human', audience: ['@creator'] },
        actions: [{ name: 'confirm', label: 'Confirm PR', kind: 'signal', enabled: scenario !== 'disabled' }],
        prs: [{ repo: 'repo', slug: 'owner/repo', number: 42, headSha: 'reviewed-head',
          url: 'https://github.com/owner/repo/pull/42', state: 'open' }],
        messages: [], state: {}, updatedAt: Date.now(),
      }));
      const core = makeCoreActivities({
        store, worlds: new WorldRegistry(), adapters: new Map(),
        profiles: new ProfileResolver(store, 'mock'),
        ...(scenario === 'revoked' ? { authorization: { capabilities: () => [] } as any } : {}),
      });
      expect(await core.confirmManualPr(task.id, scenario === 'wrong-user' ? 'other' : 'owner'))
        .toBe(scenario === 'authorized');
      const votes = (await store.eventsSince(task.id, 0)).filter((event) => event.type === 'task.confirmation-voted');
      expect(votes).toHaveLength(scenario === 'authorized' ? 1 : 0);
      if (scenario === 'authorized') expect(votes[0]!.payload).toMatchObject({
        userId: 'owner', satisfied: true, githubMergeAuthorized: true,
        githubMergeIntentAuthorized: true,
        githubPrHeads: [{ slug: 'owner/repo', number: 42, headSha: 'reviewed-head' }],
      });
    } finally {
      (await store.close());
    }
  });
});
