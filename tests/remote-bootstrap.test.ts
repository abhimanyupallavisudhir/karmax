import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/agent/codex.js';
import { remoteAgentHomeRelative, syncRemoteAgentHome } from '../src/agent/remote-process.js';
import { directorySandbox, freshCodexHome, newMeter, NO_LATENCY, sandboxRollout, stageRemoteRuntime,
  type SandboxLatency } from './helpers/directory-sandbox.js';

// LT-1, AD-12, AD-13: what a remote turn does before the model starts, and how
// much native history crosses the host ↔ sandbox boundary, against a directory
// that behaves like a remote world (benchmarks/remote-bootstrap.ts measures it).
const roots: string[] = [];
const temp = (prefix: string) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function codexFixture(options: { growth?: number; latency?: SandboxLatency; config?: string } = {}) {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-codex-home-');
  stageRemoteRuntime(root);
  freshCodexHome(localHome);
  fs.writeFileSync(path.join(localHome, 'config.toml'), options.config ?? 'model = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
  let session: string | undefined;
  const turn = async (extra: Record<string, unknown> = {}) => {
    const meter = newMeter();
    const world = directorySandbox(root, meter, { latency: options.latency ?? NO_LATENCY, growth: options.growth ?? 4096 });
    const result = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [], mcpConnections: [] },
      world, messages: [{ id: 'm', role: 'user', text: 'continue', ts: 0 }], systemPrompt: 'Do the task.', role: 'do',
      resolvedAuth: { configHome: localHome }, ...(session ? { session } : {}), ...extra,
    } as any, { emit() {}, emitActivity() {}, platformRequest: async () => [] } as any);
    expect(result.termination).toMatchObject({ kind: 'success' });
    session = result.session;
    return meter;
  };
  const home = () => path.join(root, remoteAgentHomeRelative('codex', localHome));
  const hostFile = () => fs.readdirSync(path.join(localHome, 'sessions'), { recursive: true }).map(String)
    .filter((name) => name.endsWith(`${session}.jsonl`)).map((name) => path.join(localHome, 'sessions', name))[0]!;
  return { root, localHome, turn, home, hostFile, hostCopy: () => fs.readFileSync(hostFile()), session: () => session! };
}

it('LT-1 starts a resumed remote Codex turn with one bootstrap command and no MCP listing process', async () => {
  const fixture = codexFixture();
  await fixture.turn();
  const meter = await fixture.turn();
  // Only the app-server starts: karmax reads its own seeded config instead of
  // launching `codex mcp list` in the sandbox.
  expect(meter.cliStarts).toEqual(['app-server']);
  // One command prepares the runtime, stops the previous writer, updates git's
  // exclude file, makes the home private and measures its history; then the
  // config files, the launcher and the terminal.
  expect(meter.execsAtModelStart).toBe(1);
  expect(meter.roundTripsAtModelStart).toBeLessThanOrEqual(6);
});

it('LT-1 still disables every server the seeded Codex config defines', async () => {
  const fixture = codexFixture({ config: [
    'model = "gpt-5.5"', '', '[mcp_servers.docs]', 'command = "docs-mcp"', 'args = [', '  "--x=1",', ']', '',
    '[mcp_servers."search-api"]', 'command = "search" # comment', '[mcp_servers."search-api".env]', 'TOKEN = "x"', '',
    '[mcp_servers]', 'inline = { command = "inline-mcp" }', 'dotted.command = "dotted-mcp"', '',
    '[notice]', 'text = """', '[mcp_servers.not-a-server]', '"""', '',
  ].join('\n') });
  const meter = await fixture.turn();
  expect(meter.cliStarts).toEqual(['app-server']);
  const disabled = [...meter.launches[0]!.matchAll(/mcp_servers\.([A-Za-z0-9_-]+)\.enabled=false/g)].map((match) => match[1]).sort();
  expect(disabled).toEqual(['docs', 'dotted', 'inline', 'search-api']);
});

it('LT-1 falls back to Codex itself for a config it cannot read', async () => {
  const fixture = codexFixture({ config: 'mcp_servers = { docs = { command = "docs-mcp" } }\n' });
  const meter = await fixture.turn();
  expect(meter.cliStarts).toEqual(['mcp list', 'app-server']);
});

it('LT-1 asks Codex when the sandbox has a system config layer karmax did not write', async () => {
  const fixture = codexFixture();
  fs.mkdirSync(path.join(fixture.root, '.etc-codex'));
  fs.writeFileSync(path.join(fixture.root, '.etc-codex', 'config.toml'), '[mcp_servers.system]\ncommand = "system-mcp"\n');
  const meter = await fixture.turn();
  expect(meter.cliStarts).toEqual(['mcp list', 'app-server']);
});

it('LT-1 reads account health while the selected MCP servers start', async () => {
  const fixture = codexFixture({ latency: { ...NO_LATENCY, accountReadMs: 300, roundTripMs: 20 } });
  const meter = await fixture.turn({ agentMcp: [{ name: 'fixture', command: 'fixture-mcp', args: [] }] });
  const at = (event: string) => meter.events.indexOf(event);
  expect(at('request mcpServerStatus/list')).toBeGreaterThanOrEqual(0);
  expect(at('request mcpServerStatus/list')).toBeLessThan(at('answer account/rateLimits/read'));
  // The thread and the model still start only after both.
  expect(at('request thread/start')).toBeGreaterThan(at('answer account/rateLimits/read'));
});

it('AD-13 moves only the new part of a resumed Codex history across the sandbox boundary', async () => {
  const growth = 64 * 1024;
  const fixture = codexFixture({ growth });
  for (let turn = 0; turn < 3; turn++) await fixture.turn();
  expect(fixture.hostCopy().length).toBeGreaterThan(3 * growth);
  const meter = await fixture.turn();
  // None of the unchanged history is uploaded again, and the export reads only
  // what this turn appended.
  expect(meter.uploaded).toBeLessThan(32 * 1024);
  expect(meter.downloaded).toBeLessThan(growth * 1.5 + 32 * 1024);
  expect(fixture.hostCopy()).toEqual(fs.readFileSync(sandboxRollout(fixture.home(), fixture.session())!));
});

it('AD-13 republishes history the sandbox lost, and exports a sandbox copy the host missed', async () => {
  const fixture = codexFixture({ growth: 8192 });
  await fixture.turn();
  await fixture.turn();
  const expected = fixture.hostCopy();
  // A replaced sandbox (a host-only retry): the host copy is published again.
  fs.rmSync(sandboxRollout(fixture.home(), fixture.session())!);
  await fixture.turn();
  expect(fixture.hostCopy().subarray(0, expected.length)).toEqual(expected);
  // A failed export: the sandbox copy is longer than the host's.
  const longer = fs.readFileSync(sandboxRollout(fixture.home(), fixture.session())!);
  fs.writeFileSync(fixture.hostFile(), expected);
  await fixture.turn();
  expect(fixture.hostCopy().subarray(0, longer.length)).toEqual(longer);
  expect(fixture.hostCopy()).toEqual(fs.readFileSync(sandboxRollout(fixture.home(), fixture.session())!));
});

it('AD-12 exports only the appended tail of a Claude transcript', async () => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-claude-home-');
  const relative = remoteAgentHomeRelative('claude', localHome);
  const session = '44444444-4444-4444-8444-444444444444';
  const transcript = (lines: number) => Buffer.from(Array.from({ length: lines }, (_, i) => JSON.stringify({ i, text: 'x'.repeat(2000) })).join('\n') + '\n');
  const remote = path.join(root, relative, 'projects/-workspace', `${session}.jsonl`);
  const host = path.join(localHome, 'projects/-workspace', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(remote), { recursive: true }); fs.mkdirSync(path.dirname(host), { recursive: true });
  fs.writeFileSync(host, transcript(200));
  fs.writeFileSync(remote, transcript(210));
  const meter = newMeter();
  await syncRemoteAgentHome(directorySandbox(root, meter), 'claude', { relative, absolute: path.join(root, relative) }, localHome, session);
  expect(fs.readFileSync(host)).toEqual(transcript(210));
  expect(meter.downloaded).toBeLessThan(transcript(210).length - transcript(200).length + 16 * 1024);
});

it('LT-1 prepares the sandbox while the turn prompt is built, and the adapter reuses it', async () => {
  const { Store } = await import('../src/store/db.js');
  const { WorldRegistry } = await import('../src/world/registry.js');
  const { ProfileResolver } = await import('../src/agent/profiles.js');
  const { makeCoreActivities } = await import('../src/activities/core.js');
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-codex-home-'), content = temp('karmax-content-');
  stageRemoteRuntime(root);
  freshCodexHome(localHome);
  // The personal organization's remote turn runs on the ambient subscription.
  process.env.CODEX_HOME = localHome;
  delete process.env.OPENAI_API_KEY;
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Remote');
    const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const meter = newMeter();
    const world = directorySandbox(root, meter);
    const worlds = new WorldRegistry();
    vi.spyOn(worlds, 'open').mockResolvedValue(world);
    const bootstraps = () => meter.execs.filter((command) => command.includes('KARMAX_SYSTEM_CODEX_CONFIG'));
    let atAdapter = -1;
    const codex = new CodexAdapter();
    const core = makeCoreActivities({ store, worlds, contentDir: content, profiles: new ProfileResolver(store, 'mock'),
      adapters: new Map([['codex', { provider: 'codex', runTurn: (input: any, ctx: any) => {
        atAdapter = bootstraps().length;
        return codex.runTurn(input, ctx);
      } }]]) as any });
    await core.runAgentTurn({ taskId: task.id, role: 'do', agentSlotGranted: true, worldHandle: world.handle, messages: [],
      task: { taskId: task.id, projectId: project.id, title: 'Work', prompt: 'work', project: {}, agents: { do: { provider: 'codex' } } } } as any);
    expect(atAdapter).toBe(1);
    expect(bootstraps()).toHaveLength(1);
    expect(meter.cliStarts).toEqual(['app-server']);
  } finally { await store.close(); }
});

it('AD-12 writes a remote work environment without its own sandbox commands once the world is prepared', async () => {
  const { claudeWorkEnvironment } = await import('../src/agent/work-environment.js');
  const { prewarmRemoteAgentHome } = await import('../src/agent/remote-process.js');
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-claude-home-');
  stageRemoteRuntime(root);
  const meter = newMeter();
  const world = directorySandbox(root, meter);
  prewarmRemoteAgentHome(world, 'claude', localHome);
  const input = { world, secretEnv: { API_TOKEN: 'secret-value' } } as any;
  const work = await claudeWorkEnvironment(input, true);
  // The bootstrap (prewarmed beside prompt preparation) made the parent private.
  expect(meter.execs.filter((command) => !command.includes('KARMAX_SYSTEM_CODEX_CONFIG') && !command.includes('chmod 700'))).toEqual([]);
  const parent = path.join(root, '.karmax-injection/work-env');
  expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
  const [directory] = fs.readdirSync(parent);
  expect(fs.readFileSync(path.join(parent, directory!, 'env.sh'), 'utf8')).toBe("export API_TOKEN='secret-value'\n");
  await work.update();
  expect(fs.readdirSync(path.join(parent, directory!))).toEqual(['env.sh']);
  await work.cleanup();
  expect(fs.readdirSync(parent)).toEqual([]);
});
