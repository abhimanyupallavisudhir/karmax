import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { stubGateway } from './helpers/stub-gateway.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { ProjectTransfers } from '../src/platform/project-transfer.js';

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

async function streamFixture(caps: string[], options: { ttlMs?: number; userId?: string } = {}) {
  const h = await stubGateway();
  (h.gateway as any).deps.authorization = await AuthorizationService.create(h.store);
  const project = await h.store.createProject('Visible');
  const other = await h.store.createProject('Hidden', {}, (await h.store.createOrganization({ name: 'Other', ownerUserId: 'someone' })).id);
  const visible = await h.store.createTask({ projectId: project.id, title: 'Visible', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
  const hidden = await h.store.createTask({ projectId: other.id, title: 'Hidden', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
  const minted = await h.tokens.mintPrincipal('user:viewer', caps, undefined, options.ttlMs ?? 60 * 60 * 1000, project.organizationId);
  vi.spyOn(h.gateway as any, 'socketAuth').mockResolvedValue({ apiToken: minted.token, ...(options.userId ? { userId: options.userId } : {}) });
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
  return { h, project, visible, hidden, minted, check, received, publish, disconnect };
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

/**
 * #396 review item 3: revocation, member removal and project transfer promise
 * to take effect at once, and a socket's reused decision must not outlive them.
 * Every committed write that can withdraw access moves this process's
 * authorization epoch; the TTL only bounds changes made by another replica.
 */
describe('withdrawn access reaches open sockets at once', () => {
  it('stops delivering the moment the socket token is revoked', async () => {
    const f = await streamFixture(['task:event:read']);
    try {
      await f.publish(f.visible.id, 2);
      await f.h.tokens.revoke(f.minted.token);
      await f.publish(f.visible.id, 3);
      expect(f.received()).toHaveLength(2);
    } finally { f.disconnect(); await f.h.close(); }
  });

  it('stops delivering the moment a member is removed from the organization', async () => {
    const f = await streamFixture([], { userId: 'member' });
    try {
      await f.h.store.setOrganizationMembership(f.project.organizationId!, 'member', 'member');
      await (f.h.gateway as any).deps.authorization.grant('user:owner', { principalId: 'user:member', scopeKey: `organization:${f.project.organizationId}`, profileId: 'viewer' });
      await f.publish(f.visible.id, 2);
      expect(f.received()).toHaveLength(2);
      await f.h.store.deprovisionOrganizationUser(f.project.organizationId!, 'member');
      await f.publish(f.visible.id, 3);
      expect(f.received()).toHaveLength(2);
    } finally { f.disconnect(); await f.h.close(); }
  });

  it('stops delivering the moment the project moves to another organization', async () => {
    const f = await streamFixture(['task:event:read']);
    try {
      await f.h.store.saveView(f.visible.id, { taskId: f.visible.id, stage: 'done', status: 'done', actions: [], state: {} } as any);
      await f.publish(f.visible.id, 2);
      const destination = await f.h.store.createOrganization({ name: 'Buyer', ownerUserId: 'buyer' });
      const transfers = new ProjectTransfers(f.h.store, { principal: 'user:owner', authorize: () => {}, workflowClosed: async () => true });
      const preview = await transfers.preview(f.project.id, destination.id);
      await transfers.move(f.project.id, destination.id, preview.id);
      await f.publish(f.visible.id, 3);
      expect(f.received()).toHaveLength(2);
    } finally { f.disconnect(); await f.h.close(); }
  });

  it('stops delivering the moment the identity session behind the socket is revoked', async () => {
    const f = await streamFixture(['task:event:read']);
    try {
      await f.publish(f.visible.id, 2);
      const record = await f.h.tokens.verify(f.minted.token);
      await f.h.store.revokeScopedToken({ tokenId: record!.id });
      await f.publish(f.visible.id, 3);
      expect(f.received()).toHaveLength(2);
    } finally { f.disconnect(); await f.h.close(); }
  });

  it('bounds a decision reused across replicas to five seconds', async () => {
    const f = await streamFixture(['task:event:read']);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await f.publish(f.visible.id, 1);
      f.check.mockClear();
      vi.setSystemTime(Date.now() + 5_001);
      await f.publish(f.visible.id, 1);
      expect(f.check).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); f.disconnect(); await f.h.close(); }
  });
});
