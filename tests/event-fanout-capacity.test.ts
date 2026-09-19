import { afterEach, expect, it, vi } from 'vitest';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { DurableEventFanout } from '../src/gateway/fanout.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

it('routes a burst once per database page, irrespective of browser count, and yields between pages', async () => {
  const store = new Store(); cleanups.push(() => store.close());
  const project = store.createProject('Fanout');
  const task = store.createTask({ projectId: project.id, title: 'Long conversation', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: "fixture" } });
  const bus = new KarmaxBus();
  const fanout = new DurableEventFanout(store, bus, 60_000); cleanups.push(() => fanout.close());
  const projects = vi.spyOn(store, 'taskProjectIds');
  const hydrate = vi.spyOn(store, 'getTask').mockImplementation(() => { throw Error('must not hydrate conversations'); });
  const received: number[][] = Array.from({ length: 20 }, () => []);
  for (const rows of received) fanout.on((event, projectId) => {
    expect(projectId).toBe(project.id); rows.push(event.seq!);
  });
  // One bad browser must not hide events from later subscribers.
  const error = vi.spyOn(console, 'error').mockImplementation(() => {}); cleanups.push(() => error.mockRestore());
  fanout.on(() => { throw Error('disconnected'); });
  const expected: number[] = [];
  for (let i = 0; i < 1100; i++) expected.push(Number(store.db.prepare('INSERT INTO events (taskId,type,ts,payload) VALUES (?,?,?,?)')
    .run(task.id, 'fixture', i, '{}').lastInsertRowid));
  bus.emit({ taskId: task.id, type: 'fixture', ts: 1, payload: {} });
  expect(received[0]).toHaveLength(0); // publisher never drains inline
  for (let turn = 0; turn < 20 && !received[0]!.length; turn++) await yieldTurn();
  expect(received[0]!.length).toBeGreaterThan(0);
  expect(received[0]!.length).toBeLessThan(1100);
  await vi.waitFor(() => expect(received[0]).toHaveLength(1100));
  for (const rows of received) expect(rows).toEqual(expected);
  expect(projects).toHaveBeenCalledTimes(3);
  expect(hydrate).not.toHaveBeenCalled();
});

it('stops queued delivery on close', async () => {
  const store = new Store(); cleanups.push(() => store.close());
  const bus = new KarmaxBus();
  const fanout = new DurableEventFanout(store, bus);
  const received = vi.fn(); fanout.on(received);
  bus.emit({ taskId: 'missing', type: 'fixture', ts: 1, payload: {} });
  fanout.close();
  await yieldTurn();
  expect(received).not.toHaveBeenCalled();
});
