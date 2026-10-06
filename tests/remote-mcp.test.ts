import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { appGrantFixture, type AppGrantFixture } from './helpers/app-grants.js';

/** tavya as a remote MCP server at /mcp, authenticated by the OAuth bearer. */
let f: AppGrantFixture;
beforeAll(async () => { f = await appGrantFixture(); });
afterAll(async () => { await f.g.close(); });

async function connect(bearer: string) {
  const client = new Client({ name: 'remote-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.g.url}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  return client;
}
const text = (result: any) => result.content.map((part: any) => part.text).join('\n');

describe('remote MCP server', () => {
  it('challenges an unauthenticated client towards the protected-resource metadata', async () => {
    const response = await fetch(`${f.g.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${f.g.url}/.well-known/oauth-protected-resource"`);
    const resource = await (await fetch(`${f.g.url}/.well-known/oauth-protected-resource`)).json();
    expect(resource).toMatchObject({ resource: `${f.g.url}/mcp`, authorization_servers: [f.g.url] });
    expect(await (await fetch(`${f.g.url}/.well-known/oauth-protected-resource/mcp`)).json()).toEqual(resource);
    const bad = await fetch(`${f.g.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer tva_bogus', 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // CORS preflight for browser-based clients.
    const preflight = await fetch(`${f.g.url}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('initializes, lists the out-of-task tools and runs them with the caller’s authority', async () => {
    const tokens = await f.deviceLogin({}, 'mcp-full');
    const client = await connect(tokens.access_token);
    try {
      expect(client.getServerVersion()?.name).toBe('tavya');
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['create_task', 'list_tasks', 'get_task', 'search_tasks', 'find_task',
        'signal_task', 'message_agent', 'tag_task', 'set_task_priority', 'get_conversation', 'read_wiki', 'search_wiki',
        'list_events', 'describe_platform', 'platform_request', 'list_connections']));
      for (const taskBound of ['open_pr', 'pause', 'start_job', 'stop_job', 'create_review_info', 'signal_completion',
        'raise_to_parent', 'escalate_to_human', 'request_permission', 'publish_task_branch', 'save_skill', 'get_credential'])
        expect(names).not.toContain(taskBound);
      const listed = await client.callTool({ name: 'platform_request', arguments: { method: 'GET', path: '/api/projects' } });
      expect(listed.isError).toBeFalsy();
      expect(text(listed)).toContain(f.site.id);
      const me = await client.callTool({ name: 'platform_request', arguments: { method: 'GET', path: '/api/user/me' } });
      expect(JSON.parse(text(me))).toMatchObject({ id: f.user.id, via: { kind: 'cli' } });
    } finally { await client.close(); }
  });

  it('refuses a tool call the token’s capabilities do not allow', async () => {
    const tokens = await f.deviceLogin({ level: 'viewer', projectIds: [f.site.id] }, 'mcp-viewer');
    const client = await connect(tokens.access_token);
    try {
      const refused = await client.callTool({ name: 'create_task', arguments: { projectId: f.site.id, title: 'no', prompt: 'no' } });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/permission denied.*task:create/);
      const outside = await client.callTool({ name: 'platform_request', arguments: { method: 'GET', path: `/api/projects/${f.docs.id}` } });
      expect(outside.isError).toBe(true);
    } finally { await client.close(); }
  });

  it('accepts a personal access token, and stops at once when it is revoked', async () => {
    const created = await f.call('POST', '/api/user/tokens', { cookie: f.cookie }, { name: 'mcp pat', expiresInDays: 1 });
    const client = await connect(created.body.token);
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(10);
      await f.call('DELETE', `/api/user/app-grants/${created.body.id}`);
      await expect(client.listTools()).rejects.toThrow();
    } finally { await client.close().catch(() => {}); }
  });
});

describe('MCP Registry entry', () => {
  it('lists the hosted /mcp endpoint under the tavya.io namespace', async () => {
    const fs = await import('node:fs');
    const entry = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
    expect(entry.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[\d-]+\/server\.schema\.json$/);
    expect(entry.name).toBe('io.tavya/tavya');
    expect(entry.description.length).toBeLessThanOrEqual(100); // the registry's limit
    expect(entry.remotes).toEqual([{ type: 'streamable-http', url: 'https://tavya.io/mcp' }]);
  });
});
