import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { messagesToDeliver, conversationToPromptText } from '../src/agent/history.js';
import { CodexAdapter } from '../src/agent/codex.js';
import type { Message } from '../src/domain/types.js';

const msg = (id: string, role: Message['role'], text: string, ts = 0): Message => ({ id, role, text, ts });

/**
 * Conversation-history delivery (SPEC §7.2). A resumed provider session already
 * holds the whole prior conversation, so a turn must send only the messages NEW
 * since it last advanced — NOT the entire transcript (the old Claude bug) and not
 * merely the single latest message (the old Codex bug, which dropped any others
 * queued since the last turn). A fresh session / fork gets the full transcript.
 */
describe('messagesToDeliver', () => {
  const convo = [
    msg('m0', 'user', 'first user message'),
    msg('a0', 'agent', 'first agent reply'),
    msg('m1', 'user', 'a follow-up'),
  ];

  it('sends the WHOLE conversation on a fresh session (no session id)', () => {
    expect(messagesToDeliver({ messages: convo } as any)).toEqual(convo);
  });

  it('sends only the delta after deliveredMessages when resuming a session', () => {
    // The session already holds the first two messages; only the follow-up is new.
    const out = messagesToDeliver({ messages: convo, session: 's1', deliveredMessages: 2 } as any);
    expect(out).toEqual([convo[2]]);
  });

  it('sends EVERY message queued since the last turn, not just the latest', () => {
    // A follow-up AND a drained sub-task event both arrived before this turn.
    const many = [...convo, msg('st', 'user', 'sub-task finished'), msg('m2', 'user', 'and another follow-up')];
    const out = messagesToDeliver({ messages: many, session: 's1', deliveredMessages: 3 } as any);
    expect(out).toEqual([many[3], many[4]]);
  });

  it('treats deliveredMessages as 0 when unset (resume falls back to full history)', () => {
    expect(messagesToDeliver({ messages: convo, session: 's1' } as any)).toEqual(convo);
  });

  it('sends the full transcript on a fork (branches from a DIFFERENT session)', () => {
    // fork:true → the resumed id carries the SOURCE conversation, not `messages`.
    expect(messagesToDeliver({ messages: convo, session: 's1', deliveredMessages: 2, fork: true } as any)).toEqual(convo);
  });

  it('clamps a delivered count past the end to an empty delta', () => {
    expect(messagesToDeliver({ messages: convo, session: 's1', deliveredMessages: 99 } as any)).toEqual([]);
  });
});

/**
 * Single-string serialization (Claude Agent SDK `prompt`, `codex exec`): both
 * providers accept only ONE user string, so a replayed transcript must attribute
 * the agent's own turns — otherwise its prior replies fold back in as fresh user
 * input (the "This is the merge task…" folded blob seen in a real session).
 */
describe('conversationToPromptText', () => {
  it('leaves a single user follow-up (the resume delta) byte-for-byte unchanged', () => {
    expect(conversationToPromptText([msg('m1', 'user', 'a follow-up')])).toBe('a follow-up');
  });

  it('attributes agent turns so a replayed reply is never bare user text', () => {
    const out = conversationToPromptText([
      msg('m0', 'user', 'ORIGINAL_TASK'),
      msg('a0', 'agent', 'AGENT_REPLY'),
      msg('m1', 'user', 'NEW_ASK'),
    ]);
    // The agent's own reply is labeled, not folded in as if the user said it.
    expect(out).toContain('assistant: AGENT_REPLY');
    expect(out).not.toContain('\n\nAGENT_REPLY'); // never appears as a bare (user) block
    // User turns stay unlabeled and in order.
    expect(out).toBe('ORIGINAL_TASK\n\nassistant: AGENT_REPLY\n\nNEW_ASK');
  });

  it('joins multiple user turns queued since the last turn with a blank line', () => {
    expect(conversationToPromptText([msg('a', 'user', 'one'), msg('b', 'user', 'two')])).toBe('one\n\ntwo');
  });

  it('is empty for an empty delivery (caller substitutes a Continue/Begin fallback)', () => {
    expect(conversationToPromptText([])).toBe('');
  });
});

// The exec STUB records its argv (incl. the positional prompt) to STUB_ARGV_OUT so we
// can assert what the adapter actually sends the model — end-to-end, no real Codex.
const STUB = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const oi = argv.indexOf('-o');
const outFile = oi >= 0 ? argv[oi + 1] : null;
// AD-17: the prompt arrives on stdin (argv ends with '-') so it never shows in /proc.
const prompt = argv[argv.length - 1] === '-' ? fs.readFileSync(0, 'utf8') : argv[argv.length - 1];
if (process.env.STUB_ARGV_OUT) fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify({ argv, prompt }));
if (outFile) fs.writeFileSync(outFile, 'ok');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_stub' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
process.exit(0);
`;

describe('codex exec sends only the delta when resuming a thread', () => {
  let dir: string;
  const adapter = new CodexAdapter();
  const world: any = { handle: { id: 'w1', root: os.tmpdir(), branch: 'b', base: 'main' } };
  const profile: any = { id: 'p', name: 'c', provider: 'codex', model: 'gpt-5.5', role: 'do', capabilities: [] };
  const ctx: any = { emit: () => {} };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-hist-'));
    const stubPath = path.join(dir, 'codex-stub.cjs');
    fs.writeFileSync(stubPath, STUB);
    fs.chmodSync(stubPath, 0o755);
    process.env.KARMAX_CODEX_EXEC_CMD = stubPath;
    // These assert the `codex exec` delta wire format; force the exec rail (the
    // subscription default is now the app-server — see codex.ts runSubscription).
    process.env.KARMAX_CODEX_USE_EXEC = '1';
  });
  afterAll(() => {
    delete process.env.KARMAX_CODEX_EXEC_CMD;
    delete process.env.KARMAX_CODEX_USE_EXEC;
    delete process.env.STUB_ARGV_OUT;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const invocationFor = async (input: any) => {
    const out = path.join(dir, `argv-${Math.random().toString(36).slice(2)}.json`);
    process.env.STUB_ARGV_OUT = out;
    await adapter.runTurn(input, ctx);
    return JSON.parse(fs.readFileSync(out, 'utf8')) as { argv: string[]; prompt: string };
  };

  it('resume: only the new follow-up reaches the model, prior messages stay server-side', async () => {
    const messages = [
      msg('m0', 'user', 'ORIGINAL_TASK'),
      msg('a0', 'agent', 'AGENT_REPLY'),
      msg('m1', 'user', 'FOLLOW_UP_MESSAGE'),
    ];
    const id = '11111111-1111-4111-8111-111111111111';
    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `rollout-2026-09-09T00-00-00-${id}.jsonl`), JSON.stringify({
      ordinal: 0, type: 'session_meta', payload: { id, history_mode: 'paginated', timestamp: '2026-09-09T00:00:00Z' },
    }) + '\n');
    const { argv, prompt } = await invocationFor({ profile, world, messages, session: '11111111-1111-4111-8111-111111111111', deliveredMessages: 2, systemPrompt: 'SYS', role: 'do', resolvedAuth: { configHome: dir } });
    expect(argv.slice(0, 3)).toEqual(['exec', 'resume', '11111111-1111-4111-8111-111111111111']);
    expect(prompt).toContain('FOLLOW_UP_MESSAGE');
    expect(prompt).not.toContain('ORIGINAL_TASK');
    expect(prompt).not.toContain('AGENT_REPLY');
  });

  it('fresh: the whole conversation + system prompt is replayed', async () => {
    const messages = [msg('m0', 'user', 'ORIGINAL_TASK'), msg('a0', 'agent', 'AGENT_REPLY'), msg('m1', 'user', 'FOLLOW_UP_MESSAGE')];
    const { argv, prompt } = await invocationFor({ profile, world, messages, systemPrompt: 'SYS_PROMPT', role: 'do', resolvedAuth: { configHome: dir } });
    expect(argv[0]).toBe('exec');
    expect(argv).not.toContain('resume');
    expect(prompt).toContain('SYS_PROMPT');
    expect(prompt).toContain('ORIGINAL_TASK');
    expect(prompt).toContain('FOLLOW_UP_MESSAGE');
  });
});
