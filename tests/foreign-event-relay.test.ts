import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ForeignEventRelay } from '../src/contrib/foreign-event-relay.js';
import { TriggerScheduler } from '../src/platform/trigger-scheduler.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('relays another process in ordered pages without duplicating local events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-event-relay-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.db');
  const store = await Store.create(filename);
  cleanup.push(() => store.close());
  const bus = new KarmaxBus();
  const project = await store.createProject('Relay');
  const source = await store.createTask({ projectId: project.id, title: 'Source', workflow: 'just-do',
    workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const target = await store.createTask({ projectId: project.id, title: 'Triggered', workflow: 'just-do',
    workflowVersion: '1.0.0', params: { prompt: 'fixture', triggers: [{ kind: 'event', type: 'fixture', where: { index: 0 } }] } });
  await store.updateTaskParams(target.id, { ...target.params, triggerState: 'armed' });
  const fire = vi.fn().mockResolvedValue(undefined);
  const scheduler = new TriggerScheduler({ store, bus, fire });
  await scheduler.start();
  cleanup.push(() => scheduler.stop());
  const seen: number[] = [];
  bus.onAny(event => { seen.push(Number(event.payload.index)); });
  const relay = await ForeignEventRelay.create(store, bus, { intervalMs: 60_000 });
  cleanup.push(() => relay.stop());
  const event = { taskId: source.id, type: 'fixture', ts: 1, payload: { index: -1 } };
  await bus.emit({ ...event, seq: await store.appendEvent(event) });
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(new URL('../src/store/db.ts', import.meta.url).href)};
    const store = await Store.create(${JSON.stringify(filename)});
    try {
      for (let index = 0; index < 260; index++)
        await store.appendEvent({taskId:${JSON.stringify(source.id)}, type:'fixture', ts:1, payload:{index}});
    } finally { await store.close(); }
  `], { timeout: 30_000 });
  await relay.wake();
  await relay.wake();
  expect(seen).toEqual([-1, ...Array.from({ length: 260 }, (_, index) => index)]);
  expect(fire).toHaveBeenCalledExactlyOnceWith(target.id, 'self');
  expect((await store.nextEventsSince(0, 1))[0]).not.toHaveProperty('origin');
});

it('upgrades old event tables without dropping their history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-event-migration-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.db');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL,
    type TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL);
    INSERT INTO events (taskId,type,ts,payload) VALUES ('fixture','legacy',1,'{}');`);
  old.close();
  const store = await Store.create(filename);
  cleanup.push(() => store.close());
  const page = await store.nextForeignEventPage(0);
  expect(page).toMatchObject({ cursor: 1, scanned: 1, events: [{ type: 'legacy', seq: 1 }] });
  const seq = await store.appendEvent({ taskId: 'fixture', type: 'local', ts: 2, payload: {} });
  expect(await store.nextForeignEventPage(1)).toEqual({ cursor: seq, scanned: 1, events: [] });
});

it('coalesces wake-ups and drains the accepted page before stopping', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const seen: number[] = [];
  const bus = new KarmaxBus();
  bus.onAny(async event => { seen.push(event.seq!); await blocked; });
  const read = vi.fn().mockResolvedValue({ cursor: 2, scanned: 2, events: [1, 2].map(seq => ({
    seq, taskId: 'fixture', type: 'fixture', ts: 1, payload: {},
  })) });
  const relay = await ForeignEventRelay.create({ nextForeignEventPage: read, latestEventSeq: async () => 0 }, bus,
    { intervalMs: 60_000 });
  cleanup.push(() => relay.stop());
  const first = relay.wake();
  await vi.waitFor(() => expect(seen).toEqual([1]));
  const second = relay.wake();
  let stopped = false;
  const stopping = relay.stop().then(() => { stopped = true; });
  try {
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  } finally { release(); await Promise.all([first, second, stopping]); }
  expect(seen).toEqual([1, 2]);
  await relay.wake();
  expect(read).toHaveBeenCalledTimes(1);
});

it('retries a failed database read without advancing the cursor', async () => {
  const failed = vi.fn();
  const read = vi.fn().mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValueOnce({ cursor: 4, scanned: 0, events: [] });
  const relay = await ForeignEventRelay.create({ nextForeignEventPage: read, latestEventSeq: async () => 4 },
    new KarmaxBus(), { intervalMs: 60_000, onError: failed });
  cleanup.push(() => relay.stop());
  await relay.wake();
  await relay.wake();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(read.mock.calls).toEqual([[4, 128], [4, 128]]);
});
