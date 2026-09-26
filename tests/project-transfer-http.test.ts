import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { chromium } from 'playwright';
import ts from 'typescript';
import * as environmentBuilder from '../src/world/environment-build.js';
import * as environmentRecords from '../src/store/project-environment.js';
import { selectProjectEnvironment } from '../src/world/project-runtime.js';
import { findFreePortFrom } from '../src/util/ports.js';

let nextPort = 49500;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(options: { fullApp?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-project-transfer-'));
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const source = (await store.createOrganization({ name: 'Source', ownerUserId: 'alice' }));
  const destination = (await store.createOrganization({ name: 'Destination', ownerUserId: 'alice' }));
  (await authorization.bootstrapOrganizationOwner('system:test', 'alice', source.id));
  (await authorization.bootstrapOrganizationOwner('system:test', 'alice', destination.id));
  const project = (await store.createProject('Project', {}, source.id));
  (await store.setProjectMembership(project.id, { kind: 'user', userId: 'alice' }, 'owner'));
  const worlds = new WorldRegistry();
  const client = { workflow: { getHandle: () => ({ describe: async () => ({ status: { name: 'COMPLETED' } }) }) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, authorization, taskQueue: 'test' });
  const gateway = await Gateway.create({ api, store, tokens, client, worlds, authorization, taskQueue: 'test', staticDir: options.fullApp ? path.resolve('web') : dir,
    providerConnections: { resolve: (organizationId: string) => ({ apiKey: `test-key-${organizationId}`, config: {} }), list: () => [] } as any,
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    identity: { sessionActive: async (id: string, userId: string) => id === 'session-alice' && userId === 'alice',
      connectOrganizationNames: () => {}, session: async (headers: Headers) => headers.get('cookie') === 'test=alice'
      ? { user: { id: 'alice', name: 'Alice', email: 'alice@example.com' }, session: { id: 'session-alice' } } : undefined,
      providersForUser: () => [], providersForUserAsync: async () => [], listUsers: () => [] } as any,
    agentInfo: { provider: 'mock', reason: 'test' } });
  const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
  cleanups.push(async () => { await server.close(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = (route: string, body?: unknown, bearer?: string) => fetch(server.url + route, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: 'test=alice' }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const route = `/api/projects/${project.id}/transfer`;
  return { store, tokens, authorization, source, destination, project, request, route, api, client, server, dir, gateway };
}

describe('project transfer HTTP authorization', () => {
  it('lets a cookie session authorized in both organizations preview and move', async () => {
    const f = await fixture();
    const access = await f.request(`/api/settings/access?projectId=${f.project.id}`);
    expect(await access.json()).toMatchObject({ projectTransfer: true });
    const destinations = await f.request(f.route);
    expect(destinations.status).toBe(200);
    expect(await destinations.json()).toEqual({ organizations: [{ id: f.destination.id, name: 'Destination' }] });
    const response = await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`);
    expect(response.status).toBe(200);
    const preview = await response.json() as any;
    expect(preview.blockers).toEqual([]);
    const result = await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: preview.id });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({ id: f.project.id, organizationId: f.destination.id });
    expect((await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: preview.id })).status).toBe(200);
  });

  it('does not widen source-only delegated authority using the human grantor', async () => {
    const f = await fixture();
    const token = (await f.tokens.mint({ taskId: 'agent', profileId: 'administrator', principal: 'user:alice', organizationId: f.source.id,
      ceiling: ['*'], grantorCaps: ['*'] })).token;
    expect((await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`, undefined, token)).status).toBe(403);
    expect(await (await f.request(f.route, undefined, token)).json()).toEqual({ organizations: [] });
    expect((await f.store.getProject(f.project.id))?.organizationId).toBe(f.source.id);
  });

  it('supports explicitly authorized unscoped agents through the identical API', async () => {
    const f = await fixture();
    const token = (await f.tokens.mint({ taskId: 'agent', profileId: 'transfer', principal: 'system:migrator',
      ceiling: ['project:read', 'project:transfer-out', 'project:transfer-in'], grantorCaps: ['*'] })).token;
    const preview = await (await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`, undefined, token)).json() as any;
    expect(preview.blockers).toEqual([]);
    expect((await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: preview.id }, token)).status).toBe(200);
  });

  it('rejects project-only authority and mismatched previews', async () => {
    const f = await fixture();
    const token = (await f.tokens.mintPrincipal('user:alice', ['*'], f.project.id)).token;
    expect((await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`, undefined, token)).status).toBe(403);
    expect((await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: 'invented' })).status).toBe(409);
  });

  it('rechecks revoked destination permission without changing data', async () => {
    const f = await fixture();
    const preview = await (await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`)).json() as any;
    (await f.store.deletePrincipalGrant('user:alice', `organization:${f.destination.id}`));
    expect((await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: preview.id })).status).toBe(403);
    expect((await f.store.getProject(f.project.id))?.organizationId).toBe(f.source.id);
  });

  it('rolls back a new draft if persisting its delegated authority fails', async () => {
    const f = await fixture();
    vi.spyOn(f.tokens, 'delegateAuthorizedInteractiveHuman').mockRejectedValue(new Error('delegation unavailable'));
    const response = await f.request(`/api/projects/${f.project.id}/tasks`, {
      title: 'Atomic draft', workflow: 'just-do', draft: true, prompt: 'test',
    });
    expect(response.status).toBe(500);
    expect(await f.store.listTasks(f.project.id)).toEqual([]);
  });

  it('rejects a destination whose SSO requirements the browser does not meet', async () => {
    const f = await fixture();
    (await f.store.setOrganizationIdentityPolicy({ organizationId: f.destination.id, enforceSso: true, oidcProviderId: 'required-provider', verifiedDomains: [] }));
    expect((await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`)).status).toBe(403);
  });
});

describe.runIf(fs.existsSync(chromium.executablePath()))('project transfer browser flow', () => {
  it('recovers an abandoned build from the full settings page and permits rebuilding', async () => {
    const f = await fixture({ fullApp: true });
    const environments = new environmentRecords.ProjectEnvironment(f.store);
    const spec = (await environments.setSpec(f.project.id, { setup: ['echo test'] }));
    const digest = environments.digest(spec);
    (await environmentRecords.beginEnvironmentBuild(f.store, f.project.id, { organizationId: f.source.id, transferGeneration: '' }, 'worktree', digest));
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    cleanups.push(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'test', value: 'alice', url: f.server.url }]);
    await page.goto(`${f.server.url}/source/project/settings`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-environment-recover]').click();
    const dialog = page.getByRole('dialog');
    const confirmation = await dialog.innerText();
    await dialog.getByRole('textbox').fill('The old gateway is stopped; no host artifact exists.');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(async () => (await environments.builds(f.project.id))[0]?.status).toBe('failed');
    expect(confirmation).toContain('does not stop or delete provider resources for you');
    expect(confirmation).toContain('another gateway');
    await page.locator('#environment-build').click();
    await expect.poll(async () => (await environments.readyBuild(f.project.id, 'worktree', digest))?.ref).toBe('host');
    expect(errors).toEqual([]);
  });

  it('moves from Advanced settings using the complete app and keeps destination routing after reload', async () => {
    const f = await fixture({ fullApp: true });
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    cleanups.push(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'test', value: 'alice', url: f.server.url }]);
    await page.goto(`${f.server.url}/source/project/settings`, { waitUntil: 'domcontentloaded' });
    await page.locator('.settings-nav a[href="#project-advanced"]').click();
    await page.locator('#move-project').click();
    await page.selectOption('[data-destination]', f.destination.id);
    await page.waitForFunction("!document.querySelector('[role=dialog] [type=submit]')?.disabled");
    await page.locator('[role="dialog"] [type="submit"]').click();
    await page.waitForURL('**/destination/project/settings');
    await page.locator('.settings-nav a[href="#project-advanced"]').click();
    await page.waitForSelector('#project-name');
    expect((await f.store.getProject(f.project.id))?.organizationId).toBe(f.destination.id);
    expect(await page.locator('#org-switcher input').inputValue()).toContain('Destination');
    expect(new URL(page.url()).pathname).toBe('/destination/project/settings');
    expect(await page.locator('#project-name').inputValue()).toBe('Project');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.settings-nav a[href="#project-advanced"]').click();
    expect(await page.locator('#move-project').isVisible()).toBe(true);
    expect(await page.locator('#org-switcher input').inputValue()).toContain('Destination');
    expect(errors).toEqual([]);
  });

  it('previews, handles a stale plan, and moves through the real HTTP API', async () => {
    const f = await fixture();
    fs.writeFileSync(path.join(f.dir, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><button id="move">Move to organization…</button><div id="modal-root"></div></body></html>');
    const source = fs.readFileSync('web/app.js', 'utf8');
    const parsed = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const move = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'moveProject')!.getText(parsed);
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    cleanups.push(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'test', value: 'alice', url: f.server.url }]);
    await page.goto(f.server.url);
    await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
    await page.evaluate(({ project, organization, move }) => {
      const w = globalThis as any;
      const document = w.document;
      w.S = { projectId: project.id, organizationId: project.organizationId, projects: [project] };
      w.$ = (selector: string) => document.querySelector(selector);
      w.esc = (value: string) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
      w.api = async (url: string, options: any = {}) => {
        const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json' } });
        const value = await response.json() as any;
        if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
        return value;
      };
      w.loadProjects = async () => { w.S.projects = await w.api('/api/projects'); };
      w.projectById = (id: string) => w.S.projects.find((p: any) => p.id === id);
      w.organizationById = () => organization;
      w.projectRoute = (id: string) => `/moved/${id}/settings`;
      w.globalRoute = () => '/destination/insights';
      w.go = async (route: string) => { w.visited = route; };
      w.toast = (message: string) => { w.notice = message; };
      w.eval(move);
      document.querySelector('#move')!.addEventListener('click', () => w.moveProject(project));
    }, { project: f.project, organization: f.destination, move });
    await page.click('#move');
    await page.waitForFunction("!document.querySelector('[data-destination]')?.disabled");
    await page.keyboard.press('Escape');
    expect(await page.locator('[role="dialog"]').count()).toBe(0);
    expect(await page.locator('#move').evaluate(el => el === (globalThis as any).document.activeElement)).toBe(true);
    await page.click('#move');
    await page.selectOption('[data-destination]', f.destination.id);
    await page.waitForFunction("!document.querySelector('[type=submit]')?.disabled");
    expect(await page.locator('[data-preview]').textContent()).toContain('History preserved');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    if (process.env.KARMAX_TRANSFER_SCREENSHOT) await page.screenshot({ path: process.env.KARMAX_TRANSFER_SCREENSHOT });
    // A second administrator changes destination policy while the dialog is open.
    (await f.store.setSettings(`organization:${f.destination.id}`, '__common__', { prompt: 'new defaults' }));
    await page.click('[type="submit"]');
    await page.waitForSelector('[data-error] button');
    expect((await f.store.getProject(f.project.id))?.organizationId).toBe(f.source.id);
    await page.click('[data-error] button');
    await page.waitForFunction("!document.querySelector('[type=submit]')?.disabled");
    await page.click('[type="submit"]');
    await page.waitForFunction("Boolean(window.visited)");
    expect((await f.store.getProject(f.project.id))?.organizationId).toBe(f.destination.id);
    expect(await page.evaluate("window.visited")).toBe(`/moved/${f.project.id}/settings`);
    expect(errors).toEqual([]);
  });
});

function deferredBuild() {
  let resolve!: (value: environmentBuilder.EnvironmentBuildResult) => void, reject!: (error: Error) => void;
  const promise = new Promise<environmentBuilder.EnvironmentBuildResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('environment builds across project transfers', () => {
  it.each(['success', 'failure'])('requires authorized cleanup confirmation and fences a late %s after HTTP recovery', async outcome => {
    const f = await fixture();
    const environments = new environmentRecords.ProjectEnvironment(f.store);
    const spec = (await environments.setSpec(f.project.id, { setup: ['echo test'] }));
    const digest = environments.digest(spec);
    const old = deferredBuild(), current = deferredBuild();
    vi.spyOn(environmentBuilder, 'buildEnvironment').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const finish = vi.spyOn(environmentRecords, 'finishEnvironmentBuild');
    const base = `/api/projects/${f.project.id}/environment`;
    expect((await f.request(base + '/build', { provider: 'e2b' })).status).toBe(202);
    const { builds } = await (await f.request(base)).json() as any;
    const request = { provider: 'e2b', digest, revision: builds[0].recoveryRevision, cleanupConfirmed: true,
      cleanupNote: 'Stopped source provider build and deleted its snapshot.' };
    const reader = (await f.tokens.mintPrincipal('user:reader', ['project:read', 'project:settings:read'], f.project.id, 60_000, f.source.id)).token;
    expect((await f.request(base + '/build/recover', request, reader)).status).toBe(403);
    expect((await f.request(base + '/build/recover', { ...request, cleanupConfirmed: false })).status).toBe(400);
    expect((await environments.builds(f.project.id))[0]?.status).toBe('building');
    expect((await f.request(base + '/build/recover', request)).status).toBe(200);
    const preview = await (await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`)).json() as any;
    expect(preview.blockers).toEqual([]);
    expect((await f.request(base + '/build', { provider: 'e2b' })).status).toBe(202);
    expect((await f.request(base + '/build/recover', request)).status).toBe(400);
    current.resolve({ ref: 'new-snapshot' });
    await expect.poll(async () => (await environments.readyBuild(f.project.id, 'e2b', digest))?.ref).toBe('new-snapshot');
    if (outcome === 'success') old.resolve({ ref: 'abandoned-snapshot' });
    else old.reject(new Error('abandoned build failed'));
    await expect.poll(() => finish.mock.calls.length).toBe(2);
    expect(await finish.mock.results[1]?.value).toBe(false);
    expect((await environments.readyBuild(f.project.id, 'e2b', digest))?.ref).toBe('new-snapshot');
  });

  it('blocks active builds and duplicate launches, then invalidates the old preview when the build finishes', async () => {
    const f = await fixture();
    const environments = new environmentRecords.ProjectEnvironment(f.store);
    const spec = (await environments.setSpec(f.project.id, { setup: ['echo test'] }));
    const digest = environments.digest(spec);
    const pending = deferredBuild();
    const build = vi.spyOn(environmentBuilder, 'buildEnvironment').mockReturnValue(pending.promise);
    const before = await (await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`)).json() as any;
    const buildRoute = `/api/projects/${f.project.id}/environment/build`;
    expect((await f.request(buildRoute, { provider: 'e2b' })).status).toBe(202);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ connection: expect.objectContaining({ apiKey: `test-key-${f.source.id}` }) }));
    const active = await (await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`)).json() as any;
    expect(active.blockers).toContainEqual(expect.objectContaining({ code: 'environment-builds' }));
    expect((await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: before.id })).status).toBe(409);
    expect((await f.request(buildRoute, { provider: 'e2b' })).status).toBe(400);
    expect(build).toHaveBeenCalledTimes(1);
    pending.resolve({ ref: 'source-private-snapshot' });
    await expect.poll(async () => (await environments.readyBuild(f.project.id, 'e2b', digest))?.ref).toBe('source-private-snapshot');
    // The build history itself participates in the plan, even once inactive.
    expect((await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: before.id })).status).toBe(409);
    const fresh = await (await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`)).json() as any;
    expect(fresh.blockers).toEqual([]);
    expect((await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: fresh.id })).status).toBe(200);
    expect((await selectProjectEnvironment(f.store, f.project.id, 'e2b', undefined)).built).toBe(false);
  });

  it.each([
    { outcome: 'success', roundTrip: false }, { outcome: 'failure', roundTrip: false },
    { outcome: 'success', roundTrip: true }, { outcome: 'failure', roundTrip: true },
  ])('fences a late $outcome callback across transfer (round trip: $roundTrip)', async ({ outcome, roundTrip }) => {
    const f = await fixture();
    const environments = new environmentRecords.ProjectEnvironment(f.store);
    const spec = (await environments.setSpec(f.project.id, { setup: ['echo test'] }));
    const digest = environments.digest(spec);
    const old = deferredBuild(), current = deferredBuild();
    vi.spyOn(environmentBuilder, 'buildEnvironment').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const finish = vi.spyOn(environmentRecords, 'finishEnvironmentBuild');
    const buildRoute = `/api/projects/${f.project.id}/environment/build`;
    expect((await f.request(buildRoute, { provider: 'e2b' })).status).toBe(202);
    // Fault injection: reproduce missing bookkeeping from an old gateway or
    // recovery process while its provider promise still exists. Normal active
    // builds are blocked above; the completion fence must be independent of it.
    (await f.store.kvDelete(`project-environment-builds:${f.project.id}`));
    const move = async (destinationOrganizationId: string) => {
      const preview = await (await f.request(f.route + `?destinationOrganizationId=${destinationOrganizationId}`)).json() as any;
      expect(preview.blockers).toEqual([]);
      expect((await f.request(f.route, { destinationOrganizationId, previewId: preview.id })).status).toBe(200);
    };
    await move(f.destination.id);
    if (roundTrip) await move(f.source.id);
    expect((await f.request(buildRoute, { provider: 'e2b' })).status).toBe(202);
    current.resolve({ ref: 'current-generation-snapshot' });
    await expect.poll(async () => (await environments.readyBuild(f.project.id, 'e2b', digest))?.ref).toBe('current-generation-snapshot');
    const beforeCompletion = (await environments.builds(f.project.id));
    if (outcome === 'success') old.resolve({ ref: 'source-org-private-snapshot' });
    else old.reject(new Error('source build failed late'));
    await expect.poll(() => finish.mock.calls.length).toBe(2);
    expect(await finish.mock.results[1]?.value).toBe(false);
    expect((await environments.builds(f.project.id))).toEqual(beforeCompletion);
    expect((await selectProjectEnvironment(f.store, f.project.id, 'e2b', undefined)).environment?.snapshot).toBe('current-generation-snapshot');
    // Legacy callbacks have no provenance: even direct writes cannot make
    // their source-owned artifact selectable after any transfer generation.
    (await environments.recordBuild(f.project.id, { provider: 'e2b', digest, status: 'ready', ref: 'legacy-source-snapshot' }));
    expect((await environments.readyBuild(f.project.id, 'e2b', digest))).toBeUndefined();
    expect((await selectProjectEnvironment(f.store, f.project.id, 'e2b', undefined)).built).toBe(false);
  });
});

describe('project transfer and deletion races', () => {
  it('blocks a move while external project deletion is in progress', async () => {
    const f = await fixture();
    const task = (await f.store.createTask({ projectId: f.project.id, title: 'History', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'history' } }));
    (await f.store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done' } as any));
    const preview = await (await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`)).json() as any;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.client.workflow.getHandle = () => ({ terminate: async () => { entered(); await waiting; } });
    const deleting = fetch(`${f.server.url}/api/projects/${f.project.id}`, { method: 'DELETE', headers: { cookie: 'test=alice' } });
    await started;
    const attempt = await f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: preview.id });
    expect(attempt.status).toBe(409);
    release();
    expect((await deleting).status).toBe(200);
    expect((await f.store.getProject(f.project.id))).toBeUndefined();
  });

  it('blocks deletion while a move verifies closed workflows', async () => {
    const f = await fixture();
    const task = (await f.store.createTask({ projectId: f.project.id, title: 'History', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'history' } }));
    (await f.store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done' } as any));
    const preview = await (await f.request(f.route + `?destinationOrganizationId=${f.destination.id}`)).json() as any;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.client.workflow.getHandle = () => ({ describe: async () => { entered(); await waiting; return { status: { name: 'COMPLETED' } }; } });
    const moving = f.request(f.route, { destinationOrganizationId: f.destination.id, previewId: preview.id });
    await started;
    const deleting = await fetch(`${f.server.url}/api/projects/${f.project.id}`, { method: 'DELETE', headers: { cookie: 'test=alice' } });
    expect(deleting.status).toBe(403);
    release();
    expect((await moving).status).toBe(200);
    expect((await f.store.getProject(f.project.id))?.organizationId).toBe(f.destination.id);
  });
});
