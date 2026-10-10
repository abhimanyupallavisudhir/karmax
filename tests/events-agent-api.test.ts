import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { turnPlatformRequest } from '../src/agent/platform-request.js';
import { DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';

/**
 * Everything the console does with events, an agent does with its task token
 * through the same API (project principle 2): webhooks, events, and triggers.
 */
describe('events through an agent\'s task token', () => {
  let dir: string, store: Store, tokens: TokenAuthority, base: string, close: () => Promise<void>, projectId: string;
  const caps = (level: string) => DEFAULT_AUTHORIZATION_PROFILES.find((profile) => profile.id === level)!.capabilities;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-agent-'));
    store = await Store.create(':memory:');
    tokens = new TokenAuthority(store);
    const worlds = new WorldRegistry();
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, broker });
    projectId = (await store.createProject('Agents')).id;
    const gateway = await Gateway.create({ store, tokens, worlds, client, api, broker, bus: new KarmaxBus(),
      contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: dir,
      agentInfo: { provider: 'mock', reason: 'agent api test' } });
    const running = await gateway.listen(await findFreePortFrom(49080));
    base = running.url;
    close = running.close;
  });
  afterAll(async () => { await close?.(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  /** An agent's tools, signed in as a task of `level` authority scoped to the project. */
  const agent = async (level: string) => {
    const task = await store.createTask({ projectId, title: 'Agent', workflow: 'software-dev', workflowVersion: '1.28.0', params: { prompt: 'p' } });
    const { token } = await tokens.mint({ taskId: task.id, profileId: 'do', role: 'do', principal: `task-agent:${task.id}`, projectId,
      ceiling: caps(level), grantorCaps: caps(level) });
    const previous = process.env.KARMAX_GATEWAY_URL;
    process.env.KARMAX_GATEWAY_URL = base;
    // The same client a turn's tools use, signed in with the task's token.
    const tools = platformToolHandlers({} as any, { platformRequest: (method: string, p: string, body?: unknown) =>
      turnPlatformRequest({ token, method, path: p, body }) } as any);
    const call = (name: string, args: Record<string, unknown>) => (tools as any)[name](args) as Promise<string>;
    return { task, call, request: (method: string, p: string, body?: unknown) => call('platform_request', { method, path: p, ...(body ? { body } : {}) }),
      restore: () => { process.env.KARMAX_GATEWAY_URL = previous; } };
  };
  const json = (text: string) => JSON.parse(text);

  it('a maintainer agent manages webhooks, reads what events did, and arms an event trigger', async () => {
    const a = await agent('maintainer');
    try {
      const created = json(await a.request('POST', `/api/projects/${projectId}/webhooks`, { name: 'Sentry', type: 'sentry.alert' }));
      expect(created).toMatchObject({ hook: { name: 'Sentry', type: 'sentry.alert' }, secret: expect.stringMatching(/^tvh_/) });
      const hookId = created.hook.id;
      expect(json(await a.request('PATCH', `/api/webhooks/${hookId}`, { name: 'Sentry prod' }))).toMatchObject({ name: 'Sentry prod' });
      const rotated = json(await a.request('POST', `/api/webhooks/${hookId}/rotate`));
      expect(rotated.secret).not.toBe(created.secret);
      const delivered = await fetch(`${base}/api/hooks/${hookId}`, { method: 'POST', headers: { authorization: `Bearer ${rotated.secret}` }, body: '{"level":"error"}' });
      expect(delivered.status).toBe(202);

      const emitted = json(await a.call('emit_event', { project_id: projectId, type: 'orders.created', key: 'o-1', payload: { id: 1 } }));
      expect(emitted.event).toMatchObject({ source: `task:${a.task.id}`, origin: 'task' });
      const events = json(await a.request('GET', `/api/projects/${projectId}/events`));
      expect(events.map((e: any) => e.type).sort()).toEqual(['orders.created', 'sentry.alert']);
      expect(json(await a.request('GET', `/api/project-events/${events[0].id}`))).toMatchObject({ id: events[0].id, claims: [] });

      const series = json(await a.call('create_task', { project_id: projectId, title: 'Fix {{title}}', prompt: 'Investigate.', draft: true,
        params: { repeatable: true, triggers: [{ kind: 'event', type: 'sentry.alert', where: { level: 'error' }, recurring: true }] } }));
      expect((await store.getTask(series.id))!.params.triggers).toMatchObject([{ type: 'sentry.alert', where: { level: 'error' } }]);
      // A draft may be unfinished; arming it is where a bad trigger is refused.
      const bad = await a.call('create_task', { project_id: projectId, title: 'Bad', prompt: 'x',
        params: { triggers: [{ kind: 'event', type: 'not a type' }] } }).catch((error: Error) => error.message);
      expect(String(bad)).toMatch(/invalid event type/);

      expect(json(await a.request('DELETE', `/api/webhooks/${hookId}`))).toEqual({ deleted: true });
      expect(json(await a.request('GET', `/api/projects/${projectId}/webhooks`)).webhooks).toEqual([]);
    } finally { a.restore(); }
  });

  it('a developer agent emits and reads events but cannot change the project\'s webhooks', async () => {
    const a = await agent('developer');
    try {
      expect(json(await a.call('emit_event', { project_id: projectId, type: 'feed.item', key: 'i-1' }))).toMatchObject({ duplicate: false });
      expect(json(await a.request('GET', `/api/projects/${projectId}/events?type=feed.*`))).toHaveLength(1);
      const refused = await a.request('POST', `/api/projects/${projectId}/webhooks`, { name: 'Nope' }).catch((error: Error) => error.message);
      expect(String(refused)).toMatch(/project:settings:write/);
    } finally { a.restore(); }
  });
});
