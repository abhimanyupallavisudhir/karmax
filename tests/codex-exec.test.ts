import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/agent/codex.js';
import { ProviderFailure } from '../src/agent/limits.js';
import { AttachmentStore } from '../src/store/attachments.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

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
if (process.env.STUB_ARGV_OUT) {
  const imgs = [];
  for (let k = 0; k < argv.length; k++) if (argv[k] === '-i') { const pth = argv[k + 1]; imgs.push({ path: pth, exists: fs.existsSync(pth), size: fs.existsSync(pth) ? fs.statSync(pth).size : 0 }); }
  fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify({ argv, imgs, custody: process.env.KARMAX_CUSTODY_CHAIN }));
}
const mode = process.env.STUB_MODE || 'ok';
if (mode === 'limit') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_stub' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { type: 'UsageLimitReachedError', resets_in_seconds: 1800 } }) + '\\n');
  process.exit(1);
}
if (mode === 'partial-fail') {
  if (outFile) fs.writeFileSync(outFile, 'PARTIAL ANSWER that must not count as success');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_stub' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'connection reset during turn' } }) + '\\n');
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
    // This suite validates the legacy one-shot `codex exec` rail; force it (the
    // subscription default is now the app-server — see codex.ts runSubscription).
    process.env.KARMAX_CODEX_USE_EXEC = '1';
  });
  afterAll(() => {
    delete process.env.KARMAX_CODEX_EXEC_CMD;
    delete process.env.KARMAX_CODEX_USE_EXEC;
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
    const failure = await adapter.runTurn(makeInput() as any, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.message).toMatch(/usage limit reached.*1800s/i);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'transient', provider: 'codex', source: 'structured', resetHint: 'in 1800s',
    });
  });

  it('rejects a nonzero exit even when Codex wrote a partial final-message file', async () => {
    process.env.STUB_MODE = 'partial-fail';
    await expect(adapter.runTurn(makeInput() as any, ctx)).rejects.toThrow(/terminated before successful completion.*connection reset/i);
  });

  it('attaches prompt images via `-i <file>` and cleans up the temp files', async () => {
    delete process.env.STUB_MODE;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-home-'));
    const prevHome = process.env.KARMAX_HOME;
    process.env.KARMAX_HOME = home;
    const argvOut = path.join(home, 'argv.json');
    process.env.STUB_ARGV_OUT = argvOut;
    try {
      const ref = new AttachmentStore({ home }).put(PNG, 'image/png');
      const input = makeInput() as any;
      input.messages = [{ id: 'm', role: 'user', text: 'what is in this image?', ts: 0, images: [ref] }];
      await adapter.runTurn(input, ctx);
      const rec = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
      expect(rec.imgs.length).toBe(1);
      expect(rec.imgs[0].exists).toBe(true); // the file existed WHILE codex ran
      expect(rec.imgs[0].size).toBe(PNG.length);
      expect(rec.custody).toMatch(/[0-9a-f-]{36}$/i);
      // …and was cleaned up after the turn finished.
      expect(fs.existsSync(rec.imgs[0].path)).toBe(false);
    } finally {
      delete process.env.STUB_ARGV_OUT;
      if (prevHome === undefined) delete process.env.KARMAX_HOME;
      else process.env.KARMAX_HOME = prevHome;
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
