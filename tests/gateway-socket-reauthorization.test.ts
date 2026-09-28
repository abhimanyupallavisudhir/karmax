import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { stubGateway } from './helpers/stub-gateway.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { authorizationChanged } from '../src/store/authorization-epoch.js';

/**
 * #367 review item 12: the terminal, review-action and preview sockets checked
 * authorization only when they connected, so a revoked or removed person kept
 * a live shell. Each re-decides as the event stream does: at once when this
 * process commits a change that can withdraw access, and every few seconds for
 * changes another replica made.
 */
function socket() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: vi.fn(), bufferedAmount: 0,
    close: vi.fn(function (this: any) { this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }) });
  return ws as any;
}
const closedWith = (ws: any) => ws.close.mock.calls[0]?.[0];

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  const h = await stubGateway();
  const gateway = h.gateway as any;
  const project = await h.store.createProject('Shell');
  const task = await h.store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
  const minted = await h.tokens.mintPrincipal('user:dev', ['task:edit', 'task:review:execute', 'task:read'], project.id, 60 * 60_000, project.organizationId);
  let session: any = { user: 'dev', apiToken: minted.token };
  vi.spyOn(gateway, 'socketAuth').mockImplementation(async () => session);
  vi.spyOn(gateway, 'auth').mockImplementation(async () => session);
  return { h, gateway, project, task, minted, signOut: () => { session = undefined; } };
}

describe('a long-lived socket loses access with its principal', () => {
  it('closes a terminal when its session ends', async () => {
    const f = await fixture();
    try {
      const handle = { id: f.task.id, kind: 'memory', root: '/tmp', branch: 'b', base: 'main' };
      await f.h.store.saveView(f.task.id, { taskId: f.task.id, stage: 'do', status: 'active', actions: [], state: {}, world: handle } as any);
      const pty = { pid: undefined, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), close: vi.fn(async () => {}) };
      f.gateway.deps.worlds = { get: () => ({ capabilities: {} }), open: async () => ({ handle, openPty: async () => pty }) };
      const ws = socket();
      await f.gateway.terminal(ws, { headers: {}, url: `/ws/terminal?taskId=${f.task.id}` });
      expect(ws.close).not.toHaveBeenCalled();
      authorizationChanged();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ws.close).not.toHaveBeenCalled();
      f.signOut();
      authorizationChanged();
      await vi.waitFor(() => expect(closedWith(ws)).toBe(4403));
      await vi.waitFor(() => expect(pty.close).toHaveBeenCalled());
    } finally { await f.h.close(); }
  });

  it('closes a review-action stream when its token is revoked', async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.gateway.reviewActions, 'status').mockResolvedValue({ taskId: f.task.id, running: true, output: '' });
      const off = vi.fn();
      vi.spyOn(f.gateway.reviewActions, 'attach').mockResolvedValue(off);
      const ws = socket();
      await f.gateway.reviewActionStream(ws, { headers: {}, url: '/ws/review-action?procId=p' });
      expect(ws.close).not.toHaveBeenCalled();
      await f.h.tokens.revoke(f.minted.token); // an authority write: this process's epoch moves
      await vi.waitFor(() => expect(closedWith(ws)).toBe(4403));
      await vi.waitFor(() => expect(off).toHaveBeenCalled());
    } finally { await f.h.close(); }
  });

  it('closes a preview socket when its lease is revoked', async () => {
    const f = await fixture();
    const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => upstream.once('listening', resolve));
    try {
      const handle = { id: 'w', kind: 'e2b', root: '/app', branch: 'task', base: 'main' };
      let lease: any = { id: 'lease', worldId: 'w', taskId: f.task.id, projectId: f.project.id, generation: 1, port: 3000, expiresAt: Date.now() + 60_000 };
      vi.spyOn(f.h.store, 'previewLease').mockImplementation(async () => lease);
      vi.spyOn(f.h.store, 'currentWorld').mockResolvedValue({ ...handle, generation: 1 } as any);
      vi.spyOn(f.h.store, 'getTask').mockResolvedValue({ id: f.task.id, projectId: f.project.id, lastView: { world: handle } } as any);
      vi.spyOn(f.h.store, 'effectiveProjectConfig').mockResolvedValue({} as any);
      const url = `ws://127.0.0.1:${(upstream.address() as any).port}`;
      f.gateway.deps.worldAccess = { open: async () => ({ release: async () => {}, world: { previewSocketTarget: async () => ({ url }) } }) };
      const ws = socket();
      await f.gateway.previewWebSocket(ws, { headers: {}, url: '/preview/lease/' });
      expect(ws.close).not.toHaveBeenCalled();
      lease = { ...lease, revokedAt: Date.now() };
      authorizationChanged(); // as revokePreviewLease's write does
      await vi.waitFor(() => expect(closedWith(ws)).toBe(4403));
    } finally { upstream.close(); await f.h.close(); }
  });
});

// GW-13 follow-up: a person's decisions do not depend on the socket token, so
// they must not all expire with it and be re-derived for every event after.
it('keeps a person’s event decisions for the TTL after the socket token expires', async () => {
  const h = await stubGateway();
  try {
    const gateway = h.gateway as any;
    gateway.deps.authorization = await AuthorizationService.create(h.store);
    const project = await h.store.createProject('Visible');
    const task = await h.store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
    await h.store.setOrganizationMembership(project.organizationId!, 'member', 'member');
    await gateway.deps.authorization.grant('user:owner', { principalId: 'user:member', scopeKey: `organization:${project.organizationId}`, profileId: 'viewer' });
    const minted = await h.tokens.mintPrincipal('user:member', ['task:event:read'], undefined, 300, project.organizationId);
    vi.spyOn(gateway, 'socketAuth').mockResolvedValue({ apiToken: minted.token, userId: 'member' });
    const ws = socket();
    await gateway.eventStream(ws, { headers: {}, url: '/ws' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const derive = vi.spyOn(gateway.deps.authorization, 'capabilitiesAsync');
    for (let i = 0; i < 10; i++) {
      const event = { taskId: task.id, type: 'agent.output', ts: Date.now(), payload: { text: `chunk ${i}`, source: 'assistant' } };
      gateway.deps.bus.emit({ ...event, seq: await h.store.appendEvent(event) });
    }
    await vi.waitFor(() => expect(ws.send.mock.calls.filter(([data]: any) => JSON.parse(data).type === 'agent.output')).toHaveLength(10));
    expect(derive.mock.calls.length).toBeLessThanOrEqual(1);
    ws.close();
  } finally { await h.close(); }
});
