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
      expect(Object.fromEntries(listed.map((t: any) => [t.id, t.repeatable]))).toEqual({ 'project-wiki': true, 'repair-github-workflow': true,
        'build-planned-issues': true, 'triage-issues': true, 'chat-requests': true });
      expect(Object.fromEntries(listed.map((t: any) => [t.id, t.missing]))).toEqual({ 'project-wiki': [], 'repair-github-workflow': ['github'],
        'build-planned-issues': ['github'], 'triage-issues': ['github'], 'chat-requests': ['chat'] });
      expect(listed[0]).toMatchObject({ name: 'Maintain the project wiki', runOnInstall: true });

      // The wiki keeps itself current: installing it writes the wiki now, then weekly.
      const runsOf = async (seriesId: string) => (await store.listTasks(projectId)).filter((task) => task.params?.runOf === seriesId);
      const wiki = json(await dev.request('POST', `/api/projects/${projectId}/task-store/project-wiki`));
      const wikiSeries = (await store.getTask(wiki.id))!;
      expect(wikiSeries).toMatchObject({ title: 'Maintain the project wiki', workflow: 'software-dev', params: { template: 'project-wiki', repeatable: true,
        triggerState: 'armed', triggers: [{ kind: 'schedule', cron: '0 6 * * 1', recurring: true }] } });
      const [first, ...more] = await runsOf(wiki.id);
      expect(more).toEqual([]);
      expect(first).toMatchObject({ title: 'Maintain the project wiki', params: { template: 'project-wiki', runOf: wiki.id } });
      expect(String(first!.params.prompt)).toContain('Migrate AGENTS.md, CLAUDE.md');
      expect(String(first!.params.prompt)).toMatch(/Otherwise keep it current/);
      expect(String(first!.params.prompt)).toContain('"default" label');
      expect(String(first!.params.prompt)).not.toContain('Queue');
      // Installed is the series, not its runs; saving it again starts nothing.
      expect((await storeOf()).find((t: any) => t.id === 'project-wiki').installed).toEqual([wiki.id]);
      json(await dev.request('PATCH', `/api/tasks/${wiki.id}/params`, { replace: true, keepArmed: true,
        params: { ...wikiSeries.params, prompt: 'Keep the API pages current.' } }));
      expect(await runsOf(wiki.id)).toHaveLength(1);
      for (const run of await runsOf(wiki.id)) await store.deleteTask(run.id);
      expect(json(await dev.request('DELETE', `/api/tasks/${wiki.id}`))).toEqual({ ok: true });

      // A repeatable one installs as often as asked; deleting its series takes it back.
      const installed = json(await dev.request('POST', `/api/projects/${projectId}/task-store/build-planned-issues`));
      const series = (await store.getTask(installed.id))!;
      expect(series).toMatchObject({ title: '#{{issue.number}} {{issue.title}}', params: { repeatable: true, template: 'build-planned-issues',
        triggerState: 'armed', triggers: [{ kind: 'event', type: 'github.issues.labeled', where: { 'label.name': 'planned' } }] } });
      expect(String(series.params.prompt)).toMatch(/comments on it reach you as messages/);
      const twice = json(await dev.request('POST', `/api/projects/${projectId}/task-store/build-planned-issues`));
      expect((await storeOf()).find((t: any) => t.id === 'build-planned-issues').installed.sort()).toEqual([installed.id, twice.id].sort());
      expect(json(await dev.request('DELETE', `/api/tasks/${twice.id}`))).toEqual({ ok: true });
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

  it('takes a store task as changed, by its endpoint or as an ordinary task, a series per install', async () => {
    const dev = await agent('developer');
    const storeOf = async () => json(await dev.request('GET', `/api/projects/${projectId}/task-store`)).tasks;
    const installedOf = async (id: string) => (await storeOf()).find((t: any) => t.id === id).installed;
    const created: string[] = [];
    for (const id of await installedOf('build-planned-issues')) await store.deleteTask(id);
    try {
      // The endpoint takes createTask's fields; params override the store's field by field.
      const triage = json(await dev.request('POST', `/api/projects/${projectId}/task-store/triage-issues`, {
        params: { prompt: 'Triage only bug reports.', triggers: [{ kind: 'schedule', cron: '0 6 * * 1', recurring: true }] } }));
      created.push(triage.id);
      expect((await store.getTask(triage.id))!).toMatchObject({ title: 'Triage GitHub issues', params: { template: 'triage-issues', repeatable: true,
        prompt: 'Triage only bug reports.', triggerState: 'armed', triggers: [{ kind: 'schedule', cron: '0 6 * * 1' }] } });
      const runsOf = async (seriesId: string) => (await store.listTasks(projectId)).filter((task) => task.params?.runOf === seriesId);
      expect(await runsOf(triage.id)).toEqual([]);

      // The wiki from the task form, kept as a draft first: running the draft
      // installs it, and installing it starts its first run.
      const wikiDraft = json(await dev.request('POST', `/api/projects/${projectId}/tasks`, { title: 'Maintain the project wiki', draft: true,
        params: { prompt: 'Keep it short.', repeatable: true, template: 'project-wiki', triggers: [{ kind: 'schedule', cron: '0 6 * * 1', recurring: true }] } }));
      created.push(wikiDraft.id);
      expect(await runsOf(wikiDraft.id)).toEqual([]);
      json(await dev.request('POST', `/api/tasks/${wikiDraft.id}/queue`, {}));
      const wikiRuns = await runsOf(wikiDraft.id);
      created.push(...wikiRuns.map((run) => run.id));
      expect(wikiRuns.map((run) => run.params.prompt)).toEqual(['Keep it short.']);
      expect(await installedOf('project-wiki')).toEqual([wikiDraft.id]);

      // The task form creates it as an ordinary task naming its store entry: a draft
      // is not taken yet; running it installs it; another (say, for another label)
      // is a series of its own.
      const form = (draft: boolean) => dev.request('POST', `/api/projects/${projectId}/tasks`, { title: '#{{issue.number}} {{issue.title}}', draft,
        params: { prompt: 'Build it small.', repeatable: true, template: 'build-planned-issues',
          triggers: [{ kind: 'event', type: 'github.issues.labeled', where: { 'label.name': 'ready' }, recurring: true }] } });
      const draft = json(await form(true));
      created.push(draft.id);
      expect(await installedOf('build-planned-issues')).toEqual([]);
      // Editing the draft keeps its store entry and its run title.
      json(await dev.request('PATCH', `/api/tasks/${draft.id}/params`, { replace: true,
        params: { prompt: 'Build it smaller.', repeatable: true, triggers: [{ kind: 'event', type: 'github.issues.labeled', where: { 'label.name': 'ready' }, recurring: true }] } }));
      expect((await store.getTask(draft.id))!).toMatchObject({ title: '#{{issue.number}} {{issue.title}}', params: { template: 'build-planned-issues', prompt: 'Build it smaller.' } });
      const other = json(await form(true));
      created.push(other.id);
      json(await dev.request('POST', `/api/tasks/${draft.id}/queue`, {}));
      expect(await installedOf('build-planned-issues')).toEqual([draft.id]);
      json(await dev.request('POST', `/api/tasks/${other.id}/queue`, {}));
      const third = json(await form(false));
      created.push(third.id);
      expect((await installedOf('build-planned-issues')).sort()).toEqual([draft.id, other.id, third.id].sort());
      // The installed series edits like any other, still the store's.
      json(await dev.request('PATCH', `/api/tasks/${draft.id}/params`, { replace: true,
        params: { prompt: 'Build it.', repeatable: true, triggers: [{ kind: 'event', type: 'github.issues.labeled', where: { 'label.name': 'ready' }, recurring: true }] } }));
      expect((await store.getTask(draft.id))!).toMatchObject({ title: '#{{issue.number}} {{issue.title}}', params: { template: 'build-planned-issues', triggerState: 'armed' } });
      expect(await installedOf('build-planned-issues')).toContain(draft.id);
      // A title derived from the prompt still follows it.
      const plain = json(await dev.request('POST', `/api/projects/${projectId}/tasks`, { draft: true, params: { prompt: 'First words' } }));
      created.push(plain.id);
      json(await dev.request('PATCH', `/api/tasks/${plain.id}/params`, { replace: true, params: { prompt: 'Second words' } }));
      expect((await store.getTask(plain.id))!.title).toBe('Second words');
    } finally {
      for (const id of created) await store.deleteTask(id);
      dev.restore();
    }
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
