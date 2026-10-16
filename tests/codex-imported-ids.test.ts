/** A conversation imported into Codex by panagent ≤ 0.3.0 gave each assistant
 * message an invented `msg_<32 hex>` id. Codex sends item ids back to the
 * model, and OpenAI looks up any id it did not issue: task #643 failed with
 * "400 Supplied input item IDs require persisted-item lookup that is not
 * supported" (2026-10-15). Histories already written that way, and the forks
 * Codex made of them, are repaired before a turn resumes them. Real pinned
 * Codex against a local Responses fixture: no model charges. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CodexAppServerClient } from '../src/agent/codex-app-server-client.js';
import { localProviderCli } from '../src/agent/provider-cli.js';
import crypto from 'node:crypto';
import { codexRolloutFilename, prepareCodexHistory } from '../src/agent/codex-history.js';
import { publishLocalCodexHistory, readLocalCodexHistory } from '../src/agent/codex-history-files.js';
import { ensureLocalCodexSessionTools } from '../src/agent/codex.js';

const imported = '0199aaaa-0000-7000-8000-000000000001';
const INVENTED = 'msg_0bc8f1e848af4d6dba49e5cb0f5f0fa3';
const provenance = { internal_chat_message_metadata_passthrough: { panagent_provenance: { source_format: 'claude-code-jsonl' } } };
const jsonl = (records: any[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
// What panagent 0.3.0 wrote for a two-message Claude conversation.
const panagentHistory = jsonl([
  { timestamp: '2026-10-10T00:00:00Z', type: 'session_meta', payload: { id: imported, timestamp: '2026-10-10T00:00:00Z',
    cwd: '/tmp', originator: 'panagent', cli_version: '0.3.0', source: 'cli', model_provider: 'openai' } },
  { timestamp: '2026-10-10T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'imported-user-marker' }], ...provenance } },
  { timestamp: '2026-10-10T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'imported-assistant-marker' }], id: INVENTED, ...provenance } },
]);

it('drops only the item ids panagent invented, leaving ids Codex or OpenAI issued', async () => {
  const native = { timestamp: '2026-10-10T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant',
    id: 'msg_67ccd3acc8d48190a77525dc6de64b4104becb25c62f4f9a', content: [{ type: 'output_text', text: 'native' }] } };
  const forkAssigned = { timestamp: '2026-10-10T00:00:03Z', type: 'response_item', payload: { type: 'message', role: 'user',
    id: 'msg_01a13d23-f27c-72a3-8b31-afba87ad92c3', content: [{ type: 'input_text', text: 'x' }], ...provenance } };
  const content = Buffer.from(panagentHistory + jsonl([native, forkAssigned]));
  const snapshot = (await prepareCodexHistory(imported, async () => ({ file: `${imported}.jsonl`, content })))!;
  expect(snapshot).toBeDefined();
  expect(snapshot.session).not.toBe(imported);
  const items = snapshot.content.toString().trim().split('\n').map((line) => JSON.parse(line).payload);
  expect(items.map((item) => item.id)).toEqual([snapshot.session, undefined, undefined, native.payload.id, forkAssigned.payload.id]);
  expect(items[2].content[0].text).toBe('imported-assistant-marker');
  // A repaired history needs no further repair.
  expect(await prepareCodexHistory(snapshot.session, async () => ({ file: snapshot.filename, content: snapshot.content }))).toBeUndefined();
  // A conversation Codex wrote itself is never rewritten, whatever its ids look like.
  const own = Buffer.from(panagentHistory.replace('"originator":"panagent"', '"originator":"codex_cli_rs"'));
  expect(await prepareCodexHistory(imported, async () => ({ file: `rollout-2026-10-10T00-00-00-${imported}.jsonl`, content: own })))
    .toBeUndefined();
});

it('names the repaired copy apart from the one a previous release made of the same history (#643)', async () => {
  // #643's first attempt (before the repair) had already prepared the import
  // for Codex's tools: a copy that kept the invented ids, named from the same
  // source bytes and tools. The repaired copy must not claim that name, or
  // publishing it meets diverging bytes and every retry fails.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-imported-'));
  try {
    const tools = [{ type: 'function', name: 'open_pr', description: 'x', inputSchema: { type: 'object' } }];
    const source = publishLocalCodexHistory(home, { file: codexRolloutFilename('2026-10-10T00:00:00Z', imported),
      content: Buffer.from(panagentHistory) }, imported);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const hex = crypto.createHash('sha256').update(JSON.stringify(['codex-history-v1', imported, [[imported, sha]], tools]))
      .digest('hex').slice(0, 32).split('');
    hex[12] = '4'; hex[16] = '8';
    const earlier = hex.join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const kept = panagentHistory.trim().split('\n').map((line) => JSON.parse(line));
    Object.assign(kept[0].payload, { id: earlier, history_mode: 'paginated', dynamic_tools: tools });
    publishLocalCodexHistory(home, { file: codexRolloutFilename('2026-10-10T00:00:00Z', earlier),
      content: Buffer.from(jsonl(kept.map((record, ordinal) => ({ ...record, ordinal })))) }, earlier);

    const session = await ensureLocalCodexSessionTools(home, imported, tools);
    expect(session).not.toBe(earlier);
    expect(readLocalCodexHistory(home, session).content.toString()).not.toContain(INVENTED);
    expect(readLocalCodexHistory(home, earlier).content.toString()).toContain(INVENTED); // never rewritten
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('resumes a Codex fork of an imported conversation without sending invented ids (#643)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-imported-'));
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    const item = { id: `msg_server_${bodies.length}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: `resp_${bodies.length}`, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `resp_${bodies.length}`, status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const home = path.join(dir, 'home');
  const sessions = path.join(home, 'sessions', '2026', '10', '10');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "fixture"\n` +
    `[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${(server.address() as any).port}"\nwire_api = "responses"\n`);
  fs.writeFileSync(path.join(sessions, `rollout-2026-10-10T00-00-00-${imported}.jsonl`), panagentHistory);
  const app = async <T>(run: (client: CodexAppServerClient) => Promise<T>): Promise<T> => {
    const child = spawn(process.execPath, [localProviderCli('codex'), 'app-server'], {
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = once(child, 'exit');
    const client = new CodexAppServerClient(child.stdin, child.stdout);
    try {
      await client.request('initialize', { clientInfo: { name: 'karmax-test', version: '1' }, capabilities: { experimentalApi: true } });
      client.notify('initialized');
      return await run(client);
    } finally { client.close(); child.kill('SIGTERM'); await exited; }
  };
  const options = { cwd: dir, approvalPolicy: 'never', sandbox: 'danger-full-access', modelProvider: 'fixture' };
  try {
    // The state #643 was left in: the first turn had already forked the import.
    const fork: string = await app(async (client) => (await client.request('thread/fork', { threadId: imported, ...options })).thread.id);
    const session = await ensureLocalCodexSessionTools(home, fork);
    await app(async (client) => {
      const completed = new Promise<any>((resolve) => client.onNotification((method, params) => {
        if (method === 'turn/completed') resolve(params.turn);
      }));
      await client.request('thread/resume', { threadId: session, ...options });
      await client.request('turn/start', { threadId: session, input: [{ type: 'text', text: 'continue', text_elements: [] }] });
      expect(await completed).toMatchObject({ status: 'completed' });
    });
    const sent = JSON.stringify(bodies.at(-1).input);
    expect(sent).toContain('imported-assistant-marker');
    expect(sent).not.toContain(INVENTED);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
