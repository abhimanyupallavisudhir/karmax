import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_CLIENT_SECRET_HANDLE } from '../src/integrations/github-app.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';
import * as network from '../src/mcp/connections/http.js';

// GitHub's MCP server authorizes through github.com/login/oauth, which registers
// no clients on demand. "Connect for this task" signs in with the deployment's
// GitHub App instead, and the task's agent then calls GitHub's MCP server.
const GITHUB_MCP = 'https://api.githubcopilot.com/mcp/';
let dir: string, store: Store, base: string, close: () => Promise<void>, agent: string, org: string, taskId: string;
const signal = vi.fn(async () => {});
const mcpRequests: Array<{ authorization: string | null; method?: string }> = [];

beforeAll(async () => {
  vi.stubEnv('KARMAX_PUBLIC_URL', 'https://tavya.example');
  vi.spyOn(network, 'publicFetch').mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://api.githubcopilot.com/.well-known/oauth-protected-resource'))
      return Response.json({ resource: GITHUB_MCP, authorization_servers: ['https://github.com/login/oauth'], scopes_supported: ['repo'] });
    throw new Error(`Unexpected request ${url}`);
  });
  // A minimal GitHub MCP server: it refuses requests without GitHub's user token.
  vi.spyOn(network, 'publicStreamFetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const message = await request.json() as any;
    mcpRequests.push({ authorization: request.headers.get('authorization'), method: message.method });
    if (request.headers.get('authorization') !== 'Bearer ghu_user') return new Response('', { status: 401 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'github-mcp-server', version: '1' } }
      : { content: [{ type: 'text', text: `${message.params.name}: octocat` }] } });
  });

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-mcp-connection-'));
  store = await Store.create(':memory:');
  const broker = new CredentialBroker(new Vault(dir));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
  await broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey, INSTALLATION_SCOPE);
  await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'app-secret', INSTALLATION_SCOPE);
  const githubFetch = async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/login/oauth/access_token') return Response.json({ access_token: 'ghu_user', expires_in: 28800, refresh_token: 'ghr_user' });
    if (url.pathname === '/user') return Response.json({ id: 583231, login: 'octocat' });
    if (url.pathname === '/user/installations') return Response.json({ installations: [] });
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  };
  const githubApp = await GitHubAppService.create(store, broker, { appId: '123', appSlug: 'tavya', clientId: 'Iv1.tavya', fetch: githubFetch as typeof fetch });
  await store.claimPersonalOrganization('alice');
  org = (await store.createOrganization({ name: 'Team', ownerUserId: 'alice' })).id;
  const project = (await store.createProject('Project', {}, org)).id;
  taskId = (await store.createTask({ projectId: project, title: 'Triage issues', workflow: 'just-do', workflowVersion: '1.0.0',
    params: { prompt: 'Triage issues' }, createdBy: { kind: 'user', userId: 'alice' } })).id;
  const tokens = new TokenAuthority();
  const caps = ['task:read', 'connection:use'];
  agent = (await tokens.mint({ taskId, profileId: 'developer', role: 'do', principal: 'user:alice', projectId: project,
    organizationId: org, ceiling: caps, grantorCaps: caps })).token;
  const worlds = new WorldRegistry();
  const client = { workflow: { getHandle: () => ({ signal, query: async () => ({ status: 'waiting', stage: 'do' }) }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, broker, taskQueue: 'test', contentDir: dir });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, broker, githubApp,
    taskQueue: 'test', staticDir: dir, bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    agentInfo: { provider: 'mock', reason: 'GitHub MCP connection test' },
    identity: { sessionActive: async (id: string, userId: string) => id === userId, connectOrganizationNames: () => {}, listUsers: () => [],
      session: async () => ({ user: { id: 'alice', name: 'alice', email: 'alice@test.invalid' }, session: { id: 'alice' } }) } as any,
    authorization: { capabilitiesAsync: async () => ['*'], audit: () => {} } as any });
  const port = await findFreePortFrom(48_960);
  const server = await gateway.listen(port);
  base = `http://127.0.0.1:${port}`; close = server.close;
});
afterAll(async () => { await close?.(); await store?.close(); fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const api = (p: string, options: { method?: string; body?: unknown; token?: string } = {}) => fetch(base + p, {
  method: options.method ?? 'GET', redirect: 'manual',
  headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
  ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });

it('connects GitHub’s MCP server for a task through the deployment’s GitHub App', async () => {
  const requested = await (await api('/api/connections/request', { token: agent, method: 'POST', body: { mcp: GITHUB_MCP, why: 'Triage issues' } })).json() as any;
  expect(requested).toMatchObject({ status: 'needs_connection', connection: { mcp: { url: GITHUB_MCP, auth: 'github' } } });
  const id = requested.connection.id;

  // "Connect for this task": the person has no GitHub sign-in yet, so they go to GitHub.
  const started = await api(`/api/connections/connect?organizationId=${org}`, { method: 'POST', body: { id } });
  expect(started.status, await started.clone().text()).toBe(200);
  const result = await started.json() as any;
  expect(result).toMatchObject({ callback: 'github', connection: { status: 'connecting' } });
  const authorize = new URL(result.url);
  expect(`${authorize.origin}${authorize.pathname}`).toBe('https://github.com/login/oauth/authorize');
  expect(authorize.searchParams.get('client_id')).toBe('Iv1.tavya');
  expect(authorize.searchParams.get('redirect_uri')).toBe('https://tavya.example/api/github/oauth/callback');

  // GitHub returns to the App's callback, which finishes the task's connection.
  const returned = await api(`/api/github/oauth/callback?code=gh-code&state=${authorize.searchParams.get('state')}`);
  expect(returned.status).toBe(200);
  expect(await returned.text()).toContain('GitHub is connected');
  await vi.waitFor(async () => expect((await (await api(`/api/connections?taskId=${taskId}&organizationId=${org}`)).json() as any[])
    .find((c) => c.id === id)).toMatchObject({ status: 'active' }), { timeout: 10_000 });
  await vi.waitFor(() => expect(signal).toHaveBeenCalled(), { timeout: 10_000 });

  const called = await api(`/api/connections/${id}/execute`, { token: agent, method: 'POST', body: { tool: 'get_me', arguments: {} } });
  expect(called.status, await called.clone().text()).toBe(200);
  expect(await called.json()).toMatchObject({ content: [{ type: 'text', text: 'get_me: octocat' }] });
  expect(mcpRequests.filter((r) => r.method === 'tools/call')).toEqual([{ authorization: 'Bearer ghu_user', method: 'tools/call' }]);
  const exposed = JSON.stringify(await (await api('/api/connections', { token: agent })).json());
  for (const secret of ['ghu_user', 'ghr_user', 'app-secret']) expect(exposed).not.toContain(secret);
});
