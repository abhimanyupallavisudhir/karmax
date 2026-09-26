import { describe, expect, it } from 'vitest';
import { expectedTaskRemoteHeads } from '../src/world/publication.js';
import { Store } from '../src/store/db.js';

describe('task PR head recovery', () => {
  it('uses the latest durable PR observation when a recovery view lost its PR list', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('PR recovery', { repos: [], defaultBase: 'master' }));
    const task = (await store.createTask({
      projectId: project.id,
      title: 'Rebase an existing PR',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'test' },
    }));
    const first = '1'.repeat(40);
    const latest = '2'.repeat(40);
    (await store.appendEvent({ taskId: task.id, type: 'pr.opened', ts: 1,
      payload: { repo: 'karmax', headSha: first } }));
    (await store.appendEvent({ taskId: task.id, type: 'pr.updated', ts: 2,
      payload: { repo: 'karmax', headSha: latest } }));
    (await store.appendEvent({ taskId: task.id, type: 'pr.updated', ts: 3,
      payload: { repo: 'ignored', headSha: 'not-a-sha' } }));

    expect((await expectedTaskRemoteHeads(store, task.id))).toEqual({ karmax: latest });
    const checkpointHead = '3'.repeat(40);
    (await store.appendEvent({ taskId: task.id, type: 'push.head', ts: 4,
      payload: { repo: 'karmax', branch: `tavya/${task.id}`, headSha: checkpointHead } }));
    expect((await expectedTaskRemoteHeads(store, task.id))).toEqual({ karmax: checkpointHead });
    (await store.close());
  });
});
