import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { stubGateway } from './helpers/stub-gateway.js';
import { AuthorizationService } from '../src/platform/authorization.js';

/**
 * Load test 2026-10 (benchmarks/results/load-report-2026-10.md), the first
 * wall at 64 tenants: every agent turn revokes its token, that moved one
 * installation-wide epoch, and every open event socket then re-derived its
 * person's access and re-decided every tenant's events. A revoked token now
 * closes only the connections authenticated with it, a person's socket
 * re-checks only when their own access changes, and a socket is offered only
 * its organizations' events.
 */
function socket() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, CLOSED: 3, send: vi.fn(), bufferedAmount: 0,
    close: vi.fn(function (this: any) { this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }),
    terminate: vi.fn(function (this: any) { this.readyState = 3; this.emit('close', 1006, Buffer.from('')); }) });
  return ws as any;
}
const closedWith = (ws: any) => ws.close.mock.calls[0]?.[0];
const outputs = (ws: any) => ws.send.mock.calls.map(([data]: any) => JSON.parse(String(data))).filter((ev: any) => ev.type === 'agent.output');

async function tenants() {
  const h = await stubGateway();
  const gateway = h.gateway as any;
  const authorization = gateway.deps.authorization = await AuthorizationService.create(h.store);
  const live = new Set(['alice-browser', 'bob-browser']);
  h.tokens.connectIdentitySessions(async (sessionId: string) => live.has(sessionId));
  const tenant = async (name: string) => {
    const org = await h.store.createOrganization({ name, ownerUserId: name });
    const project = await h.store.createProject(`${name} app`, {}, org.id);
    const task = await h.store.createTask({ projectId: project.id, title: name, workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
    await h.store.setProjectMembership(project.id, { kind: 'user', userId: name }, 'viewer');
    const browserToken = (await h.tokens.mintPrincipal(`user:${name}`, ['task:event:read'], undefined, 10 * 60_000, org.id)).token;
    return { org, project, task, session: { user: name, userId: name, apiToken: browserToken, identitySessionId: `${name}-browser` } };
  };
  const alice = await tenant('alice'), bob = await tenant('bob');
  let next: any;
  vi.spyOn(gateway, 'socketAuth').mockImplementation(async () => next);
  const connect = async (session: unknown) => {
    next = session;
    const ws = socket();
    await gateway.eventStream(ws, { headers: {}, url: '/ws' });
    return ws;
  };
  const publish = async (taskId: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      const event = { taskId, type: 'agent.output', ts: Date.now(), payload: { text: `chunk ${i}`, source: 'assistant' } };
      gateway.deps.bus.emit({ ...event, seq: await h.store.appendEvent(event) });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  // An agent turn in Alice's organization: its token is minted at the start
  // and revoked at the end (src/activities/core.ts).
  const turn = () => h.tokens.mint({ taskId: alice.task.id, profileId: 'mock', principal: 'user:alice', projectId: alice.project.id,
    organizationId: alice.org.id, ceiling: ['task:event:read', 'task:read'], grantorCaps: ['task:event:read', 'task:read'] });
  return { h, gateway, authorization, alice, bob, live, connect, publish, turn };
}

describe('a revoked token closes only what it authenticated', () => {
  it('(a) closes the revoked token’s own socket at once', async () => {
    const t = await tenants();
    try {
      const agent = await turn(t);
      const ws = await t.connect({ user: 'user:alice', apiToken: agent.token });
      await t.publish(t.alice.task.id);
      expect(outputs(ws)).toHaveLength(1);
      await t.h.tokens.revoke(agent.token);
      await vi.waitFor(() => expect(closedWith(ws)).toBe(4401), { timeout: 1_500 });
      await t.publish(t.alice.task.id);
      expect(outputs(ws)).toHaveLength(1);
    } finally { await t.h.close(); }
  });

  it('(a) closes a socket whose token was revoked through its parent', async () => {
    const t = await tenants();
    try {
      const parent = await turn(t);
      const child = await t.h.tokens.mint({ taskId: t.alice.task.id, profileId: 'mock', principal: 'user:alice', projectId: t.alice.project.id,
        organizationId: t.alice.org.id, ceiling: ['task:event:read'], grantorCaps: ['task:event:read'], parentTokenId: parent.record.id });
      const ws = await t.connect({ user: 'user:alice', apiToken: child.token });
      await t.h.tokens.revoke(parent.token);
      await vi.waitFor(() => expect(closedWith(ws)).toBe(4401), { timeout: 1_500 });
    } finally { await t.h.close(); }
  });

  it('(a) closes a socket whose token another process revoked within the five-second bound', async () => {
    const t = await tenants();
    try {
      const agent = await turn(t);
      const ws = await t.connect({ user: 'user:alice', apiToken: agent.token });
      // Another process's write: this one hears nothing about it.
      vi.spyOn(t.h.store, 'getScopedToken').mockResolvedValue(undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(ws.close).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(closedWith(ws)).toBe(4401), { timeout: 6_000 });
    } finally { await t.h.close(); }
  }, 10_000);

  it('(a) closes a person’s socket when their browser session signs out', async () => {
    const t = await tenants();
    try {
      const ws = await t.connect(t.alice.session);
      t.live.delete('alice-browser');
      // As the identity service's sign-out hook announces it (connectSessionRevocation).
      const { authorityChanged } = await import('../src/store/authorization-epoch.js');
      authorityChanged({ principals: ['user:alice'] });
      await vi.waitFor(() => expect(closedWith(ws)).toBe(4401), { timeout: 1_500 });
    } finally { await t.h.close(); }
  });

  it('(b) does not re-check another person’s socket when an agent token is revoked', async () => {
    const t = await tenants();
    try {
      const bob = await t.connect(t.bob.session);
      const alice = await t.connect(t.alice.session);
      await t.publish(t.bob.task.id);
      await t.publish(t.alice.task.id);
      expect(outputs(bob)).toHaveLength(1);
      expect(outputs(alice)).toHaveLength(1);
      const derive = vi.spyOn(t.authorization, 'capabilitiesAsync');
      const sessions = vi.spyOn(t.h.tokens, 'identitySessionLive');
      const verify = vi.spyOn(t.h.tokens, 'verify');
      for (let i = 0; i < 5; i++) {
        const agent = await turn(t);
        await t.publish(t.alice.task.id);
        await t.h.tokens.revoke(agent.token);
        await t.publish(t.bob.task.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(outputs(bob)).toHaveLength(6);
      expect(outputs(alice)).toHaveLength(6);
      // Neither person's access nor session was looked up again: the agent's
      // token is not what their sockets stand on.
      expect(derive).not.toHaveBeenCalled();
      expect(sessions).not.toHaveBeenCalled();
      expect(verify.mock.calls.filter(([token]) => token === t.alice.session.apiToken || token === t.bob.session.apiToken)).toEqual([]);
      bob.close(); alice.close();
    } finally { await t.h.close(); }
  });

  it('(b) never offers a socket another tenant’s events', async () => {
    const t = await tenants();
    try {
      const bob = await t.connect(t.bob.session);
      const derive = vi.spyOn(t.authorization, 'capabilitiesAsync');
      await t.publish(t.alice.task.id, 5);
      expect(outputs(bob)).toEqual([]);
      expect(derive.mock.calls.filter(([, projectId]) => projectId === t.alice.project.id)).toEqual([]);
      bob.close();
    } finally { await t.h.close(); }
  });

  it('(c) stops delivering to a person at once when their membership is removed', async () => {
    const t = await tenants();
    try {
      const alice = await t.connect(t.alice.session);
      await t.publish(t.alice.task.id, 2);
      expect(outputs(alice)).toHaveLength(2);
      await t.h.store.removeProjectMembership(t.alice.project.id, { kind: 'user', userId: 'alice' });
      await t.publish(t.alice.task.id, 3);
      expect(outputs(alice)).toHaveLength(2);
      alice.close();
    } finally { await t.h.close(); }
  });

  it('(c) starts delivering a newly joined organization’s events', async () => {
    const t = await tenants();
    try {
      const bob = await t.connect(t.bob.session);
      await t.publish(t.alice.task.id);
      expect(outputs(bob)).toEqual([]);
      await t.h.store.setOrganizationMembership(t.alice.org.id, 'bob', 'member');
      await t.h.store.setProjectMembership(t.alice.project.id, { kind: 'user', userId: 'bob' }, 'viewer');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await t.publish(t.alice.task.id);
      expect(outputs(bob)).toHaveLength(1);
      bob.close();
    } finally { await t.h.close(); }
  });
});

const turn = (t: Awaited<ReturnType<typeof tenants>>) => t.turn();
