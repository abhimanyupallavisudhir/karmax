import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerClient } from '../src/agent/codex-app-server-client.js';
import { selectedCodexMcpFlags } from '../src/mcp/connections/codex-selection.js';
import { prepareConnections } from '../src/mcp/connections/runtime.js';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { withTimeout } from '../src/util/timeout.js';
const binary = process.env.KARMAX_MCP_CODEX_BINARY ?? 'codex';
const available = spawnSync(binary, ['--version'], { timeout: 5000, stdio: 'ignore' }).status === 0;

describe.skipIf(!available)('Native Codex MCP startup (no login or model calls)', () => {
  it('loads the actual sandbox relay and discovers its tool inventory with explicit selection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-native-')); const store = (await Store.create(':memory:'));
    let cleanup: (() => Promise<void>) | undefined; let child: ReturnType<typeof spawn> | undefined;
    try {
      const world = await new WorktreeProvider(path.join(dir, 'worlds')).create({ taskId: 'native', base: 'main' });
      const project = (await store.createProject('Native test'));
      const service = new McpConnections(store, new CredentialBroker(new Vault(path.join(dir, 'vault'))), 'org_personal');
      const c = (await service.save({ label: 'Native fixture', transport: { type: 'stdio', command: process.execPath, args: [path.resolve('tests/fixtures/mcp-hostile.mjs')] } }, project.id));
      const specs = await prepareConnections(service, world, [c.id], project.id, 'native', (fn) => { cleanup = fn; });
      // A broken account baseline must be overridden, not accidentally launched.
      const legacyMarker = path.join(dir, 'legacy-started');
      fs.writeFileSync(path.join(dir, 'config.toml'), `[mcp_servers.legacy]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(path.resolve('tests/fixtures/mcp-hostile.mjs'))}]\n[mcp_servers.legacy.env]\nFIXTURE_PID_FILE=${JSON.stringify(legacyMarker)}\n`);
      const env = { PATH: process.env.PATH!, HOME: dir, CODEX_HOME: dir };
      const flags = await selectedCodexMcpFlags(world, binary, dir, env, specs, true);
      child = spawn(binary, ['app-server', ...flags], { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'] });
      const rpc = new CodexAppServerClient(child.stdin!, child.stdout!);
      await withTimeout(rpc.request('initialize', { clientInfo: { name: 'mcp-test', version: '1' }, capabilities: { experimentalApi: true } }), 5000);
      rpc.notify('initialized');
      await expect.poll(async () => {
        const inventory = await withTimeout(rpc.request('mcpServerStatus/list', { cursor: null, limit: 100, detail: 'toolsAndAuthOnly', threadId: null }), 5000);
        expect(Object.keys(inventory.data.find((s: any) => s.name === 'legacy')?.tools ?? {})).toHaveLength(0);
        return Object.keys(inventory.data.find((s: any) => s.name === c.id)?.tools ?? {});
      }, { timeout: 20_000, interval: 250 }).toContain('echo');
      expect(fs.existsSync(legacyMarker)).toBe(false);
    } finally { child?.kill(); await cleanup?.(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
