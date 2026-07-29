import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/agent/codex.js';
import { SDK_CONTROL_TOOL_NAMES } from '../src/agent/tools.js';

const STUB = `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const out = process.env.STUB_REQUESTS_OUT;
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id != null && out) fs.appendFileSync(out, JSON.stringify(msg) + '\\n');
  if (msg.method === 'initialize') send({ id: msg.id, result: { codexHome: process.env.CODEX_HOME } });
  else if (msg.method === 'thread/start') send({ id: msg.id, result: { thread: { id: 'thread-new' } } });
  else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
  else if (msg.method === 'thread/fork') send({ id: msg.id, result: { thread: { id: 'thread-forked' } } });
  else if (msg.id === 5000) {
    // Karmax answered our dynamic-tool call; now finish the turn.
    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  }
  else if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } });
    const mode = process.env.STUB_MODE || 'completed';
    if (mode === 'tool') {
      // A server→client request: the model called a karmax dynamic tool.
      send({ id: 5000, method: 'item/tool/call', params: { callId: 'c1', tool: 'confirm_decision', arguments: { action: 'confirm' } } });
      return;
    }
    if (mode === 'exit') process.exit(0);
    else if (mode === 'interrupted') send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted', reason: 'server restart' } } });
    else if (mode === 'failed') send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed', error: { message: 'model execution failed' } } } });
    else send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  }
});
`;

describe('CodexAdapter app-server security policy', () => {
  let dir: string | undefined;

  afterEach(() => {
    delete process.env.KARMAX_CODEX_EXEC_CMD;
    delete process.env.KARMAX_CODEX_USE_EXEC;
    delete process.env.STUB_REQUESTS_OUT;
    delete process.env.STUB_MODE;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function run(session?: string, mode?: string, fork = false, ctx: any = {}): Promise<any[]> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-app-server-'));
    const stub = path.join(dir, 'codex-stub.cjs');
    const requests = path.join(dir, 'requests.jsonl');
    fs.writeFileSync(stub, STUB);
    fs.chmodSync(stub, 0o755);
    process.env.KARMAX_CODEX_EXEC_CMD = stub;
    process.env.STUB_REQUESTS_OUT = requests;
    if (mode) process.env.STUB_MODE = mode;

    await new CodexAdapter().runTurn(
      {
        profile: { id: 'p', name: 'codex', provider: 'codex', model: 'gpt-5.5', role: 'merge', capabilities: [] },
        world: { handle: { id: 'w', root: dir, branch: 'task', base: 'main' } },
        messages: [{ id: 'm', role: 'user', text: 'prepare the branch', ts: 0 }],
        systemPrompt: 'Prepare the branch for merge.',
        role: 'merge',
        resolvedAuth: { configHome: dir },
        ...(session ? { session } : {}), ...(fork ? { fork: true } : {}),
      } as any,
      { emit() {}, emitActivity() {}, ...ctx } as any,
    );
    return fs.readFileSync(requests, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  }

  it('starts fresh threads and turns with unrestricted, non-interactive execution', async () => {
    const requests = await run();
    expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(requests.find((r) => r.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
    });
  });

  /**
   * The turn-local controls (confirm/resolve/review-info/…) mutate the running
   * activity's result, so they are registered as app-server `dynamicTools` and
   * executed here over `item/tool/call`. This used to happen only in a remote
   * world, which left a plain Codex-subscription agent with no way to record a
   * Review verdict at all.
   */
  it('registers the turn-local control tools on a LOCAL subscription thread', async () => {
    const requests = await run();
    const dynamic = requests.find((r) => r.method === 'thread/start')?.params?.dynamicTools ?? [];
    expect(dynamic.map((t: any) => t.name).sort()).toEqual([...SDK_CONTROL_TOOL_NAMES].sort());
    // Durable platform tools stay on the config home's gateway-backed `karmax` MCP.
    expect(dynamic.map((t: any) => t.name)).not.toContain('platform_request');
  });

  it('executes a control tool call from a LOCAL thread into this turn’s result', async () => {
    let decision: any;
    const requests = await run(undefined, 'tool', false, { confirmDecision: (d: any) => { decision = d; } });
    // The handler ran in this activity and produced the Review verdict…
    expect(decision).toEqual({ action: 'confirm', text: undefined });
    // …and the app-server got a successful tool result back.
    expect(requests.find((r) => r.id === 5000)?.result).toMatchObject({
      success: true,
      contentItems: [{ type: 'inputText', text: 'confirm decision recorded: confirm' }],
    });
  });

  it('reapplies unrestricted, non-interactive execution when resuming a thread', async () => {
    const requests = await run('thread-existing');
    expect(requests.find((r) => r.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-existing',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(requests.find((r) => r.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
    });
  });

  it('forks into a new Codex thread instead of appending to the source', async () => {
    const requests = await run('thread-existing', undefined, true);
    expect(requests.find((r) => r.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'thread-existing', sandbox: 'danger-full-access', approvalPolicy: 'never',
    });
    expect(requests.some((r) => r.method === 'thread/resume')).toBe(false);
    expect(requests.find((r) => r.method === 'turn/start')?.params.threadId).toBe('thread-forked');
  });

  it('rejects an interrupted terminal status even when partial assistant text exists', async () => {
    await expect(run(undefined, 'interrupted')).rejects.toThrow(/interrupted before completion/i);
  });

  it('rejects a failed terminal status even when partial assistant text exists', async () => {
    await expect(run(undefined, 'failed')).rejects.toThrow(/model execution failed/i);
  });

  it('rejects a process/transport end without a completed terminal event', async () => {
    await expect(run(undefined, 'exit')).rejects.toThrow(/connection closed unexpectedly/i);
  });
});
