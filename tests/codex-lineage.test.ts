import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { CodexAppServerClient } from '../src/agent/codex-app-server-client.js';
import { CodexAdapter, ensureLocalCodexSessionTools } from '../src/agent/codex.js';
import { localProviderCli } from '../src/agent/provider-cli.js';
import { findProviderSession, materializeFork } from '../src/agent/fork.js';
import { ensureRemoteCodexSessionTools, materializeRemoteSession, remoteAgentHomeRelative,
  seedRemoteAgentHome, syncRemoteAgentHome } from '../src/agent/remote-process.js';
import type { World } from '../src/world/types.js';
import { readLocalCodexHistory, publishLocalCodexHistory } from '../src/agent/codex-history-files.js';
import { publishRemoteCodexHistory } from '../src/agent/codex-history-remote.js';

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-lineage-')); roots.push(root); return root; };
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Real files and processes behind the same World methods used by cloud transfers.
function diskWorld(root: string): World {
  return {
    handle: { root, kind: 'worktree' },
    async exec(command: string, args: string[]) {
      try { return { code: 0, stdout: execFileSync(command === 'node' ? process.execPath : command, args,
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
      catch (e: any) { return { code: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
    },
    async readFileBuffer(file: string) { return fs.readFileSync(path.join(root, file)); },
    async readFile(file: string) { return fs.readFileSync(path.join(root, file), 'utf8'); },
    async writeFileBuffer(file: string, content: Buffer) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    },
    async writeFile(file: string, content: string) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    },
  } as unknown as World;
}

async function server(home: string) {
  const proc = spawn(localProviderCli('codex'), ['app-server'], {
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.resume();
  const client = new CodexAppServerClient(proc.stdin, proc.stdout);
  const stop = async () => {
    client.close();
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      proc.kill(); await exited;
    }
  };
  stops.push(stop);
  await client.request('initialize', { clientInfo: { name: 'karmax-lineage-test', version: '1' },
    capabilities: { experimentalApi: true } });
  client.notify('initialized');
  return { client, stop };
}

async function history(home: string) {
  const { client, stop } = await server(home);
  const root = (await client.request('thread/start', { cwd: home, historyMode: 'paginated',
    dynamicTools: [{ name: 'old_tool', description: 'x'.repeat(10_000), inputSchema: { type: 'object' } }],
  })).thread.id as string;
  await client.request('thread/inject_items', { threadId: root, items: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inherited-marker-雪' }] },
  ] });
  const child = (await client.request('thread/fork', { threadId: root })).thread.id as string;
  await stop();
  return { root, child };
}

it.each(['local', 'remote'])('preserves and restores indexed paths during %s publication', async (mode) => {
  const world = diskWorld(temp());
  const home = path.join(world.handle.root, 'codex');
  fs.mkdirSync(home);
  const { root, child } = await history(home);
  const original = readLocalCodexHistory(home, root);
  const last = JSON.parse(original.content.toString().trim().split('\n').at(-1)!).ordinal;
  const alias = path.join(home, 'sessions', 'forked', path.basename(original.file));
  const content = Buffer.concat([original.content, Buffer.from(JSON.stringify({ ordinal: last + 1,
    timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'newer alias content' }] } }) + '\n')]);
  fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.writeFileSync(alias, content);
  const publish = () => mode === 'local'
    ? publishLocalCodexHistory(home, { file: alias, content }, root)
    : publishRemoteCodexHistory(world, { relative: 'codex', absolute: home }, { file: alias, content }, root);
  await publish();
  expect(fs.readFileSync(original.file)).toEqual(content);
  // Recover a dangling index left by an older alias cleanup as well.
  fs.renameSync(original.file, alias);
  await publish();
  expect(fs.readFileSync(original.file)).toEqual(content);
  const { client } = await server(home);
  await expect(client.request('thread/fork', { threadId: root })).resolves.toHaveProperty('thread.id');
  await expect(client.request('thread/fork', { threadId: child })).resolves.toHaveProperty('thread.id');
}, 30_000);

it.each(['0.0', '1.5'])('does not reuse an ordinal after a decimal %s tail on resume', async (decimal) => {
  const home = temp();
  const { root } = await history(home);
  const file = findProviderSession({ provider: 'codex', session: root, forkHome: home })!;
  const records = () => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  let last = records().at(-1)!.ordinal;
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.appendFileSync(file, `{"timestamp":"2026-09-09T00:00:00Z","ordinal":${last + 1},"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":${decimal},"window_minutes":300,"resets_at":1999999999},"secondary":null,"credits":null,"plan_type":"pro"}}}\n`);
    const { client, stop } = await server(home);
    await client.request('thread/resume', { threadId: root });
    await client.request('thread/inject_items', { threadId: root, items: [{ type: 'message', role: 'user',
      content: [{ type: 'input_text', text: `retry ${attempt}` }] }] });
    await expect(client.request('thread/fork', { threadId: root })).resolves.toHaveProperty('thread.id');
    await stop();
    const ordinals = records().map((record) => record.ordinal);
    expect(ordinals).toEqual(ordinals.map((_, ordinal) => ordinal));
    last = ordinals.at(-1)!;
  }
}, 30_000);

it('reproduces the cutoff error with the real pinned Codex after rewriting an ancestor', async () => {
  const home = temp();
  const { root, child } = await history(home);
  const file = findProviderSession({ provider: 'codex', session: root, forkHome: home })!;
  const bytes = fs.readFileSync(file);
  const newline = bytes.indexOf(10);
  const meta = JSON.parse(bytes.subarray(0, newline).toString());
  meta.payload.dynamic_tools = [];
  fs.writeFileSync(file, Buffer.concat([Buffer.from(JSON.stringify(meta)), bytes.subarray(newline)]));
  const { client } = await server(home);
  await expect(client.request('thread/fork', { threadId: child }))
    .rejects.toThrow('cutoff byte offset is past the source rollout');
});

it.each([false, true])('recovers native lineage through transfers and completed turns (damaged ancestor: %s)', async (damaged) => {
  const origin = temp();
  const { root, child } = await history(origin);
  const sourceFile = findProviderSession({ provider: 'codex', session: root, forkHome: origin })!;
  if (damaged) {
    // Reproduce the old writer's decimal-tail ordinal reuse in an ancestor,
    // including a distinct record with the reused ordinal. Adjust only this
    // fixture's byte boundary so the child still references the same history.
    const bytes = fs.readFileSync(sourceFile);
    const firstEnd = bytes.indexOf(10) + 1;
    const next = JSON.parse(bytes.subarray(firstEnd).toString().split('\n')[0]!);
    const tail = Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(), ordinal: next.ordinal,
      type: 'event_msg', payload: { type: 'token_count', info: null,
        rate_limits: { primary: { used_percent: 1.5, window_minutes: 300, resets_at: 1999999999 } } },
    }) + '\n');
    fs.writeFileSync(sourceFile, Buffer.concat([bytes.subarray(0, firstEnd), tail, bytes.subarray(firstEnd)]));
    const childFile = findProviderSession({ provider: 'codex', session: child, forkHome: origin })!;
    const childBytes = fs.readFileSync(childFile);
    const newline = childBytes.indexOf(10);
    const metadata = JSON.parse(childBytes.subarray(0, newline).toString());
    metadata.payload.history_base.end_byte_offset += tail.length;
    fs.writeFileSync(childFile, Buffer.concat([Buffer.from(JSON.stringify(metadata)), childBytes.subarray(newline)]));
  }
  const original = fs.readFileSync(sourceFile);
  const migrated = await ensureLocalCodexSessionTools(origin, root, [])!;
  expect(migrated).not.toBe(root);
  expect(fs.readFileSync(sourceFile)).toEqual(original);
  const { client: migratedClient, stop: stopMigrated } = await server(origin);
  await expect(migratedClient.request('thread/resume', { threadId: migrated })).resolves.toHaveProperty('thread.id', migrated);
  await stopMigrated();
  const local = temp();
  expect(materializeFork({ provider: 'codex', session: child, srcHome: origin, forkHome: local, worldPath: local })).toBe(true);
  const first = diskWorld(temp()), second = diskWorld(temp());
  const firstHome = await seedRemoteAgentHome(first, 'codex', local, child);
  const prepared = (await ensureRemoteCodexSessionTools(first, firstHome, child, []))!;
  expect(prepared).not.toBe(child);
  const { client: firstClient, stop: stopFirst } = await server(firstHome.absolute);
  const grandchild = (await firstClient.request('thread/fork', { threadId: prepared })).thread.id as string;
  await stopFirst();
  const durable = temp();
  expect(await materializeRemoteSession(first, second, 'codex', grandchild, durable)).toBe(true);
  const relative = remoteAgentHomeRelative('codex', durable);
  await syncRemoteAgentHome(second, 'codex', { relative, absolute: path.join(second.handle.root, relative) }, durable);
  const restored = diskWorld(temp());
  const restoredHome = await seedRemoteAgentHome(restored, 'codex', durable, grandchild);
  const { client, stop } = await server(restoredHome.absolute);
  const final = (await client.request('thread/fork', { threadId: grandchild })).thread.id as string;
  await stop();

  // Only the model HTTP response is a fixture. The adapter, Codex binary, native
  // history pagination, tool registration, and completed turn are all real.
  const requests: any[] = [];
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'lineage-ok', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: 'resp_test', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  stops.push(() => new Promise<void>((resolve) => { model.closeAllConnections(); model.close(() => resolve()); }));
  const port = (model.address() as { port: number }).port;
  fs.writeFileSync(path.join(restoredHome.absolute, 'config.toml'), `model_provider = "fixture"
model = "gpt-5.5"
[model_providers.fixture]
name = "Local test response"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);
  const result = await new CodexAdapter().runTurn({
    world: restored, session: final, fork: true,
    profile: { id: 'test', name: 'test', provider: 'codex', role: 'do', capabilities: [], model: 'gpt-5.5' },
    resolvedAuth: { configHome: restoredHome.absolute },
    messages: [{ id: 'm', role: 'user', text: 'Continue.', ts: 0 }], systemPrompt: 'Reply briefly.', role: 'do',
  } as any, { emit() {}, emitActivity() {} } as any);
  expect(result.termination).toMatchObject({ kind: 'success', status: 'completed' });
  expect(result.output).toContain('lineage-ok');
  const resumed = await new CodexAdapter().runTurn({
    world: restored, session: result.session, fork: false,
    profile: { id: 'test', name: 'test', provider: 'codex', role: 'do', capabilities: [], model: 'gpt-5.5' },
    resolvedAuth: { configHome: restoredHome.absolute },
    messages: [{ id: 'm2', role: 'user', text: 'Continue again.', ts: 1 }], systemPrompt: 'Reply briefly.', role: 'do',
  } as any, { emit() {}, emitActivity() {} } as any);
  expect(resumed.termination).toMatchObject({ kind: 'success', status: 'completed' });
  expect(resumed.session).toBe(result.session);

  expect(JSON.stringify(requests)).toContain('inherited-marker-雪');
  expect(JSON.stringify(requests)).toContain('confirm_decision');
  expect(fs.readFileSync(sourceFile)).toEqual(original);
}, 60_000);
