// The Codex Responses API rail (API-key auth) had NO tests, which is how three
// real defects survived in it. This exercises it against a stub HTTP server
// pointed at by KARMAX_OPENAI_BASE_URL — no network, no tokens.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { CodexAdapter } from '../src/agent/codex.js';

describe('CodexAdapter Responses API path (API key)', () => {
  let server: http.Server;
  let base: string;
  /** Every request body the adapter sent, in order. */
  let seen: any[] = [];
  /** Queue of canned responses; each request shifts one. */
  let queue: any[] = [];

  const adapter = new CodexAdapter();
  const world: any = { handle: { id: 'w1', root: os.tmpdir(), branch: 'b', base: 'main' } };
  const profile: any = { id: 'p', name: 'c', provider: 'codex', model: 'gpt-5.5', role: 'do', capabilities: [] };

  const makeInput = (over: Record<string, unknown> = {}) => ({
    profile,
    world,
    messages: [{ id: 'm', role: 'user', text: 'do the thing', ts: 0 }],
    systemPrompt: 'SYSTEM-PROMPT-SENTINEL',
    role: 'do',
    resolvedAuth: { apiKey: 'sk-test' }, // API-key auth → routes to the Responses rail
    ...over,
  });

  const completed = (id: string, text: string, calls: any[] = []) => ({
    id, status: 'completed',
    output: [...calls, { type: 'message', content: [{ type: 'output_text', text }] }],
  });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push(JSON.parse(body || '{}'));
        const next = queue.shift() ?? completed('resp_default', 'done');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    process.env.KARMAX_OPENAI_BASE_URL = base;
  });
  afterAll(async () => {
    delete process.env.KARMAX_OPENAI_BASE_URL;
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => { seen = []; queue = []; });

  it('sends the system prompt on EVERY call, not just the first', async () => {
    // Regression: `instructions` was sent only when there was no
    // previous_response_id. The Responses API does not carry instructions across
    // previous_response_id, so a multi-step tool-using turn lost its entire
    // system prompt after the first model call.
    queue = [
      completed('resp_1', '', [{ type: 'function_call', call_id: 'c1', name: 'not_a_real_tool', arguments: '{}' }]),
      completed('resp_2', 'finished'),
    ];
    const r = await adapter.runTurn(makeInput() as any, { emit: () => {} } as any);

    expect(r.output).toContain('finished');
    expect(seen.length).toBe(2);
    for (const [i, body] of seen.entries())
      expect(body.instructions, `call ${i + 1} lost the system prompt`).toBe('SYSTEM-PROMPT-SENTINEL');
    // The chain id is still threaded on the follow-up call.
    expect(seen[0].previous_response_id).toBeUndefined();
    expect(seen[1].previous_response_id).toBe('resp_1');
  });

  it('acknowledges completion tool outputs before returning a resumable session at the turn cap', async () => {
    queue = [
      completed('resp_complete_call', '', [{ type: 'function_call', call_id: 'finish', name: 'signal_completion', arguments: '{}' }]),
      completed('resp_ack', 'Finished'),
      completed('resp_resumed', 'Continued'),
    ];
    let completions = 0;
    const ctx = { emit: () => {}, signalCompletion: () => { completions++; } } as any;
    const result = await adapter.runTurn(makeInput({ maxTurns: 1 }) as any, ctx);
    expect(completions).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ previous_response_id: 'resp_complete_call', tool_choice: 'none',
      input: [{ type: 'function_call_output', call_id: 'finish' }] });
    expect(result.session).toBe('resp_ack');
    expect(result.termination).toMatchObject({ kind: 'success', reason: 'signal_completion' });
    await adapter.runTurn(makeInput({ session: result.session }) as any, ctx);
    expect(seen[2].previous_response_id).toBe('resp_ack');
  });

  it('sends the system prompt when RESUMING a prior session', async () => {
    queue = [completed('resp_9', 'resumed')];
    await adapter.runTurn(makeInput({ session: 'resp_prior' }) as any, { emit: () => {} } as any);
    expect(seen[0].previous_response_id).toBe('resp_prior');
    expect(seen[0].instructions).toBe('SYSTEM-PROMPT-SENTINEL');
  });

  it('checkpoints the session via ctx.onSession so a crash resumes instead of replaying', async () => {
    // Regression: this rail never called ctx.onSession — the sole writer of the
    // crash-resume record. Without it a mid-turn worker restart replayed the whole
    // turn from the PREVIOUS turn's response id, re-running every tool call
    // already executed this turn.
    const sessions: string[] = [];
    queue = [
      completed('resp_a', '', [{ type: 'function_call', call_id: 'c1', name: 'not_a_real_tool', arguments: '{}' }]),
      completed('resp_b', 'done'),
    ];
    const r = await adapter.runTurn(makeInput() as any, {
      emit: () => {},
      onSession: (s: string) => sessions.push(s),
    } as any);

    // Reported as soon as it exists, and again when the chain advances — never
    // only at the end, which would be useless for a mid-turn crash.
    expect(sessions).toEqual(['resp_a', 'resp_b']);
    expect(r.session).toBe('resp_b');
  });

  it('treats an output-boundary stop as a RETRYABLE interruption, not a hard failure', async () => {
    // Regression: any non-'completed' status threw a message matching nothing in
    // isTransportError, so it was filed non-retryable and escalated to a human —
    // while ACP and both Claude paths resume the session instead.
    queue = [{ id: 'resp_x', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }];
    const err = await adapter.runTurn(makeInput() as any, { emit: () => {} } as any).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // The phrase isTransportError() recognises (limits.ts), which is what makes
    // the failure classify as a retryable `agent-infra`.
    expect(err.message).toMatch(/turn interrupted before completion/i);
    expect(err.message).toMatch(/max_output_tokens/);
  });

  it('still fails hard on a genuine provider error', async () => {
    queue = [{ id: 'resp_y', status: 'failed', error: { message: 'model exploded' }, output: [] }];
    const err = await adapter.runTurn(makeInput() as any, { emit: () => {} } as any).catch((e) => e);
    expect(err.message).toMatch(/did not complete successfully/i);
    expect(err.message).not.toMatch(/turn interrupted before completion/i);
  });
});
