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
    getHandle: () => ({ executeUpdate: async () => ({}), query: async () => [], signal: async () => undefined }),
    start: async () => ({}),
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization, contentDir, worlds: new WorldRegistry() });
  return { store, project, authorization, tokens, tokenFor, api, owner: await tokenFor('owner', null) };
}

const stored = (params: Record<string, unknown>) => params._authorization as { principal?: string; level?: string; scope?: string; projectIds?: string[]; capabilities?: string[] };

describe('autonomous project', () => {
  it('sets up an Avatār with the project’s full authority, agent Responder and Reviewer forking it, and a co-ordinator draft', async () => {
    const f = await fixture();
    const autonomy = await f.api.makeAutonomous(f.owner, f.project.id);
    expect(autonomy).toMatchObject({ scope: 'project', wikiPage: { scope: 'project', path: AUTONOMY_WIKI_PATH } });

    // The Avatār: the most a project grant reaches — Project maintainer here — and every vault credential.
    const avatar = (await f.store.getTask(autonomy.avatarTaskId))!;
    expect(avatar.params.avatar).toEqual({ callableBy: ['@maintainers'] });
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

    // The co-ordinator: a permanent co-ordinator draft acting for the Avatār.
    const coordinator = (await f.store.getTask(autonomy.coordinatorTaskId))!;
    expect(coordinator.title).toBe('Co-ordinator');
    expect(coordinator.params).toMatchObject({ draft: true, coordinator: { wakeHours: 24 }, multiPr: true, 'agent:do': fork });
    expect(stored(coordinator.params)).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'maintainer' });

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

  it('gives the tasks of the project a Responder and Reviewer that act for the Avatār, when their creator may call it', async () => {
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
    // A developer may not call a maintainer-level Avatār: their tasks' Responder gets nothing of it.
    expect(await actsFor(await f.tokenFor('dev'))).toEqual([undefined, undefined]);
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
    expect(avatar.params.avatar).toEqual({ callableBy: ['@superadmins'], forksMayBeAvatars: true });
    expect(stored(avatar.params)).toMatchObject({ level: 'superadmin', scope: 'organization' });
    expect(stored(avatar.params).capabilities).toEqual(expect.arrayContaining(['project:create', 'payment:write', 'credential:reveal']));
    const coordinator = (await f.store.getTask(autonomy.coordinatorTaskId))!;
    expect(String(coordinator.params.prompt)).toMatch(/Run this whole organization/);
    expect(stored(coordinator.params)).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'superadmin' });
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
