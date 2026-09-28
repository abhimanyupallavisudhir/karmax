import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/agent/codex.js';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ensureRemoteNode, prewarmRemoteAgentHome, remoteAgentHomeRelative, seedRemoteAgentHome,
  syncRemoteAgentHome } from '../src/agent/remote-process.js';
import { CodexHistoryError } from '../src/agent/codex-history.js';
import { KARMAX_TOKEN_FILE } from '../src/autonomy/config-homes.js';
import type { ExecResult } from '../src/world/types.js';
import { directorySandbox, freshCodexHome, newMeter, NO_LATENCY, sandboxRollout, stageBakedBrowser, stageBakedRuntime, stageRemoteRuntime,
  type SandboxLatency } from './helpers/directory-sandbox.js';

// LT-1, AD-12, AD-13: what a remote turn does before the model starts, and how
// much native history crosses the host ↔ sandbox boundary, against a directory
// that behaves like a remote world (benchmarks/remote-bootstrap.ts measures it).
const roots: string[] = [];
const temp = (prefix: string) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function codexFixture(options: { growth?: number; latency?: SandboxLatency; config?: string; profile?: string; prefix?: string } = {}) {
  const root = temp(options.prefix ?? 'karmax-sandbox-'), localHome = temp('karmax-codex-home-');
  stageRemoteRuntime(root);
  freshCodexHome(localHome);
  fs.writeFileSync(path.join(localHome, 'config.toml'), options.config ?? 'model = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
  let session: string | undefined;
  const turn = async (extra: Record<string, unknown> = {}) => {
    const meter = newMeter();
    const world = directorySandbox(root, meter, { latency: options.latency ?? NO_LATENCY, growth: options.growth ?? 4096,
      ...(options.profile !== undefined ? { profile: options.profile } : {}) });
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
  // Claude keeps a transcript under its working directory's project slug.
  const project = `projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const remote = path.join(root, relative, project, `${session}.jsonl`);
  const host = path.join(localHome, project, `${session}.jsonl`);
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
  stageBakedBrowser(root);
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
  // The bootstrap (prewarmed beside prompt preparation) made the parent private;
  // only the file's own private, atomic write remains.
  expect(meter.execs.filter((command) => !command.includes('KARMAX_SYSTEM_CODEX_CONFIG') && !command.includes('chmod 700'))).toEqual([
    expect.stringContaining('chmod 600 "$1" && mv -f "$1" "$2"')]);
  const parent = path.join(root, '.karmax-injection/work-env');
  expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
  const [directory] = fs.readdirSync(parent);
  expect(fs.readFileSync(path.join(parent, directory!, 'env.sh'), 'utf8')).toBe("export API_TOKEN='secret-value'\n");
  expect(fs.statSync(path.join(parent, directory!, 'env.sh')).mode & 0o777).toBe(0o600);
  await work.update();
  expect(fs.readdirSync(path.join(parent, directory!))).toEqual(['env.sh']);
  await work.cleanup();
  expect(fs.readdirSync(parent)).toEqual([]);
});

// Review follow-up of LT-1/AD-12/AD-13: the sandbox prints its own history
// inventory, so every entry is checked against what the host itself would
// have looked for before anything is written on the host.
const sha = (content: Buffer | string) => crypto.createHash('sha256').update(content).digest('hex');
const CLAUDE_SESSION = '55555555-5555-4555-8555-555555555555';
const THREAD = '66666666-6666-4666-8666-666666666666';
const OTHER_THREAD = '77777777-7777-4777-8777-777777777777';

/** A sandbox Node that answers the history inventory with `inventory` (the
 * agent can replace the managed runtime) and runs everything else. */
function forgedNode(root: string, inventory: string): string {
  const bin = path.join(root, 'forged-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'inventory'), inventory);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\ncase "$2" in *KARMAX_HISTORY_INVENTORY*) printf '\\nKARMAX_HISTORY_INVENTORY '; cat '${path.join(bin, 'inventory')}'; printf '\\n'; exit 0;; esac\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  return bin;
}
const entry = (root: string, relative: string, file: string, id?: string) => {
  const content = fs.readFileSync(path.join(root, relative, file));
  return { file, ...(id ? { id } : {}), size: content.length, sha256: sha(content) };
};
function write(file: string, content: string | Buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
const rolloutRecords = (id: string, lines: number, extra = '') => [JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id,
  timestamp: '2026-09-28T00:00:00Z', history_mode: 'paginated' } }), ...Array.from({ length: lines }, (_, i) =>
  JSON.stringify({ ordinal: i + 1, type: 'response_item', payload: { type: 'message', text: `${extra}${i}` } }))].join('\n') + '\n';

it('never writes a host file a forged Claude inventory names, and still exports the transcript', async () => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-claude-home-');
  const relative = remoteAgentHomeRelative('claude', localHome);
  const transcript = `projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${CLAUDE_SESSION}.jsonl`;
  const host = { '.credentials.json': '{"claudeAiOauth":{"refreshToken":"host"}}', 'settings.json': '{"hooks":{}}',
    'CLAUDE.md': 'host instructions', [KARMAX_TOKEN_FILE]: '{"token":"host"}' };
  for (const [file, content] of Object.entries(host)) {
    write(path.join(localHome, file), content);
    write(path.join(root, relative, file), `forged ${file}`);
  }
  write(path.join(localHome, transcript), '{"turn":1}\n');
  write(path.join(root, relative, transcript), '{"turn":1}\n{"turn":2}\n');
  const forged = [...Object.keys(host).map((file) => entry(root, relative, file)), entry(root, relative, transcript)];
  const runtimeBin = forgedNode(root, JSON.stringify(forged));
  await syncRemoteAgentHome(directorySandbox(root, newMeter()), 'claude', { relative, absolute: path.join(root, relative), runtimeBin },
    localHome, CLAUDE_SESSION);
  for (const [file, content] of Object.entries(host)) expect(fs.readFileSync(path.join(localHome, file), 'utf8')).toBe(content);
  expect(fs.readFileSync(path.join(localHome, transcript), 'utf8')).toBe('{"turn":1}\n{"turn":2}\n');
});

it('never lets a forged Codex inventory entry overwrite another session, and still exports the thread', async () => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-codex-home-');
  const relative = remoteAgentHomeRelative('codex', localHome);
  const other = path.join(localHome, `sessions/forked/rollout-2026-09-01T00-00-00-${OTHER_THREAD}.jsonl`);
  write(other, rolloutRecords(OTHER_THREAD, 3));
  const thread = `sessions/2026/09/28/rollout-2026-09-28T00-00-00-${THREAD}.jsonl`;
  write(path.join(root, relative, thread), rolloutRecords(THREAD, 5));
  // The sandbox's copy of the other session, extended with this thread's records.
  const decoy = `sessions/forked/rollout-2026-09-01T00-00-00-${OTHER_THREAD}.jsonl`;
  write(path.join(root, relative, decoy), rolloutRecords(THREAD, 9));
  const runtimeBin = forgedNode(root, JSON.stringify([entry(root, relative, decoy, THREAD)]));
  await syncRemoteAgentHome(directorySandbox(root, newMeter()), 'codex', { relative, absolute: path.join(root, relative), runtimeBin },
    localHome, THREAD);
  expect(fs.readFileSync(other, 'utf8')).toBe(rolloutRecords(OTHER_THREAD, 3));
  expect(fs.readFileSync(sandboxRollout(localHome, THREAD)!, 'utf8')).toBe(rolloutRecords(THREAD, 5));
  // The host names a new copy after its identity, not after the sandbox's path.
  expect(path.basename(sandboxRollout(localHome, THREAD)!)).toBe(`rollout-2026-09-28T00-00-00-${THREAD}.jsonl`);
});

it.each([
  ['malformed', 'not json'],
  ['an escaping path', JSON.stringify([{ file: '../outside.jsonl', id: THREAD, size: 1, sha256: '0'.repeat(64) }])],
  ['an unmeasurable sandbox', undefined],
])('exports whole files when the inventory is %s', async (_, inventory) => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-codex-home-');
  const relative = remoteAgentHomeRelative('codex', localHome);
  write(path.join(root, relative, `sessions/2026/09/28/rollout-2026-09-28T00-00-00-${THREAD}.jsonl`), rolloutRecords(THREAD, 5));
  const runtimeBin = inventory === undefined ? path.join(root, 'missing-bin') : forgedNode(root, inventory);
  await syncRemoteAgentHome(directorySandbox(root, newMeter()), 'codex', { relative, absolute: path.join(root, relative), runtimeBin },
    localHome, THREAD);
  expect(fs.readFileSync(sandboxRollout(localHome, THREAD)!, 'utf8')).toBe(rolloutRecords(THREAD, 5));
  expect(fs.existsSync(path.join(root, relative, '../outside.jsonl'))).toBe(false);
});

it('keeps both histories when the sandbox copy diverged from the host copy', async () => {
  const fixture = codexFixture();
  await fixture.turn();
  const host = fixture.hostCopy();
  const remote = sandboxRollout(fixture.home(), fixture.session())!;
  fs.writeFileSync(remote, Buffer.concat([host.subarray(0, host.indexOf(10) + 1), Buffer.from(rolloutRecords(THREAD, 2).split('\n')[1] + '\n')]));
  const relative = remoteAgentHomeRelative('codex', fixture.localHome);
  await expect(syncRemoteAgentHome(directorySandbox(fixture.root, newMeter()), 'codex',
    { relative, absolute: fixture.home(), runtimeBin: path.join(fixture.root, '.karmax-injection/agent/tools/node-22.16.0/bin') },
    fixture.localHome, fixture.session())).rejects.toThrow(CodexHistoryError);
  expect(fixture.hostCopy()).toEqual(host);
});

it('exports the longest of duplicated sandbox copies', async () => {
  const fixture = codexFixture({ growth: 8192 });
  await fixture.turn();
  const short = fs.readFileSync(sandboxRollout(fixture.home(), fixture.session())!);
  await fixture.turn();
  const remote = sandboxRollout(fixture.home(), fixture.session())!;
  const long = fs.readFileSync(remote);
  // An earlier alias of the same thread, a prefix of the live copy.
  write(path.join(fixture.home(), 'sessions/forked', path.basename(remote)), short);
  fs.writeFileSync(fixture.hostFile(), short);
  const relative = remoteAgentHomeRelative('codex', fixture.localHome);
  await syncRemoteAgentHome(directorySandbox(fixture.root, newMeter()), 'codex',
    { relative, absolute: fixture.home(), runtimeBin: path.join(fixture.root, '.karmax-injection/agent/tools/node-22.16.0/bin') },
    fixture.localHome, fixture.session());
  expect(fixture.hostCopy()).toEqual(long);
});

it('exports the appended tail even when a login shell prints before every command', async () => {
  // A template's /etc/profile warning (69 bytes), printed into every sandbox command's output.
  const fixture = codexFixture({ growth: 16 * 1024, profile: "echo 'bash: warning: setlocale: LC_ALL: cannot change locale (en_ZZ.UTF-8)'\n" });
  await fixture.turn();
  await fixture.turn();
  const meter = await fixture.turn();
  expect(fixture.hostCopy()).toEqual(fs.readFileSync(sandboxRollout(fixture.home(), fixture.session())!));
  expect(meter.downloaded).toBeLessThan(fixture.hostCopy().length);
});

it('uploads a Claude transcript only when the sandbox does not already hold it', async () => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-claude-home-');
  stageRemoteRuntime(root);
  const relative = remoteAgentHomeRelative('claude', localHome);
  const transcript = `projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${CLAUDE_SESSION}.jsonl`;
  const content = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, text: 'x'.repeat(1000) })).join('\n') + '\n';
  write(path.join(localHome, transcript), content);
  write(path.join(root, relative, transcript), content);
  const held = newMeter();
  await seedRemoteAgentHome(directorySandbox(root, held), 'claude', localHome, CLAUDE_SESSION);
  expect(held.writes).not.toContain(`${relative}/${transcript}`);
  fs.writeFileSync(path.join(root, relative, transcript), content.slice(0, 1000));
  const shorter = newMeter();
  await seedRemoteAgentHome(directorySandbox(root, shorter), 'claude', localHome, CLAUDE_SESSION);
  expect(shorter.writes).toContain(`${relative}/${transcript}`);
  expect(fs.readFileSync(path.join(root, relative, transcript), 'utf8')).toBe(content);
});

it.each([
  ['the managed Node fails its version check', /needs Node 22\.12\+/, (root: string) => {
    const node = path.join(root, '.karmax-injection/agent/tools/node-22.16.0/node_modules/node/bin/node');
    fs.rmSync(node); fs.writeFileSync(node, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }],
  ['the toolchain cannot be exposed', /could not make managed Node\/npm the sandbox default/, (root: string) => {
    fs.rmSync(path.join(root, '.usr-local-bin'), { recursive: true }); fs.writeFileSync(path.join(root, '.usr-local-bin'), '');
  }],
  ['the previous writer cannot be stopped', /could not stop previous writer/, (root: string, home: string) => {
    write(path.join(home, 'karmax-agent.pid'), 'not-a-pid\n');
  }],
  ['the agent home cannot be protected', /could not protect remote subscription files/, (root: string) => {
    fs.mkdirSync(path.join(root, '.karmax-injection/agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.karmax-injection/agent/codex'), '');
  }],
])('names the bootstrap step that failed when %s', async (_, message, breakWorld) => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-codex-home-');
  stageRemoteRuntime(root);
  const world = directorySandbox(root, newMeter());
  breakWorld(root, path.join(root, remoteAgentHomeRelative('codex', localHome)));
  await expect(seedRemoteAgentHome(world, 'codex', localHome)).rejects.toThrow(message);
});

it('reports any other bootstrap failure by its status, not as a Node problem', async () => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-codex-home-');
  stageRemoteRuntime(root);
  const failure = await seedRemoteAgentHome(directorySandbox(root, newMeter(), { profile: 'exit 3\n' }), 'codex', localHome).catch((error) => error);
  expect(failure.message).toMatch(/bootstrap failed \(status 3\)/);
  expect(failure.message).not.toMatch(/Node/);
});

it('starts a Codex turn when the work-environment directory cannot be made', async () => {
  const fixture = codexFixture();
  write(path.join(fixture.root, '.karmax-injection/work-env'), 'not a directory');
  await fixture.turn();
});

it('reruns a prewarmed bootstrap that failed, and does not wait for one it cannot use', async () => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-codex-home-');
  stageRemoteRuntime(root);
  let bootstraps = 0;
  const failing = directorySandbox(root, newMeter(), { intercept: (command, args) =>
    args.some((arg) => arg.includes('KARMAX_SYSTEM_CODEX_CONFIG')) && ++bootstraps === 1 ? { code: 1, stdout: '', stderr: 'transient' } : undefined });
  prewarmRemoteAgentHome(failing, 'codex', localHome);
  await seedRemoteAgentHome(failing, 'codex', localHome);
  expect(bootstraps).toBe(2);
  // A prewarm for another session is still running; the seed runs its own now.
  const slow = directorySandbox(root, newMeter(), { intercept: (_command, args) => args.some((arg) => arg.includes('KARMAX_SYSTEM_CODEX_CONFIG'))
    && args.some((arg) => arg.includes(THREAD)) ? new Promise<ExecResult>((resolve) => setTimeout(() => resolve({ code: 1, stdout: '', stderr: '' }), 3000)) : undefined });
  prewarmRemoteAgentHome(slow, 'codex', localHome, THREAD);
  const started = performance.now();
  await seedRemoteAgentHome(slow, 'codex', localHome);
  expect(performance.now() - started).toBeLessThan(2000);
});

it('shares a prewarmed bootstrap with MCP connection preparation', async () => {
  const root = temp('karmax-sandbox-'), localHome = temp('karmax-codex-home-');
  stageRemoteRuntime(root);
  const meter = newMeter();
  const world = directorySandbox(root, meter);
  prewarmRemoteAgentHome(world, 'codex', localHome);
  expect(await ensureRemoteNode(world)).toBe(path.join(root, '.karmax-injection/agent/tools/node-22.16.0/bin'));
  expect(meter.execs.filter((command) => command.includes('node-22.16.0'))).toHaveLength(1);
});

it('never installs the managed runtime from two bootstraps at once', async () => {
  const root = temp('karmax-sandbox-');
  const log = stageBakedRuntime(root, '22.16.0', 400);
  // Two turns' worlds on one sandbox: an abandoned prewarm and its retry.
  await Promise.all([ensureRemoteNode(directorySandbox(root, newMeter())), ensureRemoteNode(directorySandbox(root, newMeter()))]);
  expect(fs.readFileSync(log, 'utf8')).toBe('start\nend\n');
});

it('makes the seeded credential files private before the agent starts', async () => {
  const fixture = codexFixture();
  const meter = await fixture.turn();
  // Run the real launcher, with the terminal and the agent itself stubbed.
  const stubs = temp('karmax-stubs-');
  for (const name of ['stty', 'sh']) fs.writeFileSync(path.join(stubs, name), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const launcher = path.join(stubs, 'launch.sh');
  fs.writeFileSync(launcher, meter.launches[0]!);
  const ran = spawnSync('/bin/bash', [launcher], { env: { PATH: `${stubs}:${process.env.PATH}` }, encoding: 'utf8' });
  expect(ran.status).toBe(0);
  for (const file of ['auth.json', 'config.toml']) expect(fs.statSync(path.join(fixture.home(), file)).mode & 0o777).toBe(0o600);
});

it('runs in a sandbox whose path needs shell quoting', async () => {
  const fixture = codexFixture({ prefix: "karmax sandbox's-" });
  await fixture.turn();
  await fixture.turn();
  expect(fixture.hostCopy()).toEqual(fs.readFileSync(sandboxRollout(fixture.home(), fixture.session())!));
});

