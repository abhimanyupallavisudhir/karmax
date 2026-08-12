import { describe, expect, it } from 'vitest';
import { expectedTaskRemoteHeads } from '../src/activities/core.js';
import { Store } from '../src/store/db.js';

describe('task PR head recovery', () => {
  it('uses the latest durable PR observation when a recovery view lost its PR list', () => {
    const store = new Store(':memory:');
    const project = store.createProject('PR recovery', { repos: [], defaultBase: 'master' });
    const task = store.createTask({
      projectId: project.id,
      title: 'Rebase an existing PR',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'test' },
    });
    const first = '1'.repeat(40);
    const latest = '2'.repeat(40);
    store.appendEvent({ taskId: task.id, type: 'pr.opened', ts: 1,
      payload: { repo: 'karmax', headSha: first } });
    store.appendEvent({ taskId: task.id, type: 'pr.updated', ts: 2,
      payload: { repo: 'karmax', headSha: latest } });
    store.appendEvent({ taskId: task.id, type: 'pr.updated', ts: 3,
      payload: { repo: 'ignored', headSha: 'not-a-sha' } });

    expect(expectedTaskRemoteHeads(store, task.id)).toEqual({ karmax: latest });
  });
});
