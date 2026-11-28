import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority, type ScopedToken } from '../src/platform/tokens.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';
import { DELEGATED_PROFILE } from '../src/platform/delegation.js';
import { ConflictError } from '../src/platform/errors.js';
import { decidingPrincipal, decisionMaker } from '../src/platform/decision-maker.js';
import { recordHumanConfirmation } from '../src/platform/review-confirmation.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Gateway } from '../src/gateway/server.js';
import { findFreePortFrom } from '../src/util/ports.js';
import type { TaskView } from '../src/domain/types.js';

/**
 * Who decided a request, as recorded and as shown (src/platform/decision-maker.ts).
 *
 * The incident (preq_mwzzs9mwfe0322d123, 2026-11-27): sub-task #1068 asked for
 * github:actions:write through its parent #1064, whose agent — acting with the
 * owner's delegation — denied it. The decision was stored as the owner's, so
 * the CEO, also asked, told the owner they had denied it. The CEO's approve,
 * made before that denial, had failed with "task belongs to another project":
 * the CEO's task is in another project of the organization, and it holds the
 * capability organization-wide.
 */
async function fixture() {
  const store = await Store.create(':memory:');
  store.connectUserNames(() => [{ id: 'owner', name: 'Ada Owner' }, { id: 'admin', name: 'Grace Admin' }]);
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const site = await store.createProject('Site', {}, organization.id);
  const ceoProject = await store.createProject('Apps', {}, organization.id);
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
  for (const userId of ['admin', 'dev']) await store.setOrganizationMembership(organization.id, userId, 'member');
  await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: organizationScope(organization.id), profileId: 'administrator' });
  for (const project of [site, ceoProject])
    await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const delivered: Array<{ taskId: string; name: string; message: any }> = [];
  const client = { workflow: {
    getHandle: (id: string) => ({
      describe: async () => ({ runId: 'run', status: { name: 'RUNNING' } }),
      terminate: async () => undefined,
      executeUpdate: async () => undefined,
      query: async (name: string) => {
        const view = name === 'view' ? (await store.getTask(id))?.lastView : undefined;
        if (!view) throw new Error('no live query');
        return view;
      },
      signal: async (name: string, message: any) => { delivered.push({ taskId: id, name, message }); },
    }),
    start: async () => ({}),
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const view = async (taskId: string, status = 'active') => store.saveView(taskId, { taskId, title: 'T',
    workflow: 'software-dev', stage: 'do', status, messages: [], actions: [], state: {}, updatedAt: 1 } as unknown as TaskView);
  const ownerCaps = await authorization.capabilities('user:owner', ceoProject.id, organization.id);
  const devCaps = await authorization.capabilities('user:dev', site.id, organization.id);
  // The CEO: in its own project, with the owner's authority across the organization.
  const ceo = await store.createTask({ projectId: ceoProject.id, title: 'CEO', workflow: 'software-dev', workflowVersion: '1.30.0',
    createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: 'run it', _authorization: { level: 'owner',
      scope: 'organization', organizationId: organization.id, principal: 'user:owner', capabilities: ownerCaps } } });
  // #1064: created by the CEO in Site, a developer across Site and the CEO's project.
  const lead = await store.createTask({ projectId: site.id, title: 'Apps', workflow: 'software-dev', workflowVersion: '1.30.0',
    parentTaskId: ceo.id, createdBy: { kind: 'task-agent', taskId: ceo.id, role: 'do' }, params: { prompt: 'apps',
      _authorization: { level: 'developer', scope: 'projects', projectIds: [site.id, ceoProject.id], organizationId: organization.id,
        principal: 'user:owner', capabilities: devCaps } } });
  // #1068: its sub-task, acting with its authority.
  const child = await store.createTask({ projectId: site.id, title: 'Phone entry points', workflow: 'software-dev', workflowVersion: '1.30.0',
    parentTaskId: lead.id, createdBy: { kind: 'task-agent', taskId: lead.id, role: 'do' }, params: { prompt: 'phone',
      _authorization: { profileId: DELEGATED_PROFILE, principal: `task:${lead.id}`, capabilities: devCaps } } });
  for (const task of [ceo, lead, child]) await view(task.id);
  // An agent's token names the person it acts for as its principal, as every
  // task's does: what it decides must still be its own.
  const agentOf = async (taskId: string, caps: string[], scope: { projectId?: string; projectIds?: string[] } = {}) =>
    (await tokens.mint({ taskId, profileId: 'do', role: 'do', principal: 'user:owner', organizationId: organization.id,
      ...scope, ceiling: caps, grantorCaps: caps })).token;
  const ceoAgent = () => agentOf(ceo.id, ownerCaps);
  const leadAgent = () => agentOf(lead.id, [...devCaps, 'task:escalate'], { projectIds: [site.id, ceoProject.id] });
  const ask = async () => {
    const asker = await agentOf(child.id, [...devCaps, 'task:escalate'], { projectIds: [site.id, ceoProject.id] });
    const asked = await api.requestPermission(asker, { capabilities: ['github:actions:write'], reason: 'Build the iOS app on CI.' });
    return asked.requestId!;
  };
  const stored = async (id: string) => (await new PermissionRequests(store, organization.id).requests({ taskId: child.id }))
    .find((request) => request.id === id)!;
  const to = (taskId: string) => delivered.filter((entry) => entry.taskId === taskId).map((entry) => entry.message);
  return { store, organization, site, ceoProject, api, tokens, client, authorization, ceo, lead, child, ownerCaps, devCaps, agentOf,
    ceoAgent, leadAgent, ask, stored, to, delivered };
}

const resolve = (f: Awaited<ReturnType<typeof fixture>>, token: string, requestId: string, action: 'approve' | 'deny') =>
  f.api.resolvePermissionRequest(token, { organizationId: f.organization.id, requestId, action });

describe('who decided a permission request', () => {
  it('asks the CEO, which holds it, and the parent, which may decline it', async () => {
    const f = await fixture();
    try {
      const id = await f.ask();
      expect(await f.stored(id)).toMatchObject({ audience: [`task:${f.ceo.id}`], taskRecipients: [f.ceo.id, f.lead.id] });
      expect(f.to(f.ceo.id).map((message) => message.text)).toEqual([expect.stringContaining('asks you for github:actions:write, which you hold')]);
    } finally { await f.store.close(); }
  });

  it('records a task agent\'s denial as that agent, never as the person it acts for', async () => {
    const f = await fixture();
    try {
      const id = await f.ask();
      const denied = await resolve(f, await f.leadAgent(), id, 'deny');
      expect(denied.resolution).toMatchObject({ action: 'deny', by: `task-agent:${f.lead.id}:do` });
      expect((await f.stored(id)).resolution!.by).toBe(`task-agent:${f.lead.id}:do`);
      // The GET route says it in words, with the task to link.
      const [listed] = await f.api.listPermissionRequests(await f.ceoAgent(), { organizationId: f.organization.id, taskId: f.child.id });
      expect(listed!.decidedBy).toEqual({ by: `task-agent:${f.lead.id}:do`, label: `Task #${f.lead.num}'s agent`,
        taskId: f.lead.id, num: f.lead.num });
      // The event, and what the asking agent is told.
      const events = await f.store.eventsOfType(f.child.id, 'permission.approval-resolved');
      expect(events.map((event) => event.payload.resolvedBy)).toEqual([`task-agent:${f.lead.id}:do`]);
      expect(f.to(f.child.id).at(-1)!.text).toContain(`Denied by Task #${f.lead.num}'s agent for this task's do agent`);
      expect(JSON.stringify(listed)).not.toContain('user:owner');
    } finally { await f.store.close(); }
  });

  it('records a person as the person', async () => {
    const f = await fixture();
    try {
      const id = await f.ask();
      const admin = (await f.tokens.mintPrincipal('user:owner', f.ownerCaps, undefined, undefined, f.organization.id)).token;
      // The owner was not asked: they may not decide it, nor learn the outcome that way.
      await expect(resolve(f, admin, id, 'deny')).rejects.toThrow('not routed to you');
      await f.api.escalateToHuman(await f.leadAgent(), { taskId: f.child.id, audience: ['user:owner'], message: 'Your call.' });
      const denied = await resolve(f, admin, id, 'deny');
      expect(denied.resolution!.by).toBe('user:owner');
      expect((await decisionMaker(f.store, denied.resolution!.by))!.label).toBe('Ada Owner');
    } finally { await f.store.close(); }
  });

  it('tells the other tasks asked that it is decided, without waking them', async () => {
    const f = await fixture();
    try {
      const id = await f.ask();
      const before = f.to(f.lead.id).length;
      await resolve(f, await f.leadAgent(), id, 'deny');
      const [note] = f.to(f.ceo.id).slice(1);
      expect(note).toMatchObject({ role: 'user', to: [] });
      expect(note.text).toContain(`was already denied by Task #${f.lead.num}'s agent`);
      expect(note.text).toContain('Nothing to do');
      // The task that decided it is not told what it just did.
      expect(f.to(f.lead.id).length).toBe(before);
      // A withdrawal is news to them too.
      const again = await f.ask();
      const asker = await f.agentOf(f.child.id, [...f.devCaps, 'task:escalate', 'withdraw_permission_request'],
        { projectIds: [f.site.id, f.ceoProject.id] });
      await f.api.withdrawPermissionRequest(asker, { requestId: again, reason: 'Not needed.' });
      expect(f.to(f.ceo.id).at(-1)!.text).toContain(`was already withdrawn by Task #${f.child.num}'s agent`);
      expect((await f.stored(again)).withdrawn!.by).toBe(`task-agent:${f.child.id}:do`);
    } finally { await f.store.close(); }
  });

  it('answers a late decision with 409 "already denied by …", before any check of the caller', async () => {
    const f = await fixture();
    try {
      const id = await f.ask();
      await resolve(f, await f.leadAgent(), id, 'deny');
      const late = resolve(f, await f.ceoAgent(), id, 'approve');
      await expect(late).rejects.toBeInstanceOf(ConflictError);
      await expect(late).rejects.toMatchObject({ status: 409,
        message: `permission request ${id} was already denied by Task #${f.lead.num}'s agent; nothing to do` });
      // Even someone it was never routed to learns that, not "not routed to you".
      const dev = (await f.tokens.mintPrincipal('user:dev', f.devCaps, f.site.id, undefined, f.organization.id)).token;
      await expect(resolve(f, dev, id, 'approve')).rejects.toMatchObject({ status: 409 });
      expect((await f.stored(id)).status).toBe('denied');
    } finally { await f.store.close(); }
  });

  it('lets a grantor that holds it organization-wide grant it to a task spanning its own project', async () => {
    const f = await fixture();
    try {
      const id = await f.ask();
      // Was: "you cannot grant github:actions:write: task belongs to another project (project <CEO's>)".
      const approved = await resolve(f, await f.ceoAgent(), id, 'approve');
      expect(approved).toMatchObject({ status: 'granted', resolution: { by: `task-agent:${f.ceo.id}:do` } });
      expect(await new PermissionRequests(f.store, f.organization.id).extensionCaps(f.child.id, 'do')).toEqual(['github:actions:write']);
      expect(f.to(f.lead.id).at(-1)!.text).toContain(`was already granted by Task #${f.ceo.num}'s agent`);
    } finally { await f.store.close(); }
  });

  it('still refuses a grantor that lacks it in one of the task\'s projects, naming that project', async () => {
    const f = await fixture();
    try {
      const id = await f.ask();
      // A maintainer of Site, only a developer in the other project the task spans.
      await f.store.setOrganizationMembership(f.organization.id, 'maint', 'member');
      const authorization = f.authorization;
      await authorization.grant('system:test', { principalId: 'user:maint', scopeKey: projectScope(f.site.id), profileId: 'maintainer' });
      await authorization.grant('system:test', { principalId: 'user:maint', scopeKey: projectScope(f.ceoProject.id), profileId: 'developer' });
      await f.api.escalateToHuman(await f.leadAgent(), { taskId: f.child.id, audience: ['user:maint'], message: 'Can you?' });
      const maint = (await f.tokens.mintPrincipal('user:maint', await authorization.capabilities('user:maint', f.site.id, f.organization.id),
        undefined, undefined, f.organization.id)).token;
      await expect(resolve(f, maint, id, 'approve')).rejects.toThrow(`you cannot grant github:actions:write: permission denied (project ${f.ceoProject.id})`);
      expect((await f.stored(id)).status).toBe('pending');
    } finally { await f.store.close(); }
  });
});

describe('who decided an authorization request', () => {
  it('records the person, answers a second decision with 409, and names them to the agent that asked', async () => {
    const f = await fixture();
    try {
      const held = await f.api.createTask(await f.leadAgent(), { projectId: f.site.id, workflow: 'just-do', prompt: 'deploy',
        authorization: { level: 'maintainer', scope: 'projects', projectIds: [f.site.id] }, holdForAuthorization: true });
      const requestId = held.authorizationRequest!.id;
      const admin = (await f.tokens.mintPrincipal('user:admin', await f.authorization.capabilities('user:admin', f.site.id, f.organization.id),
        undefined, undefined, f.organization.id)).token;
      const denied = await f.api.resolveAuthorizationRequest(admin, { organizationId: f.organization.id, requestId, action: 'deny' });
      expect(denied.resolution!.by).toBe('user:admin');
      expect(f.to(f.lead.id).at(-1)!.text).toMatch(/^Grace Admin denied the maintainer authorization/);
      const [listed] = await f.api.listAuthorizationRequests(admin, { organizationId: f.organization.id, taskId: held.id });
      expect((listed as any).decidedBy).toMatchObject({ by: 'user:admin', label: 'Grace Admin' });
      await expect(f.api.resolveAuthorizationRequest(admin, { organizationId: f.organization.id, requestId, action: 'approve' }))
        .rejects.toMatchObject({ status: 409, message: `authorization request ${requestId} was already denied by Grace Admin; nothing to do` });
    } finally { await f.store.close(); }
  });
});

describe('who decided a credential request', () => {
  it('answers a late decision through the gateway with 409 and who decided it', async () => {
    const f = await fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-decision-maker-'));
    let close: (() => Promise<void>) | undefined;
    try {
      const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
      const gateway = await Gateway.create({ store: f.store, broker, bus: new KarmaxBus(), tokens: f.tokens, api: f.api, client: f.client,
        contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: home,
        agentInfo: { provider: 'mock', reason: 'decision maker test' }, worlds: new WorldRegistry() } as any);
      const running = await gateway.listen(await findFreePortFrom(48_860));
      close = running.close;
      const post = async (route: string, body: unknown, token: string) => {
        const response = await fetch(`${running.url}${route}`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as any };
      };
      const asker = await f.agentOf(f.child.id, f.devCaps, { projectId: f.site.id });
      const asked = await post('/api/vault/requests', { domain: 'stripe.com', why: 'Create the products.' }, asker);
      // The parent's agent declines it: recorded as that agent.
      const parent = await f.agentOf(f.lead.id, f.devCaps, { projectId: f.site.id });
      expect(await post(`/api/vault/requests/${asked.body.requestId}/resolve`, { action: 'deny' }, parent))
        .toMatchObject({ status: 200, body: { status: 'denied', resolution: { by: `task-agent:${f.lead.id}:do` },
          decidedBy: { label: `Task #${f.lead.num}'s agent` } } });
      expect(await post(`/api/vault/requests/${asked.body.requestId}/resolve`, { action: 'deny' }, parent)).toEqual({ status: 409,
        body: { error: `credential request ${asked.body.requestId} was already denied by Task #${f.lead.num}'s agent; nothing to do` } });
      // A permission request's late decision is a 409 through the gateway too (was 400).
      const id = await f.ask();
      await resolve(f, await f.leadAgent(), id, 'deny');
      const late = await post(`/api/permission-requests/${id}/resolve?organizationId=${f.organization.id}`, { action: 'approve' }, await f.ceoAgent());
      expect(late).toMatchObject({ status: 409, body: { error: expect.stringContaining(`already denied by Task #${f.lead.num}'s agent`) } });
    } finally { await close?.(); await f.store.close(); fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('the decision maker', () => {
  const token = (record: Partial<ScopedToken>) => ({ taskId: '*', profileId: 'user', principal: 'user:owner', kind: 'human',
    caps: [], issuedAt: 0, expiresAt: 0, audience: 'karmax-platform', id: 'tok', ...record }) as ScopedToken;

  it('is the actor, never the delegating person', () => {
    expect(decidingPrincipal(token({ actor: { kind: 'interactive-human', userId: 'owner' } }))).toBe('user:owner');
    expect(decidingPrincipal(token({ kind: 'agent', taskId: 'task_a', role: 'do', principal: 'user:owner',
      actor: { kind: 'task-agent', taskId: 'task_a', profileId: 'do-default', role: 'do' },
      humanSubject: { kind: 'user', userId: 'owner', presence: 'delegated' } }))).toBe('task-agent:task_a:do');
    // Records from before actors were recorded are still an agent's.
    expect(decidingPrincipal(token({ kind: 'agent', taskId: 'task_a', profileId: 'do-default', principal: 'user:owner',
      actor: undefined as any }))).toBe('task-agent:task_a:do-default');
    // An Avatār's agent decides as the Avatār it was routed as.
    expect(decidingPrincipal(token({ kind: 'agent', taskId: 'task_b', principal: 'avatar:av_1',
      actor: { kind: 'task-agent', taskId: 'task_b', profileId: 'confirm', role: 'confirm' } }))).toBe('avatar:av_1');
    expect(decidingPrincipal(token({ kind: 'system', principal: 'system:sweep', actor: { kind: 'system', principal: 'system:sweep' } })))
      .toBe('system:sweep');
  });

  it('is named for people', async () => {
    const f = await fixture();
    try {
      const label = async (by: string) => (await decisionMaker(f.store, by))?.label;
      expect(await label('user:owner')).toBe('Ada Owner');
      expect(await label(`task-agent:${f.lead.id}:do`)).toBe(`Task #${f.lead.num}'s agent`);
      expect(await label(`task-agent:${f.lead.id}:organization:org_x::do-default`)).toBe(`Task #${f.lead.num}'s agent`);
      expect(await label(`task-agent:${f.lead.id}:confirm`)).toBe(`Task #${f.lead.num}'s Reviewer`);
      expect(await label(`task:${f.lead.id}`)).toBe(`Task #${f.lead.num}`);
      expect(await label('system:task-settled')).toBe('tavya');
      expect(await decisionMaker(f.store, undefined)).toBeUndefined();
    } finally { await f.store.close(); }
  });

  it('keeps whose authority a Review confirmation carries, and records the agent that gave it', async () => {
    const f = await fixture();
    try {
      await f.store.saveView(f.child.id, { taskId: f.child.id, title: 'T', workflow: 'software-dev', stage: 'review', status: 'waiting',
        waitingFor: { kind: 'human', audience: ['@creator'] }, messages: [], actions: [], state: {}, updatedAt: 1 } as unknown as TaskView);
      await recordHumanConfirmation(f.store, f.child.id, 'owner', `task-agent:${f.lead.id}:do`);
      await recordHumanConfirmation(f.store, f.child.id, 'owner', 'user:owner');
      const votes = await f.store.eventsOfType(f.child.id, 'task.confirmation-voted');
      expect(votes.map((event) => [event.payload.userId, event.payload.by])).toEqual([['owner', `task-agent:${f.lead.id}:do`], ['owner', undefined]]);
    } finally { await f.store.close(); }
  });
});
