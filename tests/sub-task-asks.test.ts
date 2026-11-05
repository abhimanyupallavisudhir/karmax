import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { ServiceConnections } from '../src/integrations/service-connections.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';
import { DELEGATED_PROFILE } from '../src/platform/delegation.js';
import type { TaskView } from '../src/domain/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/** A sub-task asks people through its parent (src/platform/sub-task-asks.ts):
 * what its parent cannot give goes to people at once, shown as via the parent
 * (whose task they know), and the parent's agent is told, so it can add the
 * context they lack or decline it. */
describe('a sub-task asks people through its parent', () => {
  async function fixture() {
    const store = await Store.create(':memory:');
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = await store.createProject('Site', {}, organization.id);
    const authorization = await AuthorizationService.create(store);
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    for (const userId of ['admin', 'dev']) await store.setOrganizationMembership(organization.id, userId, 'member');
    await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: organizationScope(organization.id), profileId: 'administrator' });
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
    const view = async (taskId: string, status = 'active', extra: Partial<TaskView> = {}) => store.saveView(taskId, { taskId, title: 'T',
      workflow: 'software-dev', stage: 'do', status, messages: [], actions: [], state: {}, updatedAt: 1, ...extra } as unknown as TaskView);
    const devCaps = await authorization.capabilities('user:dev', project.id, organization.id);
    // A developer's task and its sub-task, which acts with its authority.
    const lead = await store.createTask({ projectId: project.id, title: 'Launch the site', workflow: 'software-dev', workflowVersion: '1.30.0',
      createdBy: { kind: 'user', userId: 'dev' }, params: { prompt: 'lead', _authorization: { level: 'developer',
        scope: 'projects', projectIds: [project.id], organizationId: organization.id, capabilities: devCaps } } });
    const child = await store.createTask({ projectId: project.id, title: 'Billing page', workflow: 'software-dev', workflowVersion: '1.30.0',
      parentTaskId: lead.id, createdBy: { kind: 'task-agent', taskId: lead.id, role: 'do' }, params: { prompt: 'billing',
        _authorization: { profileId: DELEGATED_PROFILE, principal: `task:${lead.id}`, capabilities: devCaps } } });
    await view(lead.id); await view(child.id);
    const agentOf = async (taskId: string, caps: string[]) => (await tokens.mint({ taskId, profileId: 'do', role: 'do',
      principal: `task-agent:${taskId}:do`, projectId: project.id, organizationId: organization.id, ceiling: caps, grantorCaps: caps })).token;
    const inbox = async (userId: string) => (await store.listInbox(userId, organization.id)).filter((row) => row.taskId === child.id);
    const toLead = () => delivered.filter((entry) => entry.taskId === lead.id && entry.message?.author === `task:${child.id}`);
    return { store, organization, project, api, tokens, client, lead, child, devCaps, agentOf, view, inbox, toLead };
  }

  it('asks people at once for a permission its parent lacks, via the parent, whose agent can add a note', async () => {
    const f = await fixture();
    try {
      const asker = await f.agentOf(f.child.id, [...f.devCaps, 'task:escalate']);
      const requested = await f.api.requestPermission(asker, { capabilities: ['project:settings:write'], reason: 'Turn on previews.' });
      // The nearest who can grant it, as for any task; its parent may decline it.
      expect(requested).toMatchObject({ status: 'needs_approval', audience: ['@admins'] });
      const [request] = await new PermissionRequests(f.store, f.organization.id).requests({ taskId: f.child.id });
      expect(request).toMatchObject({ taskRecipients: [f.lead.id], via: { taskId: f.lead.id } });
      expect((await f.inbox('admin')).map((row) => row.kind)).toEqual(['approval-requested']);
      // The parent's agent is told, not asked to decide.
      const [told] = f.toLead();
      expect(told!.message.text).toContain('asks people for project:settings:write, through you');
      expect(told!.message.text).toContain(`escalate(to, note, task_id: "${f.child.id}")`);
      expect(told!.message.text).toContain(`/api/permission-requests/${requested.requestId}/resolve`);

      // Its note reaches the people it names; the sub-task, held for the approval, now waits on them.
      const parent = await f.agentOf(f.lead.id, [...f.devCaps, 'task:escalate']);
      const noted = await f.api.escalateToHuman(parent, { taskId: f.child.id, audience: ['user:owner'],
        message: 'The launch needs previews on; Billing page is part of it.' });
      expect(noted.waitingFor).toMatchObject({ kind: 'human', audience: ['user:owner'] });
      const [annotated] = await new PermissionRequests(f.store, f.organization.id).requests({ taskId: f.child.id });
      expect(annotated).toMatchObject({ recipients: ['owner'], via: { taskId: f.lead.id, note: 'The launch needs previews on; Billing page is part of it.' } });
      expect((await f.inbox('owner')).map((row) => row.kind)).toEqual(['approval-requested']);
    } finally { await f.store.close(); }
  });

  it('asks people at once for a credential, via its parent, whose agent is told once', async () => {
    const f = await fixture();
    try {
      const vault = new VaultItems(f.store, undefined, undefined, f.organization.id);
      const via = { taskId: f.lead.id, at: Date.now() };
      const decision = await vault.request({ taskId: f.child.id, caps: f.devCaps, domain: 'stripe.com', why: 'Create the products.', via });
      expect(decision).toMatchObject({ status: 'not_in_vault', raised: { via } });
      for (const userId of ['owner', 'dev']) expect((await f.inbox(userId)).map((row) => row.kind)).toEqual(['approval-requested']);
      await f.api.tellParentOf(f.child.id, { credential: decision.raised!, label: 'stripe.com' });
      const [told] = f.toLead();
      expect(told!.message.text).toContain('asks people for the credential "stripe.com"');
      expect(told!.message.text).toContain(`/api/vault/requests/${decision.requestId}/resolve`);
      // Asking again joins the same request: the parent is not told twice.
      expect((await vault.request({ taskId: f.child.id, caps: f.devCaps, domain: 'stripe.com', via })).raised).toBeUndefined();

      const parent = await f.agentOf(f.lead.id, [...f.devCaps, 'task:escalate']);
      const noted = await f.api.escalateToHuman(parent, { taskId: f.child.id, audience: ['user:owner'], message: 'Billing needs our Stripe login.' });
      // The sub-task is not stopped: it goes on with what it can do meanwhile.
      expect((noted as any).note).toBe('Passed its request on to user:owner.');
      expect((await f.store.getTask(f.child.id))!.lastView!.status).toBe('active');
      const [request] = await vault.requests({ taskId: f.child.id });
      expect(request).toMatchObject({ audience: ['user:owner'], via: { taskId: f.lead.id, note: 'Billing needs our Stripe login.' } });
    } finally { await f.store.close(); }
  });

  it('routes a credential and an app request it makes through the gateway via its parent, which may decline them', async () => {
    const f = await fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-sub-task-asks-'));
    let close: (() => Promise<void>) | undefined;
    try {
      const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
      const bus = new KarmaxBus();
      const gateway = await Gateway.create({ store: f.store, broker, bus, tokens: f.tokens, api: f.api, client: f.client,
        contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: home,
        agentInfo: { provider: 'mock', reason: 'sub-task asks test' }, worlds: new WorldRegistry() } as any);
      const running = await gateway.listen(await findFreePortFrom(48_760));
      close = running.close;
      const agent = await f.tokens.mint({ taskId: f.child.id, projectId: f.project.id, organizationId: f.organization.id,
        principal: `task-agent:${f.child.id}:do`, profileId: 'do', ceiling: f.devCaps, grantorCaps: f.devCaps });
      const post = async (route: string, body: unknown, token = agent.token) => (await (await fetch(`${running.url}${route}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })).json()) as any;
      const asked = await post('/api/vault/requests', { domain: 'stripe.com', why: 'Create the products.' });
      expect(asked).toMatchObject({ status: 'not_in_vault', requestId: expect.any(String) });
      expect(asked.raised).toBeUndefined();
      expect(f.toLead().map((entry) => entry.message.text)).toEqual([expect.stringContaining('asks people for the credential "stripe.com"')]);
      expect((await f.inbox('owner')).map((row) => row.kind)).toEqual(['approval-requested']);
      // The parent's agent declines it.
      const parent = await f.tokens.mint({ taskId: f.lead.id, projectId: f.project.id, organizationId: f.organization.id,
        principal: `task-agent:${f.lead.id}:do`, profileId: 'do', ceiling: f.devCaps, grantorCaps: f.devCaps });
      expect(await post(`/api/vault/requests/${asked.requestId}/resolve`, { action: 'deny' }, parent.token)).toMatchObject({ status: 'denied' });

      const connections = new ServiceConnections(f.store, undefined as any);
      const c = await connections.request(f.organization.id, 'gmail', f.child.id, 'do', 'Send receipts.', { taskId: f.lead.id, at: Date.now() });
      expect(c.via).toMatchObject({ taskId: f.lead.id });
      expect((await f.inbox('owner')).map((row) => row.kind)).toEqual(['approval-requested']);
      await f.api.tellParentOf(f.child.id, { connection: c });
      expect(f.toLead()[1]!.message.text).toContain(`/api/connections/${c.id}/disconnect`);
      expect(await post(`/api/connections/${c.id}/disconnect`, {}, parent.token)).toMatchObject({ status: 'denied' });
    } finally { await close?.(); await f.store.close(); fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('asks people as any task does once its parent has finished', async () => {
    const f = await fixture();
    try {
      await f.view(f.lead.id, 'done');
      const asker = await f.agentOf(f.child.id, [...f.devCaps, 'task:escalate']);
      await f.api.requestPermission(asker, { capabilities: ['project:settings:write'], reason: 'Turn on previews.' });
      const [request] = await new PermissionRequests(f.store, f.organization.id).requests({ taskId: f.child.id });
      expect(request!.via).toBeUndefined();
      expect(request!.taskRecipients ?? []).toEqual([]);
      expect(f.toLead()).toEqual([]);
    } finally { await f.store.close(); }
  });

  it('notifies nobody while it is escalated to its parent', async () => {
    const f = await fixture();
    try {
      await f.view(f.child.id, 'blocked', { stage: 'escalated', waitingFor: { kind: 'parent', detail: 'Tests keep failing.' } } as any);
      for (const userId of ['owner', 'dev']) expect(await f.inbox(userId)).toEqual([]);
      await f.view(f.child.id, 'blocked', { stage: 'escalated', waitingFor: { kind: 'human', audience: ['user:dev'], detail: 'x' } } as any);
      expect((await f.inbox('dev')).map((row) => row.kind)).toEqual(['escalated']);
    } finally { await f.store.close(); }
  });
});
