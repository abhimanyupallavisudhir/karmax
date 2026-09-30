import { it, expect } from 'vitest';
import { Store } from '../src/store/db.js';

it('reads only landing authorization and PR evidence in original sequence order', async () => {
  const store = await Store.create(':memory:');
  try {
    for (const [index, type] of ['task.confirmation-voted', 'agent.output', 'github.merge.authorization-revoked', 'timing', 'github.pr.queued'].entries())
      await store.appendEvent({ taskId: 'task', type, ts: index, payload: { index } });
    const events = await store.eventsOfTypes('task', ['task.confirmation-voted', 'github.merge.authorization-revoked', 'github.pr.queued']);
    expect(events.map(event => event.payload.index)).toEqual([0, 2, 4]);
    expect(await store.eventsOfTypes('task', [])).toEqual([]);
  } finally { await store.close(); }
});
