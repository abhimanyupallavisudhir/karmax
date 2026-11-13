import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { WorldRegistry } from '../src/world/registry.js';
import { avatarForRole } from '../src/platform/avatars.js';
import { taskAuthorityNow } from '../src/platform/task-authority.js';
import { AUTONOMY_WIKI_PATH, autonomyWikiPage } from '../src/domain/autonomous-projects.js';
import { BRAND } from '../src/domain/brand.js';
import { VaultItems } from '../src/autonomy/vault-items.js';

/**
 * An autonomous project (wiki features/autonomy): nobody is asked anything.
 * The Responder and the Reviewer fork one Avatār holding the project's full
 * authority, a `default` wiki page says there is no human, and a permanent
 * co-ordinator draft — forking the same Avatār — waits to be run.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-autonomy-'));
  dirs.push(contentDir);
  const store = await Store.create(':memory:');
  await store.claimPersonalOrganization('owner');
  await store.setOrganizationMembership('org_personal', 'dev', 'member');
  const project = await store.createProject('Firm');
  await store.setProjectMembership(project.id, { kind: 'user', userId: 'dev' }, 'member');
  const authorization = await AuthorizationService.create(store);
  await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: organizationScope('org_personal'), profileId: 'superadmin' });
  await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const tokenFor = async (userId: string, projectId: string | null = project.id) => (await tokens.mintPrincipal(
    `user:${userId}`, await authorization.capabilities(`user:${userId}`, projectId ?? undefined, 'org_personal'),
    projectId ?? undefined, undefined, 'org_personal',
  )).token;
  const client = { workflow: {
    // A running task's workflow answers with its published view.
    getHandle: (id: string) => ({ executeUpdate: async () => ({}), signal: async () => undefined, terminate: async () => undefined,
      cancel: async () => undefined, describe: async () => ({ status: { name: "TERMINATED" } }), result: async () => undefined,
      query: async () => (await store.getTask(id))?.lastView ?? [] }),
    start: async () => ({}),
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization, contentDir, worlds: new WorldRegistry() });
  return { store, project, authorization, tokens, tokenFor, api, owner: await tokenFor('owner', null) };
}

/** A task's agent, with what its creator holds in the project. */
async function agentToken(f: Awaited<ReturnType<typeof fixture>>, taskId: string, userId: string) {
  const caps = await f.authorization.capabilities(`user:${userId}`, f.project.id, 'org_personal');
  return (await f.tokens.mint({ taskId, profileId: 'do', role: 'do', principal: `user:${userId}`, projectId: f.project.id,
    organizationId: 'org_personal', ceiling: caps, grantorCaps: caps })).token;
}

const stored = (params: Record<string, unknown>) => params._authorization as { principal?: string; level?: string; scope?: string; projectIds?: string[]; capabilities?: string[] };

describe('autonomous project', () => {
  it('sets up a judging Avatār with the project’s full authority, agent Responder and Reviewer forking it, a $50 budget and a co-ordinator draft', async () => {
    const f = await fixture();
    const autonomy = await f.api.makeAutonomous(f.owner, f.project.id);
    expect(autonomy).toMatchObject({ scope: 'project', wikiPage: { scope: 'project', path: AUTONOMY_WIKI_PATH } });

    // The Avatār: the most a project grant reaches — Project maintainer here — and every vault credential.
    const avatar = (await f.store.getTask(autonomy.avatarTaskId))!;
    // Every task of the project may call it, but only to answer and review.
    expect(avatar.params.avatar).toEqual({ callableBy: ['@project'], roles: ['responder', 'confirm'] });
    expect(String(avatar.params.prompt)).toMatch(/Judge every request on its merits/);
    expect(avatar.params.draft).toBe(true);
    expect(stored(avatar.params)).toMatchObject({ level: 'maintainer', scope: 'projects', projectIds: [f.project.id] });
    expect(stored(avatar.params).capabilities).toEqual(expect.arrayContaining(['use-credential:*', 'review:approve', 'task:create']));
    expect(stored(avatar.params).capabilities).not.toContain('payment:write');
    expect((await f.store.listAvatars(f.project.id)).map((a) => a.id)).toEqual([avatar.id]);

    // Task defaults: the Responder and the one Review layer are agents forking it.
    const common = (await f.store.getSettings(f.project.id, '__common__'))!;
    const fork = { resumeFrom: { taskId: avatar.id, role: 'do' } };
    expect(common.responder).toMatchObject({ kind: 'agent', ...fork, prompt: expect.stringMatching(/No human works on this project/) });
    expect(common.confirm).toEqual({ layers: [{ kind: 'agent', ...fork, prompt: expect.stringMatching(/No human reviews this project/) }] });

    // $50 by default, in the project's payment defaults, until someone changes it.
    expect(autonomy.budget).toEqual({ scope: 'project', amount: 5000, currency: 'usd' });
    expect(await f.store.getSettings(f.project.id, 'payments')).toEqual({ budget: 5000, currency: 'usd' });

    // The co-ordinator: a permanent co-ordinator draft holding the same authority, and that budget.
    const coordinator = (await f.store.getTask(autonomy.coordinatorTaskId))!;
    expect(coordinator.title).toBe('Co-ordinator');
    expect(coordinator.params).toMatchObject({ draft: true, coordinator: { wakeHours: 24 }, multiPr: true,
      paymentPolicy: { budget: 5000, currency: 'usd' } });
    expect(coordinator.params['agent:do']).toBeUndefined();
    expect(stored(coordinator.params)).toMatchObject({ principal: 'user:owner', level: 'maintainer', scope: 'projects', projectIds: [f.project.id] });
    expect(stored(coordinator.params).capabilities).toContain('use-credential:*');

    // The project wiki's general prompt says there is no human.
    const page = (await f.api.readWiki(f.owner, 'project', f.project.id, AUTONOMY_WIKI_PATH) as any).page;
    expect(page.labels).toEqual(['default']);
    expect(page.content).toBe(autonomyWikiPage('project', BRAND));
    for (const duty of [/sign up/i, /check_agent_mail/, /TOTP/, /CAPTCHA/, /request_spend/, /never use escalate_to_human/i])
      expect(page.content).toMatch(duty);

    // Asking again returns what it has.
    expect(await f.api.makeAutonomous(f.owner, f.project.id)).toMatchObject({ avatarTaskId: avatar.id, coordinatorTaskId: coordinator.id });
    expect(await f.api.autonomy(f.owner, f.project.id)).toMatchObject({ avatarTaskId: avatar.id, coordinatorTaskId: coordinator.id });
    expect((await f.store.listAvatars(f.project.id))).toHaveLength(1);
  });

  it('gives every task of the project — a developer’s too — a Responder and Reviewer that act for the Avatār, which nobody may direct', async () => {
    const f = await fixture();
    const autonomy = await f.api.makeAutonomous(f.owner, f.project.id);
    const common = (await f.store.getSettings(f.project.id, '__common__'))!;
    const agents = { responder: common.responder as any, confirm: (common.confirm as any).layers[0] };
    const actsFor = async (token: string) => {
      const task = await f.api.createTask(token, { projectId: f.project.id, prompt: 'Ship the landing page', draft: true });
      return Promise.all(['responder', 'confirm'].map(async (role) =>
        (await avatarForRole(f.store, { taskId: task.id, projectId: f.project.id, agents }, role))?.id));
    };
    expect(await actsFor(f.owner)).toEqual([autonomy.avatarTaskId, autonomy.avatarTaskId]);
    const dev = await f.tokenFor('dev');
    expect(await actsFor(dev)).toEqual([autonomy.avatarTaskId, autonomy.avatarTaskId]);
    // …but nobody gets it as an agent they direct.
    await expect(f.api.createTask(dev, { projectId: f.project.id, prompt: 'Do as I say', draft: true,
      params: { 'agent:do': { resumeFrom: { taskId: autonomy.avatarTaskId, role: 'do' } } } })).rejects.toThrow(/can't be forked as a task’s agent/);
  });

  it('keeps a budget someone already chose', async () => {
    const f = await fixture();
    await f.store.setSettings(f.project.id, 'payments', { budget: 0, currency: 'eur' });
    const autonomy = await f.api.makeAutonomous(f.owner, f.project.id);
    expect(autonomy.budget).toBeUndefined();
    expect(await f.store.getSettings(f.project.id, 'payments')).toEqual({ budget: 0, currency: 'eur' });
  });

  it('sends a permission request it can grant to the Avatār, which decides it in a fork of its own', async () => {
    const f = await fixture();
    const autonomy = await f.api.makeAutonomous(f.owner, f.project.id);
    const task = await f.api.createTask(await f.tokenFor('dev'), { projectId: f.project.id, prompt: 'Merge the release', draft: true });
    await f.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      messages: [], actions: [], state: {} } as any);
    const agent = await agentToken(f, task.id, 'dev');
    const asked = await f.api.requestPermission(agent, { capabilities: ['review:approve'], reason: 'Approve my own release review' });
    expect(asked).toMatchObject({ status: 'needs_approval', audience: [`avatar:${autonomy.avatarTaskId}`] });
    const decider = (await f.store.listTasks(f.project.id)).find((candidate) => candidate.title.endsWith('decide permission request'))!;
    expect(decider.params).toMatchObject({ _avatarRole: 'confirm', 'agent:do': { resumeFrom: { taskId: autonomy.avatarTaskId } } });
    expect(String(decider.params.prompt)).toMatch(/Approve my own release review/);
  });

  it('sends a vault request to the Avatār when it may approve it: a project’s Avatār for the project’s own items, an organization’s for all', async () => {
    for (const scope of ['project', 'organization'] as const) {
      const f = await fixture();
      await f.api.makeAutonomous(f.owner, f.project.id, scope);
      const vault = new VaultItems(f.store, undefined, undefined, 'org_personal');
      const shared = await vault.save({ type: 'note', label: 'Stripe dashboard', domains: ['stripe.com'], policy: { use: 'ask', reveal: 'never' } });
      const own = await vault.save({ type: 'note', label: 'Shop admin', domains: ['shop.example'], ownerProjectId: f.project.id, policy: { use: 'ask', reveal: 'ask' } });
      const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Refund the order', draft: true });
      const agent = await agentToken(f, task.id, 'owner');
      const deciders = async () => (await f.store.listTasks(f.project.id)).filter((candidate) => candidate.title.endsWith('decide credential request'));
      await f.api.routeCredentialRequest(agent, { id: 'vreq_1', taskId: task.id, itemId: shared.id, mode: 'use', status: 'pending',
        why: 'to refund order 42', createdAt: Date.now() });
      if (scope === 'project') expect(await deciders()).toEqual([]);
      else expect(String((await deciders())[0]!.params.prompt)).toMatch(/may use "Stripe dashboard" \(stripe\.com\)/);
      await f.api.routeCredentialRequest(agent, { id: 'vreq_2', taskId: task.id, itemId: own.id, mode: 'reveal', status: 'pending',
        why: 'to read the admin password', createdAt: Date.now() });
      const decider = (await deciders()).find((candidate) => String(candidate.params.prompt).includes('vreq_2'))!;
      expect(String(decider.params.prompt)).toMatch(/may see the plaintext of "Shop admin" \(shop\.example\)/);
      expect(String(decider.params.prompt)).toMatch(/POST \/api\/vault\/requests\/vreq_2\/resolve/);
    }
  });

  it('sends a task’s app connection request to a project’s Avatār, which may connect it as the project’s own or decline it', async () => {
    const f = await fixture();
    await f.api.makeAutonomous(f.owner, f.project.id);
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Answer the shop’s mail', draft: true });
    const agent = await agentToken(f, task.id, 'dev');
    await f.api.routeConnectionRequest(agent, { id: 'conn_1', organizationId: 'org_personal', toolkit: 'gmail', label: 'gmail', projectIds: [],
      taskId: task.id, why: 'to answer customers', status: 'requested', createdAt: Date.now(), updatedAt: Date.now() });
    const decider = (await f.store.listTasks(f.project.id)).find((candidate) => candidate.title.endsWith('decide app connection request'))!;
    expect(decider.params).toMatchObject({ _avatarRole: 'confirm' });
    const prompt = String(decider.params.prompt);
    expect(prompt).toMatch(/gmail/);
    expect(prompt).toMatch(/to answer customers/);
    expect(prompt).toContain(`POST /api/connections/connect?projectId=${f.project.id}`);
    expect(prompt).toContain(`"ownerProjectId":"${f.project.id}"`);
    expect(prompt).toMatch(/POST \/api\/connections\/conn_1\/disconnect/);
    // A connection someone already answered, or one of a project that is not autonomous, asks nobody.
    const before = (await f.store.listTasks(f.project.id)).length;
    await f.api.routeConnectionRequest(agent, { id: 'conn_2', organizationId: 'org_personal', toolkit: 'slack', label: 'slack', projectIds: [],
      taskId: task.id, status: 'active', ownerId: 'owner', createdAt: Date.now(), updatedAt: Date.now() });
    expect((await f.store.listTasks(f.project.id)).length).toBe(before);
  });

  it('is refused to someone who may not change the project’s settings, leaving nothing behind', async () => {
    const f = await fixture();
    await expect(f.api.makeAutonomous(await f.tokenFor('dev'), f.project.id)).rejects.toThrow(/project:settings:write/);
    expect(await f.store.listAvatars(f.project.id)).toEqual([]);
    expect(await f.api.autonomy(f.owner, f.project.id)).toBeNull();
  });

  it('removes the drafts it made when a later step fails', async () => {
    const f = await fixture();
    const original = f.api.saveWikiPageResolved.bind(f.api);
    f.api.saveWikiPageResolved = async () => { throw new Error('wiki offline'); };
    await f.store.setSettings(f.project.id, '__common__', { otherAttempts: 'keep' });
    await expect(f.api.makeAutonomous(f.owner, f.project.id)).rejects.toThrow('wiki offline');
    expect((await f.store.listTasks(f.project.id)).filter((task) => task.params.avatar || task.params.coordinator)).toEqual([]);
    expect(await f.store.getSettings(f.project.id, '__common__')).toEqual({ otherAttempts: 'keep' });
    f.api.saveWikiPageResolved = original;
    expect((await f.api.makeAutonomous(f.owner, f.project.id)).scope).toBe('project');
  });
});

describe('autonomous organization', () => {
  it('gives its co-ordinator project an organization-wide Super-administrator Avatār and the organization wiki the page', async () => {
    const f = await fixture();
    const autonomy = await f.api.makeAutonomous(f.owner, f.project.id, 'organization');
    expect(autonomy.wikiPage).toEqual({ scope: 'organization', path: AUTONOMY_WIKI_PATH });
    const avatar = (await f.store.getTask(autonomy.avatarTaskId))!;
    expect(avatar.params.avatar).toEqual({ callableBy: ['@project'], roles: ['responder', 'confirm'] });
    expect(stored(avatar.params)).toMatchObject({ level: 'superadmin', scope: 'organization' });
    expect(stored(avatar.params).capabilities).toEqual(expect.arrayContaining(['project:create', 'payment:write', 'credential:reveal']));
    const coordinator = (await f.store.getTask(autonomy.coordinatorTaskId))!;
    expect(String(coordinator.params.prompt)).toMatch(/Run this whole organization/);
    expect(stored(coordinator.params)).toMatchObject({ principal: 'user:owner', level: 'superadmin', scope: 'organization' });
    // The organization's payment defaults carry the $50, so every project's tasks start from it.
    expect(autonomy.budget).toEqual({ scope: 'organization', amount: 5000, currency: 'usd' });
    expect(await f.store.getSettings('organization:org_personal', 'payments')).toMatchObject({ budget: 5000, currency: 'usd' });
    const now = await taskAuthorityNow(f.store, f.authorization, coordinator);
    expect(now.capabilities).toEqual(expect.arrayContaining(['project:create', 'organization:wiki:write']));
    const page = (await f.api.readWiki(f.owner, 'organization', 'org_personal', AUTONOMY_WIKI_PATH) as any).page;
    expect(page.labels).toEqual(['default']);
    expect(page.content).toMatch(/# This is an autonomous organization/);

    // A project made autonomous later in that organization relies on the organization's page.
    const other = await f.store.createProject('Shop');
    const shop = await f.api.makeAutonomous(f.owner, other.id);
    expect(shop.wikiPage).toEqual({ scope: 'organization', path: AUTONOMY_WIKI_PATH });
    expect((await f.api.readWiki(f.owner, 'project', other.id, AUTONOMY_WIKI_PATH) as any).page).toBeUndefined();
  });
});
