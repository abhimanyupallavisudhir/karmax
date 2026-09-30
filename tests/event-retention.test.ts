import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { expectedTaskRemoteHeads } from '../src/world/publication.js';

const stores: Store[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
const DAY = 86_400_000;
const sha = (c: string) => c.repeat(40);

// Audit R-8: the 90-day event retention deleted the push.head / pr.* events that
// force-with-lease reads, so a task idle for over 90 days could no longer
// publish a rebased branch. The newest head per repository is state, not history.
const postgres = process.env.KARMAX_TEST_POSTGRES_URL;
it.each([['sqlite', ':memory:'], ...(postgres ? [['postgresql', postgres]] : [])])('keeps the newest published head per repository past event retention (%s)', async (_engine, location) => {
  const store = await Store.create(location!); stores.push(store);
  const project = await store.createProject('Idle');
  const task = await store.createTask({ projectId: project.id, title: 'Idle task', workflow: 'software-dev',
    workflowVersion: '1.26.0', params: { prompt: 'work' } });
  const old = Date.now() - 200 * DAY;
  const event = (type: string, payload: object, ts = old) => store.appendEvent({ taskId: task.id, type, ts, payload });
  await event('push.head', { repo: 'app', branch: 'task', headSha: sha('a') });
  await event('pr.opened', { repo: 'app', headSha: sha('b') });
  await event('push.head', { repo: 'app', branch: 'task', headSha: sha('c') });
  await event('push.head', { repo: 'wiki', branch: 'task', headSha: sha('d') });
  await event('agent.activity', { id: 'old-noise' });
  expect(await expectedTaskRemoteHeads(store, task.id)).toEqual({ app: sha('c'), wiki: sha('d') });

  await store.retentionSweep(Date.now());

  expect(await expectedTaskRemoteHeads(store, task.id)).toEqual({ app: sha('c'), wiki: sha('d') });
  expect(await store.eventsOfType(task.id, 'agent.activity')).toEqual([]);
  // Superseded heads still age out.
  expect((await store.eventsOfType(task.id, ['push.head', 'pr.opened', 'pr.updated'])).map((e) => e.payload.headSha))
    .toEqual([sha('c'), sha('d')]);
});
