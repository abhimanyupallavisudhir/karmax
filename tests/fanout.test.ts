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

it('disconnects a subscriber with a full asynchronous delivery queue', async () => {
  const store = await Store.create();
  const fanout = await DurableEventFanout.create(store, undefined, 60_000);
  const fast: number[] = [];
  const slow: number[] = [];
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let overflow = 0;
  fanout.on(event => { fast.push(Number(event.payload.index)); });
  fanout.on(async event => {
    slow.push(Number(event.payload.index));
    await blocked;
  }, () => { overflow++; });
  try {
    for (let index = 0; index < 1030; index++) await store.appendEvent({ taskId: 'fanout-test', type: 'new', ts: index, payload: { index } });
    await (fanout as unknown as { drain(): Promise<void> }).drain();
    expect(fast).toHaveLength(1030);
    expect(slow).toEqual([0]);
    expect(overflow).toBe(1);
    unblock();
    await new Promise(resolve => setImmediate(resolve));
    expect(slow).toEqual([0]);
  } finally { unblock(); fanout.close(); await store.close(); }
});

it('awaits each subscriber in event order without delaying other subscribers', async () => {
  const store = await Store.create();
  const fanout = await DurableEventFanout.create(store, undefined, 60_000);
  const seen: number[] = [];
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  fanout.on(async event => { await blocked; seen.push(Number(event.payload.index)); });
  try {
    for (let index = 0; index < 3; index++) await store.appendEvent({ taskId: 'fanout-test', type: 'new', ts: index, payload: { index } });
    await (fanout as unknown as { drain(): Promise<void> }).drain();
    expect(seen).toEqual([]);
    unblock();
    await new Promise(resolve => setImmediate(resolve));
    expect(seen).toEqual([0, 1, 2]);
  } finally { unblock(); fanout.close(); await store.close(); }
});
