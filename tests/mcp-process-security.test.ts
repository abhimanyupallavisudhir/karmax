import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectWorldMcp, apiMcpTools } from '../src/mcp/connections/client.js';
import { prepareConnections } from '../src/mcp/connections/runtime.js';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { WorktreeProvider } from '../src/world/worktree.js';

describe('Untrusted MCP processes', () => {
  let dir: string; const clients: { close(): Promise<void> }[] = [];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-process-')); });
  afterEach(async () => { await Promise.allSettled(clients.splice(0).map((c) => c.close())); fs.rmSync(dir, { recursive: true, force: true }); });
  const server = (mode = 'normal') => ({ name: 'untrusted', command: process.execPath, args: [path.resolve('tests/fixtures/mcp-hostile.mjs')], env: { FIXTURE_MODE: mode, FIXTURE_PID_FILE: path.join(dir, 'pid') } });
  const world = () => ({ handle: { kind: 'worktree', root: dir } }) as any;
  const exited = async () => { const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')); await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeout: 5000 }).toBe(true); };
  it.each(['oversize', 'unicode', 'invalid', 'crash'])('closes on %s responses without accepting the data', async (mode) => {
    const client = await connectWorldMcp(world(), server(mode)); clients.push(client);
    await expect(client.listTools(undefined, { timeout: 2000 }).then(() => true)).rejects.toThrow();
    await exited();
  });
  it.each([['many', /200 tools/], ['pages', /too many pages/], ['duplicate', /duplicate/i]] as const)('bounds the %s tool catalog and closes its process', async (mode, message) => {
    await expect(apiMcpTools(world(), [server(mode)]).then((api) => { clients.push(api); return true; })).rejects.toThrow(message);
    await exited();
  });
  it('cancels an in-flight request and closes its subprocess', async () => {
    const controller = new AbortController();
    const client = await connectWorldMcp(world(), server('hang'), controller.signal); clients.push(client);
    const pending = expect(client.listTools()).rejects.toThrow(); controller.abort(); await pending; await exited();
  });
  it('handles an unavailable executable without a hanging initialization', async () => {
    await expect(connectWorldMcp(world(), { name: 'missing', command: path.join(dir, 'does-not-exist') })).rejects.toThrow(/could not start/);
  }, 5000);
  it('exposes prompts and templates through API rails with stable names', async () => {
    const api = await apiMcpTools(world(), [server()]); clients.push(api);
    const get = api.tools.find((t) => t.description.includes('Get a prompt'))!;
    expect(await api.handlers[get.name]!({ name: 'greet' })).toMatchObject({ messages: [{ content: { text: 'Hello from MCP' } }] });
    const templates = api.tools.find((t) => t.description.includes('List resource templates'))!;
    expect(await api.handlers[templates.name]!({})).toEqual({ resourceTemplates: [] });
    const second = await apiMcpTools(world(), [server()]); clients.push(second);
    expect(second.tools.map((t) => t.name)).toEqual(api.tools.map((t) => t.name));
  });
  it.each(['revoked', 'expired', 'deleted'])('the sandbox relay stops when its credential lease is %s', async (reason) => {
    const store = (await Store.create(':memory:')); let cleanup: (() => Promise<void>) | undefined;
    try {
      const service = new McpConnections(store, new CredentialBroker(new Vault(path.join(dir, 'vault'))), 'org_personal');
      const project = (await store.createProject('Test'));
      const connection = (await service.save({ label: 'Fixture', transport: { type: 'stdio', command: process.execPath, args: server().args } }, project.id));
      const taskWorld = await new WorktreeProvider(path.join(dir, 'worlds')).create({ taskId: 'lease', base: 'main' });
      const specs = await prepareConnections(service, taskWorld, [connection.id], project.id, 'lease', (fn) => { cleanup = fn; });
      const client = await connectWorldMcp(taskWorld, specs[0]!); clients.push(client);
      const closed = new Promise<void>((resolve) => { client.onclose = resolve; });
      const config = specs[0]!.args![1]!;
      if (reason === 'deleted') fs.unlinkSync(config);
      else { const value = JSON.parse(fs.readFileSync(config, 'utf8')); if (reason === 'revoked') value.revoked = true; else value.leaseExpiresAt = 0; fs.writeFileSync(config, JSON.stringify(value)); }
      await closed;
      await expect(client.listTools()).rejects.toThrow();
    } finally { await cleanup?.(); (await store.close()); }
  }, 7000);
});
