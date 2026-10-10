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

/**
 * Load test 2026-10: every socket was offered every tenant's events and asked,
 * for each, whether its person may read it. Subscribers now name the
 * organizations they may read, and an event is offered only to those (and to
 * installation-wide readers), in order.
 */
describe('routing by organization', () => {
  async function fixture() {
    const store = await Store.create(':memory:');
    const a = await store.createOrganization({ name: 'A' });
    const b = await store.createOrganization({ name: 'B' });
    const make = async (organizationId: string) => (await store.createTask({ projectId: (await store.createProject(organizationId, {}, organizationId)).id,
      title: 't', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any })).id;
    const fanout = await DurableEventFanout.create(store, undefined, 60_000);
    const publish = async (taskIds: string[]) => {
      for (const [index, taskId] of taskIds.entries()) await store.appendEvent({ taskId, type: 'new', ts: index, payload: { index } });
      await (fanout as unknown as { drain(): Promise<void> }).drain();
    };
    return { store, fanout, a, b, taskA: await make(a.id), taskB: await make(b.id), publish };
  }

  it('offers an event only to subscribers of its organization and to installation-wide readers', async () => {
    const f = await fixture();
    try {
      const offered = { a: [] as number[], b: [] as number[], all: [] as number[], none: [] as number[] };
      f.fanout.on((event) => { offered.a.push(Number(event.payload.index)); }, undefined, new Set([f.a.id]));
      f.fanout.on((event) => { offered.b.push(Number(event.payload.index)); }, undefined, new Set([f.b.id]));
      f.fanout.on((event) => { offered.all.push(Number(event.payload.index)); }, undefined, 'all');
      f.fanout.on((event) => { offered.none.push(Number(event.payload.index)); }, undefined, new Set());
      await f.publish([f.taskA, f.taskB, f.taskA, 'no-such-task', f.taskB]);
      expect(offered).toEqual({ a: [0, 2], b: [1, 4], all: [0, 1, 2, 3, 4], none: [] });
    } finally { f.fanout.close(); await f.store.close(); }
  });

  it('follows a subscriber whose organizations change, keeping its order', async () => {
    const f = await fixture();
    try {
      const seen: string[] = [];
      const subscription = f.fanout.on((event) => { seen.push(`${event.taskId === f.taskA ? 'a' : 'b'}${event.payload.index}`); }, undefined, new Set([f.a.id]));
      await f.publish([f.taskA, f.taskB]);
      subscription.audience(new Set([f.a.id, f.b.id]));
      await f.publish([f.taskB, f.taskA, f.taskB]);
      subscription.audience(new Set([f.b.id]));
      await f.publish([f.taskA, f.taskB]);
      expect(seen).toEqual(['a0', 'b0', 'a1', 'b2', 'b1']);
      subscription();
      await f.publish([f.taskB]);
      expect(seen).toHaveLength(5);
    } finally { f.fanout.close(); await f.store.close(); }
  });
});
