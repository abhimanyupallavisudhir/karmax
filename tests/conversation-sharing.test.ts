import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { publicShare, currentShare } from '../src/gateway/conversation-sharing.js';

describe('public conversation sharing over HTTP', () => {
  const store = new Store(':memory:');
  const project = store.createProject('Sharing');
  const other = store.createProject('Other');
  const task = store.createTask({ projectId: project.id, title: '<script>title</script>', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'Share test' } });
  const tokens = new TokenAuthority();
  const owner = tokens.mintPrincipal('system:test', ['*']).token;
  const developer = tokens.mintPrincipal('system:developer', ['task:*', 'project:settings:read'], project.id).token;
  const viewer = tokens.mintPrincipal('system:viewer', ['task:read', 'task:conversation:read'], project.id).token;
  const foreign = tokens.mintPrincipal('system:foreign', ['task:*'], other.id).token;
  const messages = [
    { id: 's', role: 'system', text: 'hidden system', ts: 1 },
    { id: 'u', role: 'user', text: '<img src=x onerror=alert(1)> hello', ts: 2, files: [{ path: 'private-file' }] },
    { id: 'a', role: 'agent', text: 'Answer', ts: 3, sourceActivity: { id: 'private-tool' } },
  ];
  let base: string;
  let close: () => Promise<void>;
  const endpoint = `/api/tasks/${task.id}/conversation-share?role=merge`;
  const request = (url: string, method = 'GET', token = owner, body?: unknown) => fetch(`${base}${url}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const orgPolicy = (enabled: boolean) => request(`/api/organizations/${project.organizationId}/conversation-sharing`, 'PUT', owner, { enabled });
  beforeAll(async () => {
    const gateway = new Gateway({ store, tokens, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), client: {} as any, taskQueue: 'test', staticDir: 'web',
      api: { getTaskView: async () => ({ messages: [{ role: 'agent', text: 'wrong agent' }], transcripts: [{ role: 'merge', messages }] }) } as any,
      worlds: new WorldRegistry(), agentInfo: { provider: 'mock', reason: 'test' }, password: 'test-password',
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_700));
    base = running.url; close = running.close;
  });
  afterAll(async () => { await close?.(); store.close(); });

  it('defaults to disabled and reserves policy management for administrators', async () => {
    expect((await request(endpoint, 'POST', developer)).status).toBe(403);
    expect((await request(`/api/organizations/${project.organizationId}/conversation-sharing`, 'PUT', developer, { enabled: true })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/conversation-sharing`, 'PUT', developer, { value: 'inherit' })).status).toBe(403);
    expect((await orgPolicy(true)).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/conversation-sharing`, 'PUT', owner, { value: 'enabled' })).status).toBe(400);
  });
  it('rejects anonymous, read-only, cross-project and invalid-role requests', async () => {
    expect((await fetch(`${base}${endpoint}`, { method: 'POST' })).status).toBe(401);
    for (const token of [viewer, foreign]) {
      for (const method of ['GET', 'POST', 'DELETE']) expect((await request(endpoint, method, token)).status).toBe(403);
    }
    for (const method of ['GET', 'POST', 'DELETE']) expect((await request(`${endpoint}&projectId=${other.id}`, method, foreign)).status).toBe(403);
    expect((await request(endpoint.replace('merge', 'missing'), 'POST', developer)).status).toBe(404);
  });
  let sharedUrl: string;
  it('publishes only the selected agent as an escaped immutable anonymous snapshot', async () => {
    const response = await request(endpoint, 'POST', developer);
    expect(response.status).toBe(200);
    sharedUrl = (await response.json() as any).url;
    const publicResponse = await fetch(`${base}${sharedUrl}`);
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get('cache-control')).toBe('no-store');
    expect(publicResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await publicResponse.text();
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>');
    for (const hidden of ['wrong agent', 'private-file', 'private-tool', 'hidden system']) expect(html).not.toContain(hidden);
    messages.push({ id: 'later', role: 'agent', text: 'later message', ts: 4 });
    expect(await (await fetch(`${base}${sharedUrl}`)).text()).not.toContain('later message');
    expect((await (await request(endpoint, 'POST', developer)).json() as any).url).toBe(sharedUrl);
  });
  it('enforces both policies on existing links and allows revocation while disabled', async () => {
    const projectUrl = `/api/projects/${project.id}/conversation-sharing`;
    await request(projectUrl, 'PUT', owner, { value: 'disabled' });
    expect((await fetch(`${base}${sharedUrl}`)).status).toBe(404);
    expect((await request(endpoint, 'POST', developer)).status).toBe(403);
    await request(projectUrl, 'PUT', owner, { value: 'inherit' });
    expect((await fetch(`${base}${sharedUrl}`)).status).toBe(200);
    await orgPolicy(false);
    expect((await fetch(`${base}${sharedUrl}`)).status).toBe(404);
    expect((await request(endpoint, 'DELETE', developer)).status).toBe(200);
    await orgPolicy(true);
    expect((await fetch(`${base}${sharedUrl}`)).status).toBe(404);
    const next = (await (await request(endpoint, 'POST', developer)).json() as any).url;
    expect(next).not.toBe(sharedUrl);
    expect(await (await fetch(`${base}${next}`)).text()).toContain('later message');
  });
  it('removes snapshot data when its project is deleted', () => {
    const share = currentShare(store, task.id, 'merge')!;
    store.deleteProject(project.id);
    expect(publicShare(store, share.id)).toBeUndefined();
    expect(store.kvGet(`conversation-share:${share.id}`)).toBeUndefined();
  });
  it('binds sharing to its own capability', () => {
    expect(routeCapability('POST', endpoint.split('?')[0]!, new URL(`http://localhost${endpoint}`))).toBe('task:conversation:share');
  });
});
