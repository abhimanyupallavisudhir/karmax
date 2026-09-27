import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store/db.js';
import { stubGateway } from './helpers/stub-gateway.js';

/**
 * #396 review item 2: every 150 ms window republishes the whole text so far of
 * the block being generated. Stored as new rows, a streamed reply grew the event
 * log quadratically and pushed the rows a task page and the Activity feed read
 * out of their bounded windows. Each publication now supersedes the agent's
 * previous one, streamed text is kept out of both windows, and a socket that has
 * fallen behind receives only the latest text.
 */

const REPLY = 'x'.repeat(4096);
/** A 4 KB reply streamed over 20 s, one publication per 150 ms window. */
const windows = () => {
  const count = Math.ceil(20_000 / 150);
  return Array.from({ length: count }, (_, i) => REPLY.slice(0, Math.ceil((REPLY.length * (i + 1)) / count)));
};
const live = (taskId: string, text: string, role = 'do') =>
  ({ taskId, type: 'agent.output', ts: Date.now(), payload: { text, source: 'assistant', role, turnId: `${taskId}:turn-1`, attempt: 1 } });

async function fixture() {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Streams');
  const task = await store.createTask({ projectId: project.id, title: 'Stream', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
  return { store, project, task };
}
const outputRows = async (store: Store, taskId: string) => (await store.db.prepare(
  "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM events WHERE taskId = ? AND type = 'agent.output'").get(taskId)) as { rows: number; bytes: number };

describe('streamed agent text storage', () => {
  it('keeps one row per agent, O(message length), however long it streams', async () => {
    const { store, task } = await fixture();
    try {
      for (const text of windows()) await store.appendLiveOutput(live(task.id, text));
      await store.appendLiveOutput(live(task.id, 'Checking', 'confirm'));
      const { rows, bytes } = await outputRows(store, task.id);
      expect(rows).toBe(2);
      expect(bytes).toBeLessThan(REPLY.length + 1024);
      const latest = (await store.eventsSince(task.id, 0)).filter((event) => event.type === 'agent.output');
      expect(latest.map((event) => [event.payload.role, String(event.payload.text).length])).toEqual([['do', 4096], ['confirm', 8]]);
    } finally { await store.close(); }
  });

  it('never lets streamed text crowd the task page window, and a page opened mid-stream still sees it', async () => {
    const { store, task } = await fixture();
    try {
      for (let i = 0; i < 50; i++) await store.appendEvent({ taskId: task.id, type: 'agent.activity', ts: i, payload: { id: `cmd-${i}`, kind: 'command', phase: 'completed', title: `step ${i}`, role: 'do' } });
      await store.appendLiveOutput(live(task.id, 'Working on it'));
      // Tool lines and legacy per-window rows from before this change.
      for (let i = 0; i < 400; i++) await store.appendEvent({ taskId: task.id, type: 'agent.output', ts: i, payload: { text: `$ step ${i}`, role: 'do' } });
      for (let i = 0; i < 400; i++) await store.appendEvent(live(task.id, `Working on it ${i}`, 'confirm'));
      const page = await store.eventsSince(task.id, 0, 300);
      expect(page.filter((event) => event.type === 'agent.activity')).toHaveLength(50);
      expect(page.filter((event) => event.type === 'agent.output').map((event) => [event.payload.role, event.payload.text]))
        .toEqual([['do', 'Working on it'], ['confirm', 'Working on it 399']]);
      expect(page.map((event) => event.seq)).toEqual([...page.map((event) => event.seq)].sort((a, b) => a - b));
    } finally { await store.close(); }
  });

  it('keeps streamed text out of the installation-wide Activity window', async () => {
    const { store, task } = await fixture();
    try {
      await store.appendEvent({ taskId: task.id, type: 'task.created', ts: 1, payload: {} });
      for (let i = 0; i < 400; i++) await store.appendEvent({ taskId: task.id, type: 'agent.output', ts: i, payload: { text: `chunk ${i}`, source: 'assistant', role: 'do' } });
      const recent = await store.allEventsSince(0, 300);
      expect(recent.map((event) => event.type)).toEqual(['task.created']);
    } finally { await store.close(); }
  });
});

describe('streamed agent text on a socket', () => {
  it('sends a client that has fallen behind only the latest text, and never drops it for falling behind', async () => {
    const h = await stubGateway();
    const project = await h.store.createProject('Visible');
    const task = await h.store.createTask({ projectId: project.id, title: 'Visible', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
    const minted = await h.tokens.mintPrincipal('user:viewer', ['task:event:read'], undefined, 60 * 60 * 1000, project.organizationId);
    vi.spyOn(h.gateway as any, 'socketAuth').mockResolvedValue({ apiToken: minted.token });
    // A client that reads nothing: every frame stays in its send buffer.
    const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, close: vi.fn(),
      send: vi.fn((data: string) => { ws.bufferedAmount += Buffer.byteLength(data); }) });
    await (h.gateway as any).eventStream(ws, { headers: {}, url: '/ws' });
    const sent = () => ws.send.mock.calls.map(([data]) => JSON.parse(String(data))).filter((ev) => ev.type === 'agent.output');
    try {
      for (const text of windows()) {
        const event = live(task.id, text);
        const seq = await h.store.appendLiveOutput(event);
        await (h.gateway as any).deps.bus.emit({ ...event, seq });
        await new Promise((resolve) => setTimeout(resolve, 5)); // the fan-out reads each window
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(ws.close).not.toHaveBeenCalled();
      expect(ws.bufferedAmount).toBeLessThan(1024 * 1024);
      const before = sent().length;
      expect(before).toBeLessThan(windows().length);
      // The client catches up: the latest text is delivered, once.
      ws.bufferedAmount = 0;
      await vi.waitFor(() => { expect(sent().length).toBe(before + 1); });
      expect(String(sent().at(-1).payload.text)).toBe(REPLY);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(sent().length).toBe(before + 1);
    } finally { ws.readyState = 3; ws.emit('close'); await h.close(); }
  });
});
