import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { DurableEventFanout } from '../src/gateway/fanout.js';

describe('DurableEventFanout', () => {
  it('starts at the aggregate cursor and drains large bursts without gaps', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('fanout'));
    const task = (await store.createTask({
      projectId: project.id,
      title: 'task',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    }));
    (await store.appendEvent({ taskId: task.id, type: 'old', ts: 0, payload: { index: -1 } }));

    const fanout = (await DurableEventFanout.create(store, undefined, 60_000));
    const seen: number[] = [];
    fanout.on((event) => seen.push(Number(event.payload.index)));

    for (let index = 0; index < 1_001; index++) {
      (await store.appendEvent({ taskId: task.id, type: 'new', ts: index + 1, payload: { index } }));
    }
    await (fanout as unknown as { drain(): Promise<void> }).drain();

    expect(seen).toEqual(Array.from({ length: 1_001 }, (_, index) => index));
    fanout.close();
    (await store.close());
  });
});
