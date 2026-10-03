import { describe, it, expect } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { WorldRegistry } from '../src/world/registry.js';
import previousProfiles from './fixtures/authorization-pre-diagnostics.json';
import { allows, attenuate, CAPABILITIES, CHILD_TASK_CEILING } from '../src/platform/capabilities.js';

describe('autonomous role defaults', () => {
  it('delegates Developer task management and diagnostics to children without peer mutation authority', async () => {
    const store = await Store.create(':memory:');
    try {
      const auth = await AuthorizationService.create(store);
      const project = await store.createProject('Children');
      const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'work' } });
      const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(),
        profiles: new ProfileResolver(store, 'mock') });
      const child = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id,
        title: 'Child', prompt: 'work', project: {}, parentBranch: 'parent-branch',
        parentGrant: (await auth.profile('developer'))!.capabilities });
      const caps = child.grant!;
      for (const cap of ['task:create', 'task:manage-own', 'diagnostic:read', 'process:read', 'skill:write']) {
        expect(allows(caps, cap), cap).toBe(true);
      }
      expect(allows(caps, 'task:signal')).toBe(false);
      expect(allows(caps, 'project:settings:write')).toBe(false);
      expect(allows(caps, 'merge-into:parent-branch')).toBe(true);
      expect(allows(caps, 'merge-into:main')).toBe(false);
      const tokens = new TokenAuthority(store);
      const token = await tokens.mint({ taskId: child.taskId, principal: child.grantPrincipal!,
        projectId: project.id, profileId: 'developer', ceiling: ['*'], grantorCaps: caps });
      expect((await tokens.check(token.token, 'task:git:publish', { taskId: child.taskId })).ok).toBe(true);
      expect((await tokens.check(token.token, 'task:signal', { taskId: parent.id })).ok).toBe(false);
      expect(attenuate(CHILD_TASK_CEILING, ['task:read'])).toEqual(['task:read']);
    } finally { await store.close(); }
  });
  it('upgrades untouched installed roles and preserves deliberately narrowed profiles', async () => {
    const store = await Store.create(':memory:');
    try {
      for (const profile of previousProfiles) await store.setAuthorizationProfile('global', profile);
      const auth = await AuthorizationService.create(store);
      for (const id of ['developer', 'maintainer', 'administrator']) {
        expect(allows((await auth.profile(id))!.capabilities, 'diagnostic:read')).toBe(true);
      }
      const customized = { ...previousProfiles.find(p => p.id === 'developer')!, capabilities: ['task:read'] };
      await store.setAuthorizationProfile('global', customized);
      await auth.seed();
      expect((await auth.profile('developer'))!.capabilities).toEqual(['task:read']);
    } finally { await store.close(); }
  });

  it('reserves only installation-wide capabilities from Super-administrators, and the vault, payments and deletion from Administrators', async () => {
    const store = await Store.create(':memory:');
    try {
      const auth = await AuthorizationService.create(store);
      const installation = ['workflow:install', 'process:kill', 'settings:read', 'settings:write',
        'subscription:gift', 'authorization:read', 'authorization:write', 'user:read', 'user:write'];
      const superadmin = (await auth.profile('superadmin'))!.capabilities;
      expect(CAPABILITIES.filter(cap => !allows(superadmin, cap))).toEqual(installation);
      const admin = (await auth.profile('administrator'))!.capabilities;
      expect(CAPABILITIES.filter(cap => !allows(admin, cap)).sort())
        .toEqual([...installation, 'credential:reveal', 'payment:write', 'organization:delete'].sort());
    } finally { await store.close(); }
  });

  it('retains diagnostics and review authority through scope attenuation', async () => {
    const store = await Store.create(':memory:');
    try {
      const auth = await AuthorizationService.create(store);
      const project = await store.createProject('P');
      for (const level of ['developer', 'maintainer', 'administrator', 'god']) {
        const grant = await auth.taskGrant('root', project.id, { level,
          scope: level === 'god' ? 'global' : level === 'administrator' ? 'organization' : 'projects',
          projectIds: [project.id] }, ['*']);
        for (const cap of ['diagnostic:read', 'process:read']) expect(allows(grant.capabilities, cap), `${level}: ${cap}`).toBe(true);
        expect(allows(grant.capabilities, 'review:approve'), level).toBe(level !== 'developer');
        if (level === 'god') for (const cap of [...CAPABILITIES, 'future:dangerous:operation']) expect(allows(grant.capabilities, cap)).toBe(true);
        if (level === 'developer') expect(allows(grant.capabilities, 'project:settings:write')).toBe(false);
      }
    } finally { await store.close(); }
  });

  it('lets developers manage their work and descendants, but not another creator’s tasks', async () => {
    const store = await Store.create(':memory:');
    try {
      const auth = await AuthorizationService.create(store);
      const project = await store.createProject('P');
      await store.setOrganizationMembership(project.organizationId!, 'dev', 'member');
      await store.setOrganizationMembership(project.organizationId!, 'other', 'member');
      const ids: Record<string, string> = {};
      const create = async (id: string, extra = {}) => { ids[id] = (await store.createTask({ projectId: project.id, title: id, workflow: 'software-dev', workflowVersion: '1', params: { prompt: id }, ...extra })).id; };
      await create('own', { createdBy: { kind: 'user', userId: 'dev' } });
      await create('child', { parentTaskId: ids.own });
      await create('created', { createdBy: { kind: 'task-agent', taskId: ids.own!, role: 'do' } });
      await create('sibling', { createdBy: { kind: 'user', userId: 'dev' } });
      await create('other', { createdBy: { kind: 'user', userId: 'other' } });
      const tokens = new TokenAuthority(store);
      const caps = (await auth.profile('developer'))!.capabilities;
      const human = await tokens.mintPrincipal('user:dev', caps, project.id);
      const agent = await tokens.mint({ principal: 'user:dev', taskId: ids.own!, profileId: 'developer', projectId: project.id, ceiling: caps, grantorCaps: ['*'] });
      const legacy = await tokens.mint({ principal: 'system:legacy-task', taskId: ids.own!, profileId: 'developer', projectId: project.id, ceiling: caps, grantorCaps: ['*'] });
      for (const cap of ['task:edit', 'task:signal', 'task:delete', 'task:conversation:message']) {
        for (const id of ['own', 'child']) {
          for (const token of [human.token, agent.token, legacy.token]) expect((await tokens.check(token, cap, { taskId: ids[id] })).ok, `${cap} ${id}`).toBe(true);
        }
        expect((await tokens.check(agent.token, cap, { taskId: ids.created })).ok).toBe(true);
        for (const token of [human.token, agent.token]) expect((await tokens.check(token, cap, { taskId: ids.other })).ok).toBe(false);
      }
      expect((await tokens.check(agent.token, 'task:edit', { taskId: ids.sibling })).ok).toBe(false);
      expect((await tokens.check(human.token, 'task:edit', { taskId: ids.sibling })).ok).toBe(true);
      expect((await tokens.check(agent.token, 'task:read', { taskId: ids.other })).ok).toBe(true);
      expect((await tokens.check(agent.token, 'task:edit', { projectId: project.id })).ok).toBe(false);
    } finally { await store.close(); }
  });
});

it('gives a child its parent\'s grant, with merge authority only for the parent\'s branch (SPEC §8.2)', async () => {
  const store = await Store.create(':memory:');
  try {
    const auth = await AuthorizationService.create(store);
    const project = await store.createProject('Inherited grant');
    const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1',
      params: { prompt: 'work' } });
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
    const developer = (await auth.profile('developer'))!.capabilities;
    const child = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id, title: 'Child', prompt: 'work',
      project: {}, parentBranch: 'parent-branch', parentGrant: developer });
    // A sub-task reads the project (its wiki and settings) and uses what its parent may use.
    for (const cap of ['project:read', 'project:settings:read', 'workflow:read', 'repository:read', 'github:actions:read',
      'connection:use', 'credential:read', 'task:create', 'task:manage-own']) expect(allows(child.grant!, cap), cap).toBe(true);
    // Never more than the parent.
    for (const cap of child.grant!) if (cap !== 'merge-into:parent-branch') expect(allows(developer, cap), cap).toBe(true);
    const owner = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id, title: 'Owner child', prompt: 'work',
      project: {}, parentBranch: 'parent-branch', parentGrant: ['*'] });
    expect(allows(owner.grant!, 'settings:write')).toBe(true);
    expect(allows(owner.grant!, 'merge-into:parent-branch')).toBe(true);
    expect(allows(owner.grant!, 'merge-into:main')).toBe(false);
    expect(owner.grant).not.toContain('*');
  } finally { await store.close(); }
});

it('delegates live parent card grants instead of stale start-time authority (RT-16, WF-17, AU-7)', async () => {
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Live grant');
    const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1',
      params: { prompt: '', _authorization: { capabilities: ['task:read', 'use-card:allowed'] } } });
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
    const child = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id, title: 'Child', prompt: 'work', project: {}, parentGrant: ['*'] });
    expect(child.grant).toContain('use-card:allowed');
    await store.kvSet(`permission:grant:${parent.id}`, JSON.stringify({ do: ['use-card:approved'] }));
    const approvedChild = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id,
      title: 'Approved child', prompt: 'work', project: {}, parentGrant: ['*'] });
    expect(approvedChild.grant).toContain('use-card:approved');
    expect(allows(child.grant!, 'task:create')).toBe(false);
    expect(allows(child.grant!, 'use-card:other')).toBe(false);
    await store.updateTaskParams(parent.id, { ...parent.params, _authorization: {
      principal: 'avatar:deleted', capabilities: ['*'],
    } });
    const revokedChild = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id,
      title: 'Revoked child', prompt: 'work', project: {}, parentGrant: ['*'] });
    expect(revokedChild.grant).toEqual([]);
  } finally { await store.close(); }
});
