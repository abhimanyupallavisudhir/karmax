import { TimingTrace, withTiming, timingReport } from '../src/timing/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { prepareConnections } from '../src/mcp/connections/runtime.js';
import { WorktreeProvider } from '../src/world/worktree.js';

/** Real adapter loops, HTTP model-protocol fixtures and real MCP subprocesses.
 * No model credentials or external services are used. */
describe('MCP across complete API agent turns', () => {
  let dir: string, store: Store, endpoint: http.Server | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const savedEnv = new Map<string, string | undefined>();
  beforeEach(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-turn-')); store = (await Store.create(':memory:')); });
  afterEach(async () => {
    if (endpoint) { endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint!.close(() => resolve())); }
    endpoint = undefined; await cleanup?.(); cleanup = undefined;
    for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } savedEnv.clear();
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });
  function setEnv(key: string, value: string) { savedEnv.set(key, process.env[key]); process.env[key] = value; }
  for (const provider of ['claude', 'codex'] as const) {
    for (const failure of [false, true]) it(`${provider}: ${failure ? 'cleans up when the model endpoint fails' : 'returns MCP tool and resource results to the model and completes'}`, async () => {
      const project = (await store.createProject('Test'));
      const service = new McpConnections(store, new CredentialBroker(new Vault(path.join(dir, 'vault'))), 'org_personal');
      const world = await new WorktreeProvider(path.join(dir, 'worlds')).create({ taskId: 'turn', base: 'main' });
      const pidFile = path.join(dir, 'server.pid');
      const connection = (await service.save({ label: 'Fixture', transport: { type: 'stdio', command: process.execPath,
        args: [path.resolve('tests/fixtures/mcp-connection.mjs')], env: { FIXTURE_PID_FILE: pidFile } } }, project.id));
      const servers = await prepareConnections(service, world, [connection.id], project.id, 'turn', (fn) => { cleanup = fn; });
      const requests: any[] = [];
      endpoint = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push(body);
        res.setHeader('content-type', 'application/json');
        if (failure) { res.writeHead(500); res.end('{"error":"fixture outage"}'); return; }
        const operation = requests.length === 1 ? 'echo' : 'Read a resource';
        const tool = body.tools.find((t: any) => t.description?.includes(operation));
        const args = requests.length === 1 ? { text: 'agent round trip' } : { uri: 'fixture://example' };
        const done = requests.length >= 3;
        res.end(JSON.stringify(provider === 'claude'
          ? { id: `message-${requests.length}`, stop_reason: done ? 'end_turn' : 'tool_use', content: done ? [{ type: 'text', text: 'MCP verified' }] : [{ type: 'tool_use', id: `call-${requests.length}`, name: tool.name, input: args }] }
          : { id: `response-${requests.length}`, status: 'completed', output: done ? [{ type: 'message', content: [{ type: 'output_text', text: 'MCP verified' }] }] : [{ type: 'function_call', call_id: `call-${requests.length}`, name: tool.name, arguments: JSON.stringify(args) }] }));
      });
      endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
      setEnv(provider === 'claude' ? 'KARMAX_ANTHROPIC_BASE_URL' : 'KARMAX_OPENAI_BASE_URL', `http://127.0.0.1:${(endpoint.address() as any).port}`);
      const adapter = provider === 'claude' ? new ClaudeAdapter() : new CodexAdapter();
      const timingRows: any[] = [];
      const trace = new TimingTrace({ taskId: 'turn', turnId: 'turn-1', attempt: 1 }, row => timingRows.push(row));
      const turn = (await withTiming(trace, () => trace.measure('agent.attempt', () => adapter.runTurn({ profile: { id: 'test', name: 'test', role: 'do', provider, mcpConnections: [connection.id] }, world, agentMcp: servers,
        role: 'do', systemPrompt: 'Test only', messages: [{ id: 'one', ts: 0, role: 'user', text: 'Use MCP' }], resolvedAuth: { apiKey: 'test-model-key' }, maxTurns: 4 },
      { emit() {}, emitActivity() {} } as any))));
      if (failure) await expect(turn).rejects.toThrow(/500/);
      else {
        expect((await turn).output).toBe('MCP verified'); expect(requests).toHaveLength(3);
        const results = requests.slice(1).map((r) => provider === 'claude'
          ? r.messages.filter((m: any) => m.role === 'user').at(-1).content[0].content : r.input[0].output);
        for (const value of results) expect(typeof value).toBe('string');
        expect(JSON.parse(results[0]).content[0].text).toContain('agent round trip');
        expect(JSON.parse(results[1]).contents[0].text).toBe('resource content');
        expect(requests[0].tools.some((t: any) => t.name === 'platform_request')).toBe(true);
      }
      const timing = timingReport(timingRows);
      expect(timing.attempts[0]?.status).toBe(failure ? 'failed' : 'ok');
      expect(timing.intervals.find(r => r.name === 'provider.roundtrip')?.count).toBe(failure ? 1 : 3);
      expect(timing.intervals.find(r => r.name === 'tool.discovery.native')?.count).toBeGreaterThan(0);
      if (!failure) expect(timing.intervals.find(r => r.name === 'tool.execution.native')?.count).toBe(2);
      expect(JSON.stringify(timingRows)).not.toContain('test-model-key');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
    });
  }
});
