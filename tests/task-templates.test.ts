import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { templateContent, templateParams } from '../src/domain/task-templates.js';

/**
 * Task templates: saved task forms, a project's and its organization's,
 * numbered in the order they were added after the Task defaults (0). Saved
 * from a form, from any task, or in settings; a task starts from one by id.
 * A real Gateway + KarmaxApi with stub deps — no Temporal, no worker.
 */
describe('task templates', () => {
  let home: string;
  let store: Store;
  let base: string;
  let close: () => Promise<void>;
  let acmeId: string, otherOrgId: string;
  let website: string, docs: string, theirs: string;
  let token: string;

  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`${base}${url}`, { method, headers: auth(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-templates-'));
    store = await Store.create(':memory:', { hosted: true });
    const tokens = new TokenAuthority();
    const acme = await store.createOrganization({ name: 'Acme', ownerUserId: 'a' });
    const other = await store.createOrganization({ name: 'Other', ownerUserId: 'b' });
    acmeId = acme.id; otherOrgId = other.id;
    website = (await store.createProject('Website', {}, acme.id)).id;
    docs = (await store.createProject('Docs', {}, acme.id)).id;
    theirs = (await store.createProject('Theirs', {}, other.id)).id;
    for (const id of [website, docs]) await store.updateProjectConfig(id, { repos: [home] });
    const client = { workflow: { getHandle: () => ({ query: async () => [], signal: async () => {}, terminate: async () => {} }),
      signalWithStart: async () => {}, start: async () => ({}) } } as any;
    const authorization = await AuthorizationService.create(store);
    await authorization.bootstrapOrganizationOwner('system:test', 'a', acme.id);
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, contentDir: home, worlds: new WorldRegistry(), authorization });
    const gateway = await Gateway.create({ api, store, tokens, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), authorization, client, taskQueue: 'test',
      staticDir: home, agentInfo: { provider: 'mock', reason: 'templates test' }, worlds: new WorldRegistry() } as any);
    const running = await gateway.listen(await findFreePortFrom(48_600));
    base = running.url;
    close = running.close;
    token = (await tokens.mintPrincipal('user:a', ['task:*', 'project:read'], undefined, 60_000, acme.id)).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    await store?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('keeps a form’s contents and drops what only meant something for one task', () => {
    const params = templateParams({
      prompt: 'Fix the bug', base: 'main', computer: { cpu: 4 }, wikiContext: ['[[proj:tag:default]]'],
      _authorization: { level: 'developer' }, _githubAccountId: 'x', draft: true, archived: true, triggerState: 'armed',
      images: [{ id: 'img' }], files: [{ id: 'f' }], priority: 3, runOf: 'task_1',
      triggers: [{ kind: 'dependency', tasks: ['task_9'] }, { kind: 'schedule', cron: '0 9 * * 1' }],
      'agent:do': { provider: 'claude', model: 'opus', resumeFrom: { taskId: 'task_9', role: 'do' } },
    });
    expect(params).toEqual({ prompt: 'Fix the bug', base: 'main', computer: { cpu: 4 }, wikiContext: ['[[proj:tag:default]]'],
      triggers: [{ kind: 'schedule', cron: '0 9 * * 1' }], 'agent:do': { provider: 'claude', model: 'opus' } });
    // A scope of only the template's own project means "the new task's own project".
    expect(templateContent({ params: {}, authorization: { level: 'maintainer', scope: 'projects', projectIds: ['p1'] } }, 'p1').authorization)
      .toEqual({ level: 'maintainer', scope: 'projects' });
    expect(templateContent({ params: {}, authorization: { level: 'maintainer', scope: 'projects', projectIds: ['p1', 'p2'] } }, 'p1').authorization)
      .toEqual({ level: 'maintainer', scope: 'projects', projectIds: ['p1', 'p2'] });
  });

  it('lists the organization’s and the project’s templates in the order they were added', async () => {
    const org = await call('POST', `/api/organizations/${acmeId}/templates`, { name: 'Bug triage', workflow: 'software-dev',
      params: { prompt: 'Triage the newest bug report' }, tags: ['bug'], priority: 3 });
    expect(org.status, JSON.stringify(org.body)).toBe(200);
    expect(org.body).toMatchObject({ organizationId: acmeId, projectId: '', name: 'Bug triage', tags: ['bug'], priority: 3 });
    const own = await call('POST', `/api/projects/${website}/templates`, { name: '  Release notes ', params: { prompt: 'Write the release notes', draft: true } });
    expect(own.body).toMatchObject({ organizationId: acmeId, projectId: website, name: 'Release notes', params: { prompt: 'Write the release notes' } });
    expect(own.body.params.draft).toBeUndefined();
    const docsOwn = await call('POST', `/api/projects/${docs}/templates`, { name: 'Docs page', params: { prompt: 'Document it' } });

    const listed = await call('GET', `/api/projects/${website}/templates`);
    expect(listed.body.map((t: any) => t.name)).toEqual(['Bug triage', 'Release notes']);
    expect((await call('GET', `/api/projects/${docs}/templates`)).body.map((t: any) => t.name)).toEqual(['Bug triage', 'Docs page']);
    expect((await call('GET', `/api/organizations/${acmeId}/templates`)).body.map((t: any) => t.name)).toEqual(['Bug triage']);

    expect((await call('POST', `/api/projects/${website}/templates`, { name: '   ', params: {} })).status).toBe(400);

    // Renaming keeps the contents; new contents replace them as a whole.
    const renamed = await call('PATCH', `/api/templates/${own.body.id}`, { name: 'Changelog' });
    expect(renamed.body).toMatchObject({ name: 'Changelog', params: { prompt: 'Write the release notes' } });
    const edited = await call('PATCH', `/api/templates/${own.body.id}`, { params: { prompt: 'Write the changelog' }, notes: 'weekly' });
    expect(edited.body).toMatchObject({ name: 'Changelog', params: { prompt: 'Write the changelog' }, notes: 'weekly', createdAt: own.body.createdAt });
    expect((await call('DELETE', `/api/templates/${docsOwn.body.id}`)).status).toBe(200);
    expect((await call('GET', `/api/projects/${docs}/templates`)).body.map((t: any) => t.name)).toEqual(['Bug triage']);
  });

  it('starts a task from a template, the caller’s values over the template’s', async () => {
    const template = await call('POST', `/api/projects/${website}/templates`, { name: 'Upgrade', workflow: 'software-dev',
      params: { prompt: 'Upgrade the dependencies', target: 'release' }, notes: 'monthly chore', tags: ['chore'], priority: 2,
      authorization: { level: 'developer', scope: 'projects', projectIds: [website] } });
    const task = await call('POST', `/api/projects/${website}/tasks`, { templateId: template.body.id, draft: true });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    const stored = (await store.getTask(task.body.id))!;
    expect(stored.params).toMatchObject({ prompt: 'Upgrade the dependencies', target: 'release', priority: 2, draft: true });
    expect(stored.notes).toBe('monthly chore');
    expect((stored.params._authorization as any).projectIds).toEqual([website]);
    const tags = await store.listTags(website);
    expect((await store.tagsFor(stored.id)).map((id) => tags.find((tag) => tag.id === id)?.name)).toEqual(['chore']);

    const overridden = await call('POST', `/api/projects/${website}/tasks`, { templateId: template.body.id, draft: true,
      prompt: 'Upgrade only React', params: { target: 'main' } });
    expect((await store.getTask(overridden.body.id))!.params).toMatchObject({ prompt: 'Upgrade only React', target: 'main' });

    // A project's template is not another project's.
    expect((await call('POST', `/api/projects/${docs}/tasks`, { templateId: template.body.id, draft: true })).status).toBe(404);
  });

  it('saves any task as a template, of its project or its organization', async () => {
    const tag = await store.createTag({ projectId: website, name: 'frontend' });
    const task = await store.createTask({ projectId: website, title: 'Polish the header', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'Polish the header', priority: 4, images: [{ id: 'img' } as any], _authorization: {
        level: 'maintainer', scope: 'projects', projectIds: [website], capabilities: ['task:read', 'use-credential:item:vi_1'] } } as any });
    await store.setTaskNotes(task.id, 'ask design first');
    await store.setTaskTags(task.id, [tag.id]);

    const saved = await call('POST', `/api/tasks/${task.id}/template`, { name: 'Polish', scope: 'organization' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ organizationId: acmeId, projectId: '', name: 'Polish', workflow: 'software-dev',
      params: { prompt: 'Polish the header' }, notes: 'ask design first', tags: ['frontend'], priority: 4,
      authorization: { level: 'maintainer', scope: 'projects' }, credentialGrants: ['use-credential:item:vi_1'] });
    expect(saved.body.params.images).toBeUndefined();
    expect(saved.body.authorization.projectIds).toBeUndefined();
    const own = await call('POST', `/api/tasks/${task.id}/template`, { name: 'Polish here' });
    expect(own.body.projectId).toBe(website);
  });

  it('refuses another organization’s templates', async () => {
    const foreign = await store.createTaskTemplate({ organizationId: otherOrgId, projectId: theirs, name: 'Theirs', workflow: 'software-dev', params: { prompt: 'secret' } });
    const foreignOrg = await store.createTaskTemplate({ organizationId: otherOrgId, name: 'Theirs too', workflow: 'software-dev', params: { prompt: 'secret' } });
    for (const id of [foreign.id, foreignOrg.id]) {
      expect((await call('PATCH', `/api/templates/${id}`, { name: 'pwned' })).status).toBe(403);
      expect((await call('DELETE', `/api/templates/${id}`)).status).toBe(403);
    }
    expect((await store.getTaskTemplate(foreign.id))?.name).toBe('Theirs');
    expect((await call('GET', `/api/organizations/${otherOrgId}/templates`)).status).toBe(403);
    expect((await call('GET', `/api/projects/${theirs}/templates`)).status).toBe(403);
    expect((await call('POST', `/api/organizations/${otherOrgId}/templates`, { name: 'smuggled', params: {} })).status).toBe(403);
    const smuggled = await call('POST', `/api/projects/${website}/tasks`, { templateId: foreignOrg.id, draft: true });
    expect(smuggled.status).toBe(404);
    expect(JSON.stringify(smuggled.body)).not.toContain('secret');
  });

  it('goes with its project and its organization', async () => {
    const project = await store.createProject('Short-lived', {}, acmeId);
    const template = await store.createTaskTemplate({ organizationId: acmeId, projectId: project.id, name: 'Gone', workflow: 'software-dev', params: {} });
    await store.deleteProject(project.id);
    expect(await store.getTaskTemplate(template.id)).toBeUndefined();
    const doomed = await store.createOrganization({ name: 'Doomed', ownerUserId: 'c' });
    const orgTemplate = await store.createTaskTemplate({ organizationId: doomed.id, name: 'Gone too', workflow: 'software-dev', params: {} });
    expect(JSON.stringify(await store.exportOrganization(doomed.id))).toContain(orgTemplate.id);
    await store.deleteOrganization(doomed.id);
    expect(await store.getTaskTemplate(orgTemplate.id)).toBeUndefined();
  });
});
