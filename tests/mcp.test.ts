import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KarmaxApi } from '../src/platform/api.js';
import { createPlatformMcpServer, apiOps, httpOps } from '../src/platform/mcp.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';

describe('platform MCP server (capability-checked tool calls)', () => {
  let store: Store;
  let tokens: TokenAuthority;
  let api: KarmaxApi;
  let contentDir: string;
  let currentToken: string;
  let client: Client;

  beforeEach(async () => {
    store = new Store(':memory:');
    tokens = new TokenAuthority();
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-content-'));
    api = new KarmaxApi({ store, client: {} as any, taskQueue: 'karmax', tokens, contentDir });
    const server = createPlatformMcpServer(apiOps(api, () => currentToken));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);
  });
  afterEach(() => {
    fs.rmSync(contentDir, { recursive: true, force: true });
  });

  it('exposes the platform tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'create_task', 'save_skill', 'signal_task', 'reorder_queue', 'propose_workflow_edit',
        'search_tasks', 'list_tags', 'tag_task', 'set_task_priority',
      ]),
    );
  });

  it('lets an agent tag, prioritize, and search tasks by attribute', async () => {
    // Seed a project + two tasks directly in the store (createTask via MCP would start a
    // workflow, which this harness's mock client can't do).
    const pid = store.createProject('Acme').id;
    const a = store.createTask({ projectId: pid, title: 'Fix web login', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x', base: 'main' } as any });
    const b = store.createTask({ projectId: pid, title: 'Write docs', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'y', base: 'develop' } as any });
    currentToken = tokens.mint({
      taskId: 't1', profileId: 'do', principal: 'user:a',
      ceiling: ['read-task', 'edit-task'], grantorCaps: ['read-task', 'edit-task'],
    }).token;

    const raw = async (name: string, args: any) => {
      const res: any = await client.callTool({ name, arguments: args });
      expect(res.isError, res.content?.[0]?.text).toBeFalsy();
      return res.content[0].text as string;
    };
    const call = async (name: string, args: any) => JSON.parse(await raw(name, args));

    // tag_task creates a slash hierarchy on the fly and returns the resulting paths.
    const tagged = await call('tag_task', { taskId: a.id, add: ['bug', 'frontend/web'] });
    expect(tagged.tags.sort()).toEqual(['bug', 'frontend/web']);
    expect(await raw('set_task_priority', { taskId: a.id, priority: 'high' })).toMatch(/high/);

    // list_tags shows the hierarchy as paths.
    const tags = await call('list_tags', { projectId: pid });
    expect(tags.map((t: any) => t.path).sort()).toEqual(['bug', 'frontend', 'frontend/web']);

    // search by a parent tag matches the child-tagged task; compact projection carries paths + priority.
    const byParent = await call('search_tasks', { projectId: pid, query: 'tag:frontend priority:>=2' });
    expect(byParent.total).toBe(1);
    expect(byParent.tasks[0].id).toBe(a.id);
    expect(byParent.tasks[0].tags).toContain('frontend/web');
    expect(byParent.tasks[0].priority).toBe(3);

    // search by a workflow param (param.<key>) finds the other task.
    const byParam = await call('search_tasks', { projectId: pid, query: 'param.base:develop' });
    expect(byParam.tasks.map((t: any) => t.id)).toEqual([b.id]);

    // tag_task can remove by name too.
    const untagged = await call('tag_task', { taskId: a.id, remove: ['bug'] });
    expect(untagged.tags).toEqual(['frontend/web']);
  });

  it('denies search_tasks when the token lacks read-task', async () => {
    currentToken = tokens.mint({
      taskId: 't1', profileId: 'do', principal: 'user:a',
      ceiling: ['signal-completion'], grantorCaps: ['signal-completion'],
    }).token;
    const res: any = await client.callTool({ name: 'search_tasks', arguments: { projectId: 'p', query: '' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/permission denied/i);
  });

  it('permits a tool call when the token carries the capability', async () => {
    currentToken = tokens.mint({
      taskId: 't1',
      profileId: 'do',
      principal: 'user:a',
      ceiling: ['save-skill'],
      grantorCaps: ['save-skill'],
    }).token;
    const res: any = await client.callTool({ name: 'save_skill', arguments: { name: 'greet', content: '# hi' } });
    expect(res.isError).toBeFalsy();
    expect(fs.existsSync(path.join(contentDir, 'skills', 'greet.md'))).toBe(true);
  });

  it('denies a tool call when the token lacks the capability', async () => {
    currentToken = tokens.mint({
      taskId: 't1',
      profileId: 'do',
      principal: 'user:a',
      ceiling: ['signal-completion'], // no save-skill
      grantorCaps: ['signal-completion'],
    }).token;
    const res: any = await client.callTool({ name: 'save_skill', arguments: { name: 'x', content: 'y' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/permission denied/i);
  });
});
