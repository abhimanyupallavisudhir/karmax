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

  it('an agent runs and installs tasks from the task store, and deletes a series to offer it again', async () => {
    const dev = await agent('developer');
    const maintainer = await agent('maintainer');
    const storeOf = async () => json(await dev.request('GET', `/api/projects/${projectId}/task-store`)).tasks;
    try {
      const listed = await storeOf();
      expect(listed.map((t: any) => t.id)).toEqual(['project-wiki', 'repair-github-workflow', 'build-planned-issues', 'triage-issues', 'chat-requests']);
      expect(Object.fromEntries(listed.map((t: any) => [t.id, t.repeatable]))).toEqual({ 'project-wiki': false, 'repair-github-workflow': true,
        'build-planned-issues': true, 'triage-issues': true, 'chat-requests': true });
      expect(Object.fromEntries(listed.map((t: any) => [t.id, t.missing]))).toEqual({ 'project-wiki': [], 'repair-github-workflow': ['github'],
        'build-planned-issues': ['github'], 'triage-issues': ['github'], 'chat-requests': ['chat'] });
      expect(listed[0].name).toBe('Auto-create project wiki (memories, skills, AGENTS.md)');

      // An ordinary task runs at once, as often as asked.
      const wiki = json(await dev.request('POST', `/api/projects/${projectId}/task-store/project-wiki`));
      const run = (await store.getTask(wiki.id))!;
      expect(run).toMatchObject({ title: 'Auto-create project wiki (memories, skills, AGENTS.md)', workflow: 'software-dev', params: { template: 'project-wiki' } });
      expect(run.params.draft).toBeFalsy();
      expect(run.params).not.toHaveProperty('repeatable');
      expect(String(run.params.prompt)).toContain('Migrate AGENTS.md, CLAUDE.md');
      expect(String(run.params.prompt)).toContain('"default" label');
      expect(String(run.params.prompt)).not.toContain('Queue');
      const again = json(await dev.request('POST', `/api/projects/${projectId}/task-store/project-wiki`));
      expect(again.id).not.toBe(wiki.id);
      expect((await storeOf()).find((t: any) => t.id === 'project-wiki').installed.sort()).toEqual([again.id, wiki.id].sort());

      // A repeatable one installs once; deleting it puts it back on offer.
      const installed = json(await dev.request('POST', `/api/projects/${projectId}/task-store/build-planned-issues`));
      const series = (await store.getTask(installed.id))!;
      expect(series).toMatchObject({ title: '#{{issue.number}} {{issue.title}}', params: { repeatable: true, template: 'build-planned-issues',
        triggerState: 'armed', triggers: [{ kind: 'event', type: 'github.issues.labeled', where: { 'label.name': 'planned' } }] } });
      expect(String(series.params.prompt)).toMatch(/comments on it reach you as messages/);
      const twice = await dev.request('POST', `/api/projects/${projectId}/task-store/build-planned-issues`).catch((error: Error) => error.message);
      expect(String(twice)).toMatch(/already has it/);
      expect((await storeOf()).find((t: any) => t.id === 'build-planned-issues').installed).toEqual([installed.id]);
      expect(json(await dev.request('DELETE', `/api/tasks/${installed.id}`))).toEqual({ ok: true });
      expect(await store.getTask(installed.id)).toBeFalsy();
      expect((await storeOf()).find((t: any) => t.id === 'build-planned-issues').installed).toEqual([]);
      const reinstalled = json(await dev.request('POST', `/api/projects/${projectId}/task-store/build-planned-issues`));

      expect((await storeOf()).find((t: any) => t.id === 'build-planned-issues').installed).toEqual([reinstalled.id]);
      // The store holds the platform's tasks only: nobody publishes into everyone's store.
      const published = await maintainer.request('POST', '/api/organizations/org_personal/task-store', { taskId: reinstalled.id, name: 'Ours' })
        .catch((error: Error) => error.message);
      expect(String(published)).toMatch(/not found|missing capability/);
      expect(await storeOf()).toHaveLength(5);
    } finally { dev.restore(); maintainer.restore(); }
  });

  it('deletes what never started a workflow of its own, and nothing that did', async () => {
    const a = await agent('developer');
    try {
      const armed = json(await a.call('create_task', { project_id: projectId, title: 'On alert', prompt: 'Look.',
        params: { triggers: [{ kind: 'event', type: 'pager.alert' }] } }));
      expect((await store.getTask(armed.id))!.params.triggerState).toBe('armed');
      expect(json(await a.request('DELETE', `/api/tasks/${armed.id}`))).toEqual({ ok: true });
      expect(await store.getTask(armed.id)).toBeFalsy();

      const started = json(await a.call('create_task', { project_id: projectId, title: 'Now', prompt: 'Go.' }));
      const refused = await a.request('DELETE', `/api/tasks/${started.id}`).catch((error: Error) => error.message);
      expect(String(refused)).toMatch(/cancel/);
      expect(await store.getTask(started.id)).toBeTruthy();
    } finally { a.restore(); }
  });

  it('an agent follows events for its own task, waits on one, and unfollows', async () => {
    const a = await agent('developer');
    try {
      const follow = json(await a.call('follow_events', { task_id: a.task.id, type: 'deploy.*', where: { env: 'prod' }, once: true }));
      expect(follow).toMatchObject({ taskId: a.task.id, type: 'deploy.*', where: { env: 'prod' }, once: true, id: expect.stringMatching(/^fol_/) });
      const bad = await a.call('follow_events', { task_id: a.task.id }).catch((error: Error) => error.message);
      expect(String(bad)).toMatch(/at least/);
      await a.call('follow_events', { task_id: a.task.id, subject: 'https://github.com/o/r/issues/1' });
      expect(json(await a.request('GET', `/api/tasks/${a.task.id}/follows`)).follows).toHaveLength(2);
      expect(json(await a.call('unfollow_events', { task_id: a.task.id, follow_id: follow.id }))).toEqual({ unfollowed: [follow.id] });
      expect(json(await a.call('unfollow_events', { task_id: a.task.id })).unfollowed).toHaveLength(1);
      expect(await store.taskFollows(a.task.id)).toEqual([]);
      // Another project's task is out of this token's reach.
      const elsewhere = await store.createTask({ projectId: (await store.createProject('Other')).id, title: 'X', workflow: 'software-dev',
        workflowVersion: '1.28.0', params: { prompt: 'p' } });
      const refused = await a.call('follow_events', { task_id: elsewhere.id, type: 'x.y' }).catch((error: Error) => error.message);
      expect(String(refused)).toMatch(/403|not allowed|missing|forbidden|scope/i);
    } finally { a.restore(); }
  });
});
