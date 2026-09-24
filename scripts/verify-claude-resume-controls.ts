/** Live regression for task #348: after a Claude turn dies with a background shell
 * still running, the resumed turn must keep its in-process `karmax_control` tools.
 *
 * Claude Code first settles the orphaned shell and emits an empty `result` before it
 * handles the resumed prompt. Closing input at that result ("interrupted before a
 * result was received"), or SDK 0.3.280 dropping SDK MCP servers on that path
 * ("no longer available"), both leave `open_pr` unusable for the whole turn.
 *
 * Run: ANTHROPIC_API_KEY=… npx tsx scripts/verify-claude-resume-controls.ts
 *  or: KARMAX_CLAUDE_TEST_CONFIG_HOME=/path/to/claude/home npx tsx scripts/verify-claude-resume-controls.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../src/agent/claude.js';

const authHome = process.env.KARMAX_CLAUDE_TEST_CONFIG_HOME;
const apiKey = process.env.ANTHROPIC_API_KEY;
assert(authHome || apiKey, 'Set ANTHROPIC_API_KEY or KARMAX_CLAUDE_TEST_CONFIG_HOME');
const oauthToken = authHome
  ? JSON.parse(fs.readFileSync(path.join(authHome, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken
  : undefined;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-claude-resume-live-'));
const oldHome = process.env.KARMAX_HOME;
process.env.KARMAX_HOME = path.join(root, 'state');
const home = authHome ?? path.join(root, 'claude');
const cwd = path.join(root, 'world');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(home, { recursive: true });

function turn(text: string, session: string | undefined, hooks: { onActivity?: (a: any, abort: () => void) => void; openPr?: () => void; onSession?: (id: string) => void }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const abort = () => controller.abort();
  return new ClaudeAdapter().runTurn({
    profile: { id: 'live-regression', name: 'Claude regression', provider: 'claude', role: 'do', model: 'haiku', capabilities: [] },
    world: { handle: { id: 'claude-resume-live', root: cwd, branch: 'test', base: 'main' } },
    messages: [{ id: crypto.randomUUID(), role: 'user', ts: Date.now(), text }],
    systemPrompt: 'You are running a bounded regression test. Do exactly what the user asks and nothing else.',
    role: 'do', session,
    resolvedAuth: { configHome: home, ...(oauthToken ? { oauthToken } : {}) },
    ...(apiKey && !oauthToken ? { secretEnv: { ANTHROPIC_API_KEY: apiKey } } : {}),
  } as any, {
    emit() {},
    emitActivity(a: any) { hooks.onActivity?.(a, abort); },
    signalCompletion() {},
    openPr() { hooks.openPr?.(); },
    onSession(id: string) { hooks.onSession?.(id); },
    signal: controller.signal,
  } as any).finally(() => clearTimeout(timer));
}

try {
  // Turn 1 dies (like a Temporal activity retry) while its background shell runs.
  let session: string | undefined;
  let aborted = false;
  await turn(
    'Use Bash with run_in_background=true to run `sleep 600`. Then run the foreground Bash command `sleep 90`. Then reply done.',
    undefined,
    {
      onSession(id) { session = id; },
      onActivity(a, abort) {
        if (!aborted && a.kind === 'command' && a.phase === 'started' && /sleep 90/.test(a.title ?? '')) {
          aborted = true;
          setTimeout(abort, 2000);
        }
      },
    },
  ).catch(() => undefined); // the abort surfaces as a cancelled turn
  assert(aborted, 'turn 1 must reach its foreground command with the background shell running');
  assert(session, 'turn 1 must publish a resumable session');
  console.log('PASS: first turn died with a background shell running');

  // Turn 2 resumes that session and must reach the in-process control tools.
  let opened = 0;
  const failures: string[] = [];
  const second = await turn('Call the mcp__karmax_control__open_pr tool now (load it with ToolSearch first if needed), then reply with its exact result.', session, {
    openPr() { opened++; },
    onActivity(a) { if (a.kind === 'tool' && a.phase === 'failed') failures.push(`${a.title}: ${a.detail}`); },
  });
  assert.deepEqual(failures, [], 'no control-tool call may fail after resume');
  assert(opened > 0, `open_pr must reach karmax after resume; agent said: ${second.output}`);
  console.log('PASS: resumed turn called open_pr through karmax_control');
} finally {
  if (oldHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
}
