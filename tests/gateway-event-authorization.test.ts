import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { stubGateway } from './helpers/stub-gateway.js';

/**
 * LT-15: every event used to re-verify the socket's token (several store reads)
 * and, on refusal, re-derive the human's capabilities — once per event per
 * socket. A streaming agent publishes several events a second, so the decision
 * is now made once per task and reused until the token expires (bounded, so a
 * revocation still takes effect).
 */

function socket() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 });
  return { ws, disconnect() { ws.readyState = 3; ws.emit('close'); } };
}

async function streamFixture(caps: string[], options: { ttlMs?: number } = {}) {
  const h = await stubGateway();
  const project = await h.store.createProject('Visible');
  const other = await h.store.createProject('Hidden', {}, (await h.store.createOrganization({ name: 'Other', ownerUserId: 'someone' })).id);
  const visible = await h.store.createTask({ projectId: project.id, title: 'Visible', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
  const hidden = await h.store.createTask({ projectId: other.id, title: 'Hidden', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
  const minted = await h.tokens.mintPrincipal('user:viewer', caps, undefined, options.ttlMs ?? 60 * 60 * 1000, project.organizationId);
  vi.spyOn(h.gateway as any, 'socketAuth').mockResolvedValue({ apiToken: minted.token });
  const check = vi.spyOn(h.tokens, 'check');
  const { ws, disconnect } = socket();
  await (h.gateway as any).eventStream(ws, { headers: {}, url: '/ws' });
  const received = () => ws.send.mock.calls.map(([data]) => JSON.parse(String(data))).filter((ev) => ev.type === 'agent.output');
  const publish = async (taskId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const event = { taskId, type: 'agent.output', ts: Date.now(), payload: { text: `chunk ${i}`, source: 'assistant' } };
      const seq = await h.store.appendEvent(event);
      (h.gateway as any).deps.bus.emit({ ...event, seq });
    }
    await vi.waitFor(async () => { expect(await h.store.latestEventSeq()).toBeGreaterThan(0); });
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  return { h, visible, hidden, check, received, publish, disconnect };
}

it('authorizes a task once per socket, not once per event', async () => {
  const f = await streamFixture(['task:event:read']);
  try {
    f.check.mockClear();
    await f.publish(f.visible.id, 25);
    expect(f.received()).toHaveLength(25);
    expect(f.check).toHaveBeenCalledTimes(1);
  } finally { f.disconnect(); await f.h.close(); }
});

it('keeps refusing events the socket may not read, without re-deciding each one', async () => {
  const f = await streamFixture(['task:event:read']);
  try {
    f.check.mockClear();
    await f.publish(f.hidden.id, 10);
    await f.publish(f.visible.id, 3);
    expect(f.received().map((ev) => ev.taskId)).toEqual([f.visible.id, f.visible.id, f.visible.id]);
    expect(f.check).toHaveBeenCalledTimes(2);
  } finally { f.disconnect(); await f.h.close(); }
});

it('decides again once the token has expired, and stops delivering', async () => {
  const f = await streamFixture(['task:event:read'], { ttlMs: 400 });
  try {
    await f.publish(f.visible.id, 2);
    expect(f.received()).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 450));
    f.check.mockClear();
    await f.publish(f.visible.id, 3);
    expect(f.received()).toHaveLength(2);
    expect(f.check).toHaveBeenCalled();
  } finally { f.disconnect(); await f.h.close(); }
});
