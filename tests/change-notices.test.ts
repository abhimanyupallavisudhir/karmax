import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { stubGateway } from './helpers/stub-gateway.js';
import { changeNoticeFor, writtenScope } from '../src/gateway/change-notices.js';

/**
 * Most writes record no task event (archiving, tags, priority, notes, reading an
 * inbox ask), so nothing told another tab, a phone or a colleague's page that
 * they happened: it showed the old state until a reload. Every request that
 * writes now tells the connections of whoever may read what it addressed.
 */
describe('which requests give a notice', () => {
  const scope = { organizationId: 'o', projectId: 'p', taskId: 't' };
  const base = { method: 'POST', path: '/api/tasks/t/archive', status: 200, capability: 'task:edit', scope };

  it('a write names the task, project and organization it addressed, and its area', () => {
    expect(changeNoticeFor(base)).toEqual({ area: 'task', organizationId: 'o', projectId: 'p', taskId: 't' });
    expect(changeNoticeFor({ ...base, path: '/api/projects/p/tags', capability: 'task:edit', scope: { organizationId: 'o', projectId: 'p' } }))
      .toEqual({ area: 'task', organizationId: 'o', projectId: 'p' });
    expect(changeNoticeFor({ ...base, client: 'tab_12345678' })?.client).toBe('tab_12345678');
    expect(changeNoticeFor({ ...base, client: ['a', 'b'] })?.client).toBeUndefined();
  });

  it('a read, a refused or failed request, and a read made with POST give none', () => {
    expect(changeNoticeFor({ ...base, method: 'GET' })).toBeUndefined();
    expect(changeNoticeFor({ ...base, status: 403 })).toBeUndefined();
    expect(changeNoticeFor({ ...base, status: 500 })).toBeUndefined();
    expect(changeNoticeFor({ ...base, path: '/api/vault/resolve', capability: 'credential:read' })).toBeUndefined();
    // Rendering a Review asks for signed file URLs with a POST.
    expect(changeNoticeFor({ ...base, path: '/api/tasks/t/review-action', capability: 'task:review:execute' })).toBeUndefined();
    // A write that names no organization, made by nobody in particular.
    expect(changeNoticeFor({ ...base, path: '/api/settings/global/appearance', capability: 'settings:write', scope: {} })).toBeUndefined();
  });

  it("a person's own state is theirs alone", () => {
    expect(changeNoticeFor({ method: 'PATCH', path: '/api/inbox', status: 200, capability: 'inbox:write',
      scope: { organizationId: 'o' }, userId: 'ana' })).toEqual({ area: 'inbox', personal: 'ana', organizationId: 'o' });
    expect(changeNoticeFor({ method: 'PUT', path: '/api/user/default-organization', status: 200, capability: 'none',
      scope: {}, userId: 'ana' })).toEqual({ area: 'user', personal: 'ana' });
    expect(changeNoticeFor({ method: 'PATCH', path: '/api/inbox', status: 200, capability: 'inbox:write', scope: { organizationId: 'o' } })).toBeUndefined();
    // An organization they just made is in no organization yet: their other tabs list it.
    expect(changeNoticeFor({ method: 'POST', path: '/api/organizations', status: 200, capability: 'organization:create', scope: {}, userId: 'ana' }))
      .toEqual({ area: 'organization', personal: 'ana' });
  });
});

describe('what a write addressed', () => {
  const store = { taskProjectIdAsync: async (taskId: string) => (taskId === 't' ? 'p' : undefined), projectOrganizationAsync: async () => 'o' };

  it("is the record in its route; an agent's write that names none is about its own task", async () => {
    expect(await writtenScope({ organizationId: 'o', projectId: 'p', taskId: 'other' }, { kind: 'agent', taskId: 't' }, store))
      .toEqual({ organizationId: 'o', projectId: 'p', taskId: 'other' });
    expect(await writtenScope({}, { kind: 'agent', taskId: 't' }, store)).toEqual({ organizationId: 'o', projectId: 'p', taskId: 't' });
    // A project named without a task (a task created elsewhere) is not this agent's task.
    expect(await writtenScope({ organizationId: 'o', projectId: 'q' }, { kind: 'agent', taskId: 't' }, store)).toEqual({ organizationId: 'o', projectId: 'q' });
    expect(await writtenScope({}, { kind: 'human', taskId: '*' }, store)).toEqual({});
    expect(await writtenScope({}, { kind: 'agent', taskId: 'gone' }, store)).toEqual({});
  });
});

describe('the live stream carries them', () => {
  async function fixture() {
    const h = await stubGateway();
    const organization = await h.store.createOrganization({ name: 'Team', ownerUserId: 'ana' });
    const elsewhere = await h.store.createOrganization({ name: 'Elsewhere', ownerUserId: 'eve' });
    const project = await h.store.createProject('App', {}, organization.id);
    const task = await h.store.createTask({ projectId: project.id, title: 'Ship it', workflow: 'just-do', workflowVersion: '1.0.0',
      params: {} as any, createdBy: { kind: 'user', userId: 'ana' } });
    // A person signed in from an app (a CLI login): this fixture has no sign-in service for a browser session.
    const mint = async (user: string, organizationId: string) => {
      const { token, record } = await h.tokens.mintPrincipal(`user:${user}`, ['*'], undefined, 60 * 60 * 1000, organizationId);
      await h.store.putScopedToken(crypto.createHash('sha256').update(token).digest('hex'), record.id, { ...record,
        actor: { kind: 'autonomous', principal: `user:${user}` }, humanSubject: { kind: 'user', userId: user, presence: 'delegated' } } as any,
      record.expiresAt);
      return token;
    };
    const sockets: WebSocket[] = [];
    const listen = async (token: string, client?: string) => {
      const ws = new WebSocket(`${h.base.replace('http:', 'ws:')}/ws${client ? `?client=${client}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
      sockets.push(ws);
      const heard: any[] = [];
      ws.on('message', (data) => { const message = JSON.parse(String(data)); if (message.type === 'changed') heard.push(message); });
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      // Subscribed once the gateway has answered a ping (its handlers attach after its reads).
      await new Promise<void>((resolve) => {
        const ping = setInterval(() => ws.send('{"type":"ping"}'), 20);
        ws.on('message', function pong(data) { if (String(data).includes('pong')) { clearInterval(ping); ws.off('message', pong); resolve(); } });
      });
      return heard;
    };
    const request = (token: string, method: string, path: string, body?: unknown, client?: string) => fetch(`${h.base}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(client ? { 'x-tavya-client': client } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
    return { h, organization, elsewhere, project, task, mint, listen, request, settle,
      async close() { for (const ws of sockets) ws.terminate(); await h.close(); } };
  }

  it('a write reaches every connection that may read it, except the tab that made it', async () => {
    const f = await fixture();
    try {
      const ana = await f.mint('ana', f.organization.id), ben = await f.mint('ben', f.organization.id), eve = await f.mint('eve', f.elsewhere.id);
      const [acting, otherTab, colleague, outsider] = [await f.listen(ana, 'tab_acting01'), await f.listen(ana, 'tab_other001'), await f.listen(ben), await f.listen(eve)];
      expect((await f.request(ana, 'POST', `/api/tasks/${f.task.id}/archive`, { archived: true }, 'tab_acting01')).status).toBe(200);
      await expect.poll(() => otherTab).toEqual([{ type: 'changed', area: 'task', organizationId: f.organization.id, projectId: f.project.id, taskId: f.task.id }]);
      await expect.poll(() => colleague.length).toBe(1);
      await f.settle();
      expect(acting).toEqual([]);
      expect(outsider).toEqual([]);
      expect((await f.h.store.getTask(f.task.id))?.params.archived).toBe(true);

      // A read tells nobody, and neither does a write that was refused.
      await f.request(ana, 'GET', `/api/tasks/${f.task.id}/responsibility`);
      expect((await f.request(eve, 'POST', `/api/tasks/${f.task.id}/archive`, { archived: false })).status).toBeGreaterThanOrEqual(400);
      await f.settle();
      expect(otherTab).toHaveLength(1);
      expect(colleague).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("reading an inbox ask reaches the person's other tabs and nobody else", async () => {
    const f = await fixture();
    try {
      await f.h.store.appendEvent({ taskId: f.task.id, type: 'task.mentioned', ts: Date.now(),
        payload: { recipients: ['user:ana'], by: 'agent:do', text: 'Deployed.' } });
      const [item] = await f.h.store.listInbox('ana', f.organization.id);
      expect(item).toMatchObject({ kind: 'mentioned', unread: true });
      const ana = await f.mint('ana', f.organization.id), ben = await f.mint('ben', f.organization.id);
      const [acting, phone, colleague] = [await f.listen(ana, 'tab_acting01'), await f.listen(ana, 'tab_phone001'), await f.listen(ben)];
      const read = await f.request(ana, 'PATCH', `/api/inbox?organizationId=${f.organization.id}`, { ids: [item!.id] }, 'tab_acting01');
      expect([read.status, read.status === 200 ? '' : await read.text()]).toEqual([200, '']);
      await expect.poll(() => phone).toEqual([{ type: 'changed', area: 'inbox', organizationId: f.organization.id, own: true }]);
      await f.settle();
      expect(acting).toEqual([]);
      expect(colleague).toEqual([]);
      expect((await f.h.store.attentionAsks('ana', f.organization.id)).size).toBe(0);
    } finally { await f.close(); }
  });
});
