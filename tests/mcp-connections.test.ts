import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveParamsLayers } from '../src/platform/params.js';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections, validateMcpSelection, validateTransport } from '../src/mcp/connections/store.js';
import { publicAddress, publicFetch, publicUrl } from '../src/mcp/connections/http.js';
import { registryEntry } from '../src/mcp/connections/registry.js';
import { prepareConnections, codexMcpFlags } from '../src/mcp/connections/runtime.js';
import { connectWorldMcp, apiMcpTools } from '../src/mcp/connections/client.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { applyAgentSpec, organizationProfileId, projectProfileId, roleDefaultProfile } from '../src/agent/profiles.js';

describe('MCP connections', () => {
  let dir: string, store: Store, broker: CredentialBroker, service: McpConnections, project: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-mcp-'));
    store = new Store(':memory:'); broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    service = new McpConnections(store, broker, 'org_personal'); project = store.createProject('Project').id;
  });
  afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const definition = { label: 'Work tools', transport: { type: 'http', url: 'https://example.com/mcp' }, auth: 'secrets', secrets: { Authorization: 'Bearer private' } };

  it('keeps credentials out of metadata, merges rotations, and revokes them on endpoint change', () => {
    const c = service.save(definition, project);
    expect(JSON.stringify(service.list(project))).not.toContain('Bearer private');
    expect(service.secret(c)).toEqual({ Authorization: 'Bearer private' });
    const rotated = service.save({ ...c, secrets: { 'X-API-Key': 'second' }, mergeSecrets: true }, project);
    expect(service.secret(rotated)).toEqual({ Authorization: 'Bearer private', 'X-API-Key': 'second' });
    const changed = service.save({ ...rotated, transport: { type: 'http', url: 'https://other.example/mcp' } }, project);
    expect(service.secret(changed)).toEqual({});
    expect(() => service.setSecret(c, { token: 'stale' })).toThrow(/changed/);
    service.remove(c.id, project);
    expect(broker.listHandles()).toEqual([]);
  });
  it('enforces tenant, project, and owning-scope boundaries independently of IDs', () => {
    const org = store.createOrganization({ name: 'Other' });
    const other = new McpConnections(store, broker, org.id);
    const c = service.save(definition, project);
    expect(() => other.get(c.id, project)).toThrow(/not found/);
    expect(() => other.save(definition, project)).toThrow(/does not belong/);
    expect(() => service.get(c.id, store.createProject('Sibling').id)).toThrow(/not found/);
    const shared = service.save(definition);
    expect(service.selected([shared.id], project)).toHaveLength(1);
    expect(() => service.remove(shared.id, project)).toThrow(/owning/);
    service.save({ ...c, enabled: false }, project);
    expect(() => service.selected([c.id], project)).toThrow(/disabled/);
  });
  it('validates selections and preserves explicit empty sets across provider/default changes', () => {
    expect(validateMcpSelection([])).toEqual([]);
    expect(validateMcpSelection(['composio:conn_abc123'])).toEqual(['composio:conn_abc123']);
    expect(service.selected(['composio:conn_abc123'], project)).toEqual([]);
    expect(() => validateMcpSelection(['composio:../../secret'])).toThrow();
    expect(() => validateMcpSelection(['karmax'])).toThrow();
    expect(validateMcpSelection(['browser:playwright', 'browser:chrome-devtools'])).toEqual(['browser:playwright', 'browser:chrome-devtools']);
    const base = { id: 'do-default', name: 'Agent', role: 'do', provider: 'claude' as const, mcpConnections: ['browser:playwright'] };
    store.upsertProfile(base);
    store.upsertProfile({ ...base, id: organizationProfileId('org_personal', 'do') });
    store.upsertProfile({ id: projectProfileId(project, 'do'), name: 'Agent', role: 'do', provider: 'codex' });
    expect(roleDefaultProfile(store, 'do', project)?.mcpConnections).toEqual(['browser:playwright']);
    expect(applyAgentSpec(base, { provider: 'codex', mcpConnections: [] }).mcpConnections).toEqual([]);
    expect(codexMcpFlags([], true)).toEqual(['-c', 'mcp_servers={}']);
    expect(codexMcpFlags([{ name: 'test-mcp', command: 'node', env: { TEST_KEY: 'value' } }])).toContain('mcp_servers.test-mcp.command="node"');
    expect(codexMcpFlags([{ name: 'test-mcp', command: 'node', env: { TEST_KEY: 'value' } }])).toContain('mcp_servers.test-mcp.env.TEST_KEY="value"');
    expect(() => codexMcpFlags([{ name: 'bad.name', command: 'node' }])).toThrow(/Invalid/);
  });
  it('defaults to Chrome DevTools through organization and project layers, including legacy profiles', () => {
    store.upsertProfile({ id: organizationProfileId('org_personal', 'do'), name: 'Agent', role: 'do', provider: 'codex' });
    expect(roleDefaultProfile(store, 'do', project)?.mcpConnections).toEqual(['browser:chrome-devtools']);
    store.upsertProfile({ id: 'do-default', name: 'Agent', role: 'do', provider: 'codex' });
    expect(roleDefaultProfile(store, 'do', project)?.mcpConnections).toEqual(['browser:chrome-devtools']);
    store.upsertProfile({ id: organizationProfileId('org_personal', 'do'), name: 'Agent', role: 'do', provider: 'codex', mcpConnections: [] });
    expect(roleDefaultProfile(store, 'do', project)?.mcpConnections).toEqual([]);
    store.upsertProfile({ id: projectProfileId(project, 'do'), name: 'Agent', role: 'do', provider: 'codex' });
    expect(roleDefaultProfile(store, 'do', project)?.mcpConnections).toEqual([]);
    expect(applyAgentSpec(roleDefaultProfile(store, 'do', project)!, { provider: 'codex', mcpConnections: ['browser:playwright'] }).mcpConnections).toEqual(['browser:playwright']);
  });
  it('prepares both selected browser MCPs', async () => {
    const servers = await prepareConnections(service, { handle: { kind: 'worktree', root: dir } } as any,
      ['browser:chrome-devtools', 'browser:playwright'], project, 'task', () => {});
    expect(servers.map(s => s.name)).toEqual(['chrome-devtools', 'playwright']);
  });
  it('prepares built-in tools without a vault but rejects saved connections without one', async () => {
    const world = { handle: { kind: 'worktree', root: dir } } as any;
    expect((await prepareConnections(undefined, world, ['browser:chrome-devtools'], project, 'task', () => {})).map(s => s.name))
      .toEqual(['chrome-devtools']);
    await expect(prepareConnections(undefined, world, ['mcp_' + 'a'.repeat(24)], project, 'task', () => {}))
      .rejects.toThrow('credential vault');
    const exec = vi.fn();
    expect(await prepareConnections(undefined, { handle: { version: 2, sealedProviderRef: 'test', root: dir }, exec } as any,
      [], project, 'task', () => {})).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
  it('inherits tools across parameter layers while preserving an explicit empty selection', () => {
    const manifest = { name: 'example', params: [{ name: 'agent:do', type: 'agent', role: 'do' }] } as any;
    const lower = { 'agent:do': { provider: 'claude', mcpConnections: ['browser:playwright'] } };
    expect(resolveParamsLayers(manifest, [{ 'agent:do': { provider: 'codex' } }, lower])['agent:do'])
      .toEqual({ provider: 'codex', mcpConnections: ['browser:playwright'] });
    expect(resolveParamsLayers(manifest, [{ 'agent:do': { provider: 'codex', mcpConnections: [] } }, lower])['agent:do'])
      .toEqual({ provider: 'codex', mcpConnections: [] });
  });
  it('runs the remote MCP protocol through the world PTY and gates initialization on the shell ready marker', async () => {
    let opened = false;
    const world = { handle: { version: 2, sealedProviderRef: 'test', root: dir }, openPty: async (spec: any) => {
      opened = true;
      const child = spawn('bash', ['-c', spec.command], { cwd: spec.cwd, env: { PATH: process.env.PATH, ...spec.env }, stdio: ['pipe', 'pipe', 'ignore'] });
      return {
        onData(fn: (s: string) => void) { const listener = (data: Buffer) => fn(data.toString()); child.stdout.on('data', listener); return () => child.stdout.off('data', listener); },
        onExit(fn: (code: number | null) => void) { child.on('exit', fn); return () => child.off('exit', fn); },
        async write(data: string) { child.stdin.write(data); }, async resize() {}, async close() { child.kill(); },
      };
    } } as any;
    const client = await connectWorldMcp(world, { name: 'fixture', command: process.execPath, args: [path.resolve('tests/fixtures/mcp-connection.mjs')] });
    try { expect(opened).toBe(true); expect((await client.listTools()).tools[0]?.name).toBe('echo'); }
    finally { await client.close(); }
  });
  it.each(['127.0.0.1', '10.2.3.4', '169.254.169.254', '100.64.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00::1', '2001:db8::1', '2001:0db8::1', 'fc00::1'])('blocks private/reserved address %s', (ip) => { expect(publicAddress(ip)).toBe(false); });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('allows global address %s', (ip) => { expect(publicAddress(ip)).toBe(true); });
  it('rejects SSRF URLs before network access and forbids privileged headers', async () => {
    for (const url of ['http://example.com', 'https://localhost', 'https://127.1', 'https://[::ffff:127.0.0.1]', 'https://user:pass@example.com', 'https://example.com:4505']) expect(() => publicUrl(url)).toThrow();
    await expect(publicFetch('https://127.0.0.1')).rejects.toThrow();
    expect(() => service.save({ ...definition, secrets: { Host: 'internal' } })).toThrow(/Reserved/);
    expect(() => validateTransport({ type: 'stdio', command: 'node', args: 'shell text' })).toThrow();
  });
  it('imports pinned official package metadata without accepting registry or command injection', () => {
    const raw = { name: 'io.example/tool', version: '1', packages: [{ registryType: 'npm', identifier: '@example/tool', version: '1.2.3', transport: { type: 'stdio' }, environmentVariables: [{ name: 'KEY', isSecret: true }] }] };
    const imported = registryEntry(raw);
    expect(imported.options[0]?.transport).toEqual({ type: 'stdio', command: 'npx', args: ['--yes', '--registry=https://registry.npmjs.org', '@example/tool@1.2.3'] });
    for (const patch of [{ identifier: '--eval=malicious' }, { version: 'latest' }, { registryBaseUrl: 'https://attacker.example' }, { runtimeArguments: [{ value: '--eval=bad' }] }]) expect(registryEntry({ ...raw, packages: [{ ...raw.packages[0], ...patch }] }).options).toEqual([]);
  });
  it('wraps container connections in docker exec and revokes credential projections after edits', async () => {
    const c = service.save({ label: 'Container tool', transport: { type: 'stdio', command: 'example', args: [] } }, project);
    const files = new Map<string, string>(); const commands: string[][] = [];
    const world = { handle: { kind: 'container', root: '/host/task', meta: { container: 'karmax-test' } },
      async exec(command: string, args: string[]) { commands.push([command, ...args]); return { code: 0, stdout: '', stderr: '' }; },
      async writeFile(file: string, content: string) { files.set(file, content); },
    } as any;
    let cleanup: (() => Promise<void>) | undefined;
    vi.useFakeTimers();
    try {
      const servers = await prepareConnections(service, world, [c.id], project, 'task', (fn) => { cleanup = fn; });
      expect(servers[0]).toMatchObject({ command: 'docker', args: ['exec', '-i', '-w', '/work', 'karmax-test', '/usr/local/bin/node', expect.stringMatching(/^\/work\//), expect.stringMatching(/^\/work\//)] });
      expect(commands.some((args) => args.some((arg) => arg.includes('/host/task')))).toBe(false);
      service.save({ ...c, enabled: false }, project);
      await vi.advanceTimersByTimeAsync(30_000);
      expect([...files.entries()].find(([name]) => name.endsWith('.next'))?.[1]).toBe('{"revoked":true}');
    } finally { await cleanup?.(); vi.useRealTimers(); }
  });
  it('refuses custom MCP preparation on a shared hosted worker', async () => {
    const previous = process.env.KARMAX_DEPLOYMENT; process.env.KARMAX_DEPLOYMENT = 'hosted';
    try {
      const exec = vi.fn();
      await expect(prepareConnections(service, { handle: { kind: 'worktree' }, exec } as any, [], project, 'task', () => {})).rejects.toThrow(/remote execution/);
      expect(exec).not.toHaveBeenCalled();
    } finally { if (previous === undefined) delete process.env.KARMAX_DEPLOYMENT; else process.env.KARMAX_DEPLOYMENT = previous; }
  });
  it('runs a real stdio server, preserves session state and resources, withholds platform credentials, and cleans private files', async () => {
    const world = await new WorktreeProvider(path.join(dir, 'worlds')).create({ taskId: 'fixture', base: 'main' });
    const c = service.save({ label: 'Fixture', transport: { type: 'stdio', command: process.execPath,
      args: [path.resolve('tests/fixtures/mcp-connection.mjs'), '{{FIXTURE_SECRET}}'] }, auth: 'secrets', secrets: { FIXTURE_SECRET: 'scoped-value' } }, project);
    let cleanup: (() => Promise<void>) | undefined;
    const old = process.env.KARMAX_TOKEN; process.env.KARMAX_TOKEN = 'must-not-leak';
    try {
      const servers = await prepareConnections(service, world, [c.id], project, 'fixture', (fn) => { cleanup = fn; });
      const config = servers[0]!.args![1]!;
      expect(fs.statSync(config).mode & 0o777).toBe(0o600);
      const client = await connectWorldMcp(world, servers[0]!);
      try {
        expect((await client.listTools()).tools[0]?.name).toBe('echo');
        for (const count of [1, 2]) {
          const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } }) as any;
          expect(JSON.parse(result.content[0].text)).toEqual({ count, text: 'hello', secret: 'scoped-value', argument: 'scoped-value', platform: null });
        }
        expect((await client.readResource({ uri: 'fixture://example' })).contents[0]).toMatchObject({ text: 'resource content' });
      } finally { await client.close(); }
      const api = await apiMcpTools(world, servers);
      try { const echo = api.tools.find((t) => t.description.includes('echo'))!; expect(echo.name).toMatch(/^mcp_[a-f0-9]{24}$/); expect(await api.handlers[echo.name]!({ text: 'API' })).toMatchObject({ content: [{ type: 'text' }] });
        const read = api.tools.find((t) => t.description.includes('Read a resource'))!; expect(await api.handlers[read.name]!({ uri: 'fixture://example' })).toMatchObject({ contents: [{ text: 'resource content' }] }); } finally { await api.close(); }
      await cleanup!(); expect(fs.existsSync(config)).toBe(false);
    } finally { if (old === undefined) delete process.env.KARMAX_TOKEN; else process.env.KARMAX_TOKEN = old; await cleanup?.(); }
  });
});
