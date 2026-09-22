import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { prepareConnections } from '../src/mcp/connections/runtime.js';
import { connectWorldMcp } from '../src/mcp/connections/client.js';
import { registrySearch } from '../src/mcp/connections/registry.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import { DaytonaWorldProvider } from '../src/world/daytona.js';
import { ContainerWorldProvider, dockerAvailable } from '../src/world/container.js';
import { WorktreeProvider } from '../src/world/worktree.js';

// Opt-in, explicit gates: selecting a deployment with missing infrastructure
// FAILS instead of reporting a skipped smoke test as successful verification.
const target = process.env.KARMAX_MCP_LIVE_WORLD;
if (target && !['container', 'e2b', 'daytona'].includes(target)) throw new Error('KARMAX_MCP_LIVE_WORLD must be container, e2b or daytona');
describe.skipIf(!target)('MCP real deployment boundary', () => {
  it('runs a server in the selected world, projects only scoped credentials, and removes its lease', async () => {
    if (target === 'container' && !await dockerAvailable()) throw new Error('Docker is required for the requested deployment test');
    if (target === 'e2b' && !process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required for the requested deployment test');
    if (target === 'daytona' && !process.env.DAYTONA_API_KEY) throw new Error('DAYTONA_API_KEY is required for the requested deployment test');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-deployment-')); const store = (await Store.create(':memory:'));
    let cleanup: (() => Promise<void>) | undefined;
    const provider = target === 'container' ? new ContainerWorldProvider(path.join(dir, 'worlds')) : target === 'e2b' ? new E2BWorldProvider() : new DaytonaWorldProvider();
    let world: Awaited<ReturnType<typeof provider.create>> | undefined;
    try {
      world = await provider.create({ taskId: `mcp-live-${Date.now()}`, base: 'main', network: { unrestricted: true } });
      const root = target === 'container' ? '/work' : world.handle.root;
      await world.writeFile('.fixture/mcp-server.mjs', fs.readFileSync(path.resolve('tests/fixtures/mcp-hostile.mjs'), 'utf8'));
      const project = (await store.createProject('Deployment test'));
      const service = new McpConnections(store, new CredentialBroker(new Vault(path.join(dir, 'vault'))), 'org_personal');
      const c = (await service.save({ label: 'Deployment', transport: { type: 'stdio', command: 'node', args: [root + '/.fixture/mcp-server.mjs'] }, auth: 'secrets', secrets: { FIXTURE_SECRET: 'deployment-only' } }, project.id));
      const specs = await prepareConnections(service, world, [c.id], project.id, 'deployment', (fn) => { cleanup = fn; });
      const client = await connectWorldMcp(world, specs[0]!);
      try {
        const result = await client.callTool({ name: 'echo', arguments: { text: 'deployment round trip' } }) as any;
        expect(JSON.parse(result.content[0].text)).toMatchObject({ text: 'deployment round trip', cwd: root, secret: 'deployment-only', platform: null });
        expect((await client.listPrompts()).prompts[0]?.name).toBe('greet');
      } finally { await client.close(); }
      await cleanup!(); cleanup = undefined;
      const result = await world.exec('find', [root + '/.karmax-injection/mcp', '-name', `${c.id}.json`]);
      expect(result.stdout.trim()).toBe('');
    } finally { await cleanup?.(); try { await world?.destroy(); } finally { (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); } }
  }, 300_000);
});

describe.skipIf(process.env.KARMAX_MCP_LIVE_NETWORK !== '1')('Live Official Registry and public MCP', () => {
  it('imports Microsoft Learn and calls its real documentation tool through the task relay', async () => {
    const result = await registrySearch('microsoft-learn');
    const entry = result.servers.find((s: any) => s.name === 'com.microsoft/microsoft-learn-mcp');
    expect(entry).toBeDefined();
    const option = entry.options.find((o: any) => o.transport.type === 'http' && o.transport.url === 'https://learn.microsoft.com/api/mcp');
    expect(option).toBeDefined();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-network-')); const store = (await Store.create(':memory:')); let cleanup: (() => Promise<void>) | undefined;
    try {
      const world = await new WorktreeProvider(path.join(dir, 'worlds')).create({ taskId: 'network', base: 'main' });
      const project = (await store.createProject('Network test'));
      const service = new McpConnections(store, new CredentialBroker(new Vault(path.join(dir, 'vault'))), 'org_personal');
      const c = (await service.save({ label: entry.title, transport: option.transport, registry: { name: entry.name, version: entry.version } }, project.id));
      const specs = await prepareConnections(service, world, [c.id], project.id, 'network', (fn) => { cleanup = fn; });
      const client = await connectWorldMcp(world, specs[0]!);
      try {
        expect((await client.listTools()).tools.map((t) => t.name)).toContain('microsoft_docs_search');
        const result = await client.callTool({ name: 'microsoft_docs_search', arguments: { query: 'Azure storage overview' } }) as any;
        expect(result.isError).not.toBe(true); expect(result.content.length).toBeGreaterThan(0);
      } finally { await client.close(); }
    } finally { await cleanup?.(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
