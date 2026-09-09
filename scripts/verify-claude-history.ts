/** Live regression: old malformed history fails, then the real adapter recovers
 * it and runs a tool. Also verifies new imports and a subsequent native resume.
 * Run: KARMAX_CLAUDE_TEST_CONFIG_HOME=/path/to/claude/home npx tsx scripts/verify-claude-history.ts
 * Uses only the existing access token, never copies or rotates a refresh token.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { importWithPanagent } from '../src/agent/panagent.js';
import { claudeCwdSlug } from '../src/agent/fork.js';

const authHome = process.env.KARMAX_CLAUDE_TEST_CONFIG_HOME;
assert(authHome, 'Set KARMAX_CLAUDE_TEST_CONFIG_HOME to an authorized Claude login home');
const auth = JSON.parse(fs.readFileSync(path.join(authHome, '.credentials.json'), 'utf8')).claudeAiOauth;
assert(auth?.accessToken && auth.expiresAt > Date.now(), 'Live test requires an unexpired access token');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-claude-history-live-'));
const oldHome = process.env.KARMAX_HOME;
process.env.KARMAX_HOME = path.join(root, 'state');
const home = path.join(root, 'claude');
const cwd = path.join(root, 'world');
fs.mkdirSync(cwd, { recursive: true });
const marker = `HISTORY_${crypto.randomBytes(6).toString('hex')}`;
const source = [
  { type: 'session_meta', payload: { id: crypto.randomUUID(), cwd } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Remember the secret test marker ${marker}.` }] } },
  { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call1', name: 'exec', input: "text(await tools.exec_command({cmd: 'printf test'}));" } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call1', output: 'test' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I remember the marker.' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n';
const sessionFile = (id: string) => path.join(home, 'projects', claudeCwdSlug(cwd), `${id}.jsonl`);
async function imported() {
  const result = await importWithPanagent({ source: { data: Buffer.from(source) }, provider: 'claude',
    forkHome: home, worldPath: cwd, mode: 'transcript', native: true });
  assert.equal(result.kind, 'native');
  if (result.kind !== 'native') throw new Error('expected native');
  return result.sessionId;
}
async function turn(session: string, proof: string) {
  const activities: any[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const result = await new ClaudeAdapter().runTurn({
      profile: { id: 'live-regression', name: 'Claude regression', provider: 'claude', role: 'do', model: 'haiku', capabilities: [] },
      world: { handle: { id: 'claude-history-live', root: cwd, branch: 'test', base: 'main' } },
      messages: [{ id: crypto.randomUUID(), role: 'user', ts: Date.now(), text:
        `Use Bash to write the exact test marker from the earlier conversation into ${proof}. Then reply with that marker. This is a bounded regression test; do nothing else.` }],
      systemPrompt: 'You are running a bounded history regression. Use only Bash to write the requested local file, then answer. Do not call MCP tools.',
      role: 'do', session, resolvedAuth: { configHome: home, oauthToken: auth.accessToken },
    } as any, { emit() {}, emitActivity(a: any) { activities.push(a); }, signal: controller.signal } as any);
    assert.equal(fs.readFileSync(path.join(cwd, proof), 'utf8').trim(), marker);
    assert(result.session, 'adapter must publish a resumable session');
    assert(activities.some(a => a.kind === 'command'), 'expected a real tool activity');
    return { result, activities };
  } finally { clearTimeout(timer); }
}
try {
  const brokenId = await imported();
  const broken = fs.readFileSync(sessionFile(brokenId), 'utf8').trim().split('\n').map(line => {
    const r = JSON.parse(line);
    if (Array.isArray(r.message?.content)) for (const b of r.message.content)
      if (b.type === 'tool_use') b.input = b.input.input;
    return JSON.stringify(r);
  }).join('\n') + '\n';
  fs.writeFileSync(sessionFile(brokenId), broken);
  let rejected = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    for await (const message of query({ prompt: 'Reply OK.', options: { cwd, resume: brokenId,
      model: 'haiku', maxTurns: 1, tools: [], strictMcpConfig: true, mcpServers: {},
      abortController: controller, env: { ...process.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_OAUTH_TOKEN: auth.accessToken } } })) {
      if (JSON.stringify(message).includes('Input should be an object')) rejected = true;
    }
  } catch (error) {
    if (!String(error).includes('Input should be an object')) throw error;
    rejected = true;
  } finally { clearTimeout(timer); }
  assert(rejected, 'Unfixed history must reproduce the reported API validation error');
  console.log('PASS: reproduced the original API 400 with malformed history');
  const before = fs.readFileSync(sessionFile(brokenId), 'utf8');
  const recovered = await turn(brokenId, 'recovered.txt');
  assert.notEqual(recovered.result.session, brokenId);
  assert(recovered.activities.some(a => a.id === 'claude-history-recovery'));
  assert.equal(fs.readFileSync(sessionFile(brokenId), 'utf8'), before);
  console.log('PASS: adapter recovered existing history, recalled context, and executed Bash');
  await turn(recovered.result.session!, 'resumed.txt');
  console.log('PASS: recovered session resumed successfully on a subsequent turn');
  const fresh = await turn(await imported(), 'imported.txt');
  assert(!fresh.activities.some(a => a.id === 'claude-history-recovery'));
  console.log('PASS: new Codex import resumed through the adapter and executed Bash');
} finally {
  if (oldHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
}
