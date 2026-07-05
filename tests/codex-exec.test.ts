import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/agent/codex.js';

/**
 * Exercises the Codex SUBSCRIPTION adapter path (`codex exec --json`) without a
 * real Codex login or model call, by pointing KARMAX_CODEX_EXEC_CMD at a stub that
 * emits the exec JSONL event stream and writes the -o final-message file. STUB_MODE
 * flips it between a normal turn and a usage-limit failure.
 */
const STUB = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const oi = argv.indexOf('-o');
const outFile = oi >= 0 ? argv[oi + 1] : null;
const mode = process.env.STUB_MODE || 'ok';
if (mode === 'limit') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_stub' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { type: 'UsageLimitReachedError', resets_in_seconds: 1800 } }) + '\\n');
  process.exit(1);
}
if (outFile) fs.writeFileSync(outFile, 'FINAL ANSWER from codex stub');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_stub' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'working on it' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
process.exit(0);
`;

describe('CodexAdapter subscription path (codex exec)', () => {
  let dir: string;
  const adapter = new CodexAdapter();
  const world: any = { handle: { id: 'w1', root: os.tmpdir(), branch: 'b', base: 'main' } };
  const profile: any = { id: 'p', name: 'c', provider: 'codex', model: 'gpt-5.5', role: 'do', capabilities: [] };
  const ctx: any = { emit: () => {} };
  const makeInput = () => ({
    profile,
    world,
    messages: [{ id: 'm', role: 'user', text: 'do the thing', ts: 0 }],
    systemPrompt: 'You are a coder.',
    role: 'do',
    resolvedAuth: { configHome: dir }, // config-home auth → routes to the subscription path
  });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-stub-'));
    const stubPath = path.join(dir, 'codex-stub.cjs');
    fs.writeFileSync(stubPath, STUB);
    fs.chmodSync(stubPath, 0o755);
    process.env.KARMAX_CODEX_EXEC_CMD = stubPath;
  });
  afterAll(() => {
    delete process.env.KARMAX_CODEX_EXEC_CMD;
    delete process.env.STUB_MODE;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('routes a config-home (subscription) auth to `codex exec` and returns its output + thread id', async () => {
    delete process.env.STUB_MODE;
    const r = await adapter.runTurn(makeInput() as any, ctx);
    expect(r.output).toContain('FINAL ANSWER');
    expect(r.session).toBe('th_stub');
  });

  it('throws a usage-limit error carrying the reset on a turn.failed limit event', async () => {
    process.env.STUB_MODE = 'limit';
    await expect(adapter.runTurn(makeInput() as any, ctx)).rejects.toThrow(/usage limit reached.*1800s/i);
  });
});
