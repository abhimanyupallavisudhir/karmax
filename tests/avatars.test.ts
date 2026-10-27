import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationGrantError, AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { avatarForRole, normalizeAvatarSetting } from '../src/platform/avatars.js';
import { taskAuthorityNow } from '../src/platform/task-authority.js';
import { evaluateQuery } from '../src/domain/search.js';
import { parseQuery } from '../src/domain/query-language.js';
import type { AuthorizationSelection, TaskRecord } from '../src/domain/types.js';

/**
 * An Avatar is a task marked Avatar (wiki features/avatars): its forks — a
 * task's main agent, a Responder, a Reviewer — act with its authorization
 * without anyone granting it again, while whoever made the fork may call it.
 */
async function fixture() {
  const store = await Store.create(':memory:');
  await store.claimPersonalOrganization('owner');
  await store.setOrganizationMembership('org_personal', 'dev', 'member');
  await store.setOrganizationMembership('org_personal', 'guest', 'member');
  const project = await store.createProject('Avatars');
  await store.setProjectMembership(project.id, { kind: 'user', userId: 'dev' }, 'member');
  const authorization = await AuthorizationService.create(store);
  await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' });
  await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  await authorization.grant('system:test', { principalId: 'user:guest', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const tokenFor = async (userId: string) => (await tokens.mintPrincipal(
    `user:${userId}`, await authorization.capabilities(`user:${userId}`, project.id, 'org_personal'),
    project.id, undefined, 'org_personal',
  )).token;
  const client = { workflow: {
    getHandle: () => ({ executeUpdate: async (_name: string, opts: { args: unknown[] }) => ({ applied: Object.keys(opts.args[0] as object) }),
      query: async () => [], signal: async () => undefined }),
    start: async () => ({}),
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const maintainer: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  const owner = await tokenFor('owner');
  // Saved as an Avatar without running: a draft carrying the Avatar setting.
  const saveAvatar = (avatar: unknown = {}) => api.createTask(owner, { projectId: project.id, draft: true,
    prompt: 'You are Atlas, the owner’s release delegate.', authorization: maintainer, params: { avatar } });
  const fork = (token: string, avatarId: string, extra: Record<string, unknown> = {}) => api.createTask(token, {
    projectId: project.id, draft: true, prompt: 'Ship it',
    params: { 'agent:do': { provider: 'mock', resumeFrom: { taskId: avatarId, role: 'do' } }, ...extra } });
  return { store, project, authorization, tokens, tokenFor, api, maintainer, owner, saveAvatar, fork };
}

const stored = (task: TaskRecord) => task.params._authorization as { principal?: string; level?: string; capabilities?: string[] };

describe('Avatars are tasks', () => {
  it('normalizes the setting: callable by the project unless it says otherwise', () => {
    expect(normalizeAvatarSetting({})).toEqual({ callableBy: ['@project'] });
    expect(normalizeAvatarSetting(true)).toEqual({ callableBy: ['@project'] });
    expect(normalizeAvatarSetting({ callableBy: ['@maintainers', 'user:dev', '@team:ops'], forksMayBeAvatars: true }))
      .toEqual({ callableBy: ['@maintainers', 'user:dev', '@team:ops'], forksMayBeAvatars: true });
    expect(normalizeAvatarSetting(false)).toBeNull();
    expect(() => normalizeAvatarSetting({ callableBy: ['everyone'] })).toThrow('not a person, team or group selector');
  });

  it('lists a task saved as Avatar, which rests in the Avatar stage and matches is:avatar, not is:draft', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar();
    expect(avatar.params.avatar).toEqual({ callableBy: ['@project'] });
    expect((await f.store.listAvatars(f.project.id)).map((a) => [a.id, a.name, a.ownerUserId]))
      .toEqual([[avatar.id, avatar.title, 'owner']]);
    const ordinary = await f.api.createTask(f.owner, { projectId: f.project.id, draft: true, prompt: 'Plain draft' });
    const ids = (q: string) => evaluateQuery([avatar, ordinary], parseQuery(q), { now: 0 }).tasks.map((t) => t.id);
    expect(ids('is:avatar')).toEqual([avatar.id]);
    expect(ids('is:draft')).toEqual([ordinary.id]);
    expect(ids('stage:avatar')).toEqual([avatar.id]);
    expect(ids('status:done')).toEqual([avatar.id]);
  });

  it('is on by default; a project that turns Avatars off refuses one', async () => {
    const f = await fixture();
    expect(await f.store.avatarAvailability(f.project.id)).toEqual({ organization: true, project: 'inherit', effective: true });
    await f.store.kvSet(`avatars:project:${f.project.id}`, 'disabled');
    await expect(f.saveAvatar()).rejects.toThrow('Avatārs are disabled for this project');
  });

  it('gives a fork by someone who may call it the Avatar’s authorization without a grant', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar();
    const dev = await f.tokenFor('dev');
    // A developer could never grant maintainer authority themselves…
    await expect(f.api.createTask(dev, { projectId: f.project.id, prompt: 'x', authorization: f.maintainer }))
      .rejects.toBeInstanceOf(AuthorizationGrantError);
    // …but a fork of the owner's maintainer Avatar acts with it.
    const forked = await f.fork(dev, avatar.id);
    expect(stored(forked)).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'maintainer' });
    expect(stored(forked).capabilities).toEqual(stored(avatar).capabilities);
    const now = await taskAuthorityNow(f.store, f.authorization, forked);
    expect(now.capabilities).toContain('review:approve');
  });

  it('lends its forks its creator’s GitHub account', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar();
    await f.store.patchTaskParams(avatar.id, { _githubAccountId: 'gh_owner' });
    expect((await f.store.getAvatar(avatar.id))?.githubAccountId).toBe('gh_owner');
    const forked = await f.fork(await f.tokenFor('dev'), avatar.id);
    expect(forked.params._githubAccountId).toBe('gh_owner');
  });

  it('keeps a fork on the Avatar’s authorization through the form’s saves, and starts it', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar();
    const dev = await f.tokenFor('dev');
    const forked = await f.fork(dev, avatar.id);
    // The form re-sends its Authorization on every save: still granted by the
    // Avatār, whether it keeps all of it or takes less.
    await f.api.setTaskAuthorization(dev, forked.id, f.maintainer);
    expect(stored((await f.store.getTask(forked.id))!)).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'maintainer' });
    await f.api.setTaskAuthorization(dev, forked.id, { level: 'developer', scope: 'projects', projectIds: [f.project.id] });
    expect(stored((await f.store.getTask(forked.id))!)).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'developer' });
    // Editing the draft keeps the rule: it cannot become an Avatar itself.
    await expect(f.api.updateArmedParams(dev, forked.id, { avatar: {} })).rejects.toThrow('can\'t be Avatārs themselves');
    // And the developer may start it.
    await expect(f.api.queueTask(dev, forked.id)).resolves.toMatchObject({ id: forked.id });
  });

  it('lets a fork take less than the Avatār’s authorization, but not more', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar();
    const dev = await f.tokenFor('dev');
    const developer: AuthorizationSelection = { level: 'developer', scope: 'projects', projectIds: [f.project.id] };
    const less = await f.api.createTask(dev, { projectId: f.project.id, draft: true, prompt: 'Less', authorization: developer,
      params: { 'agent:do': { provider: 'mock', resumeFrom: { taskId: avatar.id, role: 'do' } } } });
    expect(stored(less)).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'developer' });
    expect((await taskAuthorityNow(f.store, f.authorization, less)).capabilities).not.toContain('review:approve');
    // A narrower Avatār cannot be forked into a wider authorization.
    const narrow = await f.api.createTask(f.owner, { projectId: f.project.id, draft: true, prompt: 'Narrow',
      authorization: developer, params: { avatar: {} } });
    await expect(f.api.createTask(dev, { projectId: f.project.id, draft: true, prompt: 'More', authorization: f.maintainer,
      params: { 'agent:do': { provider: 'mock', resumeFrom: { taskId: narrow.id, role: 'do' } } } }))
      .rejects.toThrow(/a fork can take that or less/);
    // A Responder forking it may take less too.
    const responder = await f.api.createTask(dev, { projectId: f.project.id, draft: true, prompt: 'x',
      params: { responder: { kind: 'agent', provider: 'mock', resumeFrom: { taskId: avatar.id, role: 'do' },
        authority: { authorization: developer } } } });
    expect((responder.params._agentAuthorization as any).responder).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'developer' });
  });

  it('can be limited to some roles, judged when forked and on every turn', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar({ roles: ['responder', 'confirm'] });
    expect(avatar.params.avatar).toEqual({ callableBy: ['@project'], roles: ['responder', 'confirm'] });
    const dev = await f.tokenFor('dev');
    await expect(f.fork(dev, avatar.id)).rejects.toThrow('can\'t be forked as a task’s agent');
    const asResponder = await f.api.createTask(dev, { projectId: f.project.id, draft: true, prompt: 'x',
      params: { responder: { kind: 'agent', provider: 'mock', resumeFrom: { taskId: avatar.id, role: 'do' } } } });
    expect(asResponder.id).toBeTruthy();
    // Every role named is no restriction at all.
    expect((await f.saveAvatar({ roles: ['do', 'responder', 'confirm', 'agent'] })).params.avatar).toEqual({ callableBy: ['@project'] });
    // Narrowing the roles later withdraws a fork's authority at its next turn.
    const open = await f.saveAvatar();
    const forked = await f.fork(dev, open.id);
    expect((await taskAuthorityNow(f.store, f.authorization, forked)).capabilities).toContain('review:approve');
    await f.store.patchTaskParams(open.id, { avatar: { callableBy: ['@project'], roles: ['responder'] } });
    expect((await taskAuthorityNow(f.store, f.authorization, forked)).capabilities).toEqual([]);
  });

  it('puts a draft edited to fork it on its authorization and in its budget pool at once', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar();
    const dev = await f.tokenFor('dev');
    const draft = await f.api.createTask(dev, { projectId: f.project.id, draft: true, prompt: 'Plain' });
    expect(stored(draft).principal).toBe('user:dev');
    // A developer may set its cards and budget: within the pool they only narrow it.
    await f.api.updateArmedParams(dev, draft.id, { 'agent:do': { provider: 'mock', resumeFrom: { taskId: avatar.id, role: 'do' } },
      paymentPolicy: { cardIds: [], budget: 500, currency: 'usd' } });
    const edited = (await f.store.getTask(draft.id))!;
    expect(stored(edited)).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'maintainer' });
    expect((await f.store.paymentBudgetFamily(draft.id)).ancestorIds).toEqual([avatar.id]);
  });

  it('treats a fork by someone who may not call it as an ordinary fork', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar({ callableBy: ['user:owner'] });
    const dev = await f.tokenFor('dev');
    const forked = await f.fork(dev, avatar.id);
    expect(stored(forked)).toMatchObject({ principal: 'user:dev', level: 'developer' });
    await expect(f.api.createTask(dev, { projectId: f.project.id, prompt: 'x', authorization: f.maintainer,
      params: { 'agent:do': { provider: 'mock', resumeFrom: { taskId: avatar.id, role: 'do' } } } }))
      .rejects.toBeInstanceOf(AuthorizationGrantError);
  });

  it('takes callers as groups, resolved live', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar({ callableBy: ['@project'] });
    const guest = await f.tokenFor('guest'); // a developer, but not a member of the project
    expect(stored(await f.fork(guest, avatar.id)).principal).toBe('user:guest');
    await f.store.setProjectMembership(f.project.id, { kind: 'user', userId: 'guest' }, 'member');
    expect(stored(await f.fork(guest, avatar.id)).principal).toBe(`avatar:${avatar.id}`);
  });

  it('withdraws the authority at once when calling it is withdrawn', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar();
    const forked = await f.fork(await f.tokenFor('dev'), avatar.id);
    const agents = { do: forked.params['agent:do'] as any };
    expect(await avatarForRole(f.store, { taskId: forked.id, projectId: f.project.id, agents }, 'do')).toMatchObject({ id: avatar.id });
    await f.store.patchTaskParams(avatar.id, { avatar: { callableBy: ['user:owner'] } });
    expect(await avatarForRole(f.store, { taskId: forked.id, projectId: f.project.id, agents }, 'do')).toBeUndefined();
    expect((await taskAuthorityNow(f.store, f.authorization, forked)).capabilities).toEqual([]);
    // Unmarking it, or turning Avatars off, withdraws it too.
    await f.store.patchTaskParams(avatar.id, { avatar: { callableBy: ['@project'] } });
    expect((await taskAuthorityNow(f.store, f.authorization, forked)).capabilities).not.toEqual([]);
    await f.store.kvSet(`avatars:project:${f.project.id}`, 'disabled');
    expect((await taskAuthorityNow(f.store, f.authorization, forked)).capabilities).toEqual([]);
  });

  it('lets a fork be an Avatar itself only when the Avatar allows it', async () => {
    const f = await fixture();
    const closed = await f.saveAvatar();
    const dev = await f.tokenFor('dev');
    await expect(f.fork(dev, closed.id, { avatar: {} })).rejects.toThrow('can\'t be Avatārs themselves');
    const open = await f.saveAvatar({ forksMayBeAvatars: true });
    const child = await f.fork(dev, open.id, { avatar: { callableBy: ['user:dev'] } });
    // The child Avatar is backed by its parent, so its own forks still reach the owner's grant.
    const grandchild = await f.fork(dev, child.id);
    expect(stored(grandchild).principal).toBe(`avatar:${child.id}`);
    expect((await taskAuthorityNow(f.store, f.authorization, grandchild)).capabilities).toContain('review:approve');
    // A parent that stops allowing it cuts the chain.
    await f.store.patchTaskParams(open.id, { avatar: { callableBy: ['@project'] } });
    expect((await taskAuthorityNow(f.store, f.authorization, grandchild)).capabilities).toEqual([]);
  });

  it('gives a Responder that forks it the Avatar’s authority, granted by the Avatār', async () => {
    const f = await fixture();
    const avatar = await f.saveAvatar();
    const task = await f.api.createTask(await f.tokenFor('dev'), { projectId: f.project.id, draft: true, prompt: 'x',
      params: { responder: { kind: 'agent', provider: 'mock', resumeFrom: { taskId: avatar.id, role: 'do' },
        authority: { authorization: f.maintainer } } } });
    expect((task.params._agentAuthorization as any).responder).toMatchObject({ principal: `avatar:${avatar.id}`, level: 'maintainer' });
    expect(await avatarForRole(f.store, { taskId: task.id, projectId: f.project.id,
      agents: { responder: (task.params.responder as any) } }, 'responder')).toMatchObject({ id: avatar.id });
  });
});
