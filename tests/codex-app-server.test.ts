import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter, codexDynamicTools, isRecoverableRemoteCodexCredentialFailure } from '../src/agent/codex.js';
import { providerFailure } from '../src/agent/limits.js';
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
  else if (msg.method === 'account/rateLimits/read') send({ id: msg.id, result: {
    rateLimits: { primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1999999999 } },
  } });
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
    else if (mode === 'expired-app-token') {
      const detail = 'Provided authentication token is expired. Please try signing in again.';
      send({ method: 'mcpServer/startupStatus/updated', params: {
        name: 'codex_apps', status: 'failed', error: { message: detail, code: 'token_expired', status: 401 },
      } });
      send({ method: 'error', params: {
        // The real app-server's top-level error drops the MCP server identity;
        // correlation must use the preceding startup failure plus positive proof
        // that the main Codex account endpoint authenticated successfully.
        error: { message: detail, code: 'token_expired', status: 401 },
        willRetry: false,
      } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    }
    else if (mode === 'expired-model-token') {
      send({ method: 'error', params: {
        error: {
          message: 'The access token expired while starting the model turn.',
          code: 'token_expired', status: 401, request_id: 'req_model_auth',
          authorization: 'Bearer must-never-be-archived',
        },
        willRetry: false,
      } });
    }
    else if (mode === 'reconnect-then-completed') {
      // Current Codex emits this while its Responses stream is retrying. The
      // enum is credential-looking, but willRetry=true makes the notification
      // explicitly non-terminal; karmax must wait for the eventual turn result.
      send({ method: 'error', params: {
        error: { message: 'Reconnecting... 2/5', codexErrorInfo: 'unauthorized', httpStatusCode: 401 },
        willRetry: true,
      } });
      send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'recovered' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    }
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

    if (session) {
      const sessions = path.join(dir, 'sessions', 'forked');
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, `rollout-2026-09-09T00-00-00-${session}.jsonl`), JSON.stringify({
        ordinal: 0, type: 'session_meta', payload: { id: session, timestamp: '2026-09-09T00:00:00Z',
          history_mode: 'paginated', dynamic_tools: codexDynamicTools(false) },
      }) + '\n');
    }

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
    const requests = await run('11111111-1111-4111-8111-111111111111');
    expect(requests.find((r) => r.method === 'thread/resume')?.params).toMatchObject({
      threadId: '11111111-1111-4111-8111-111111111111',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(requests.find((r) => r.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
    });
  });

  it('forks into a new Codex thread instead of appending to the source', async () => {
    const requests = await run('11111111-1111-4111-8111-111111111111', undefined, true);
    expect(requests.find((r) => r.method === 'thread/fork')?.params).toMatchObject({
      threadId: '11111111-1111-4111-8111-111111111111', sandbox: 'danger-full-access', approvalPolicy: 'never',
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

  it('does not quarantine the Codex login when the optional Apps MCP token expires', async () => {
    await expect(run(undefined, 'expired-app-token')).resolves.toEqual(expect.any(Array));
  });

  it('preserves safe native diagnostics for a model credential rejection', async () => {
    await expect(run(undefined, 'expired-model-token')).rejects.toMatchObject({
      message: expect.stringMatching(/Codex credential rejected.*token_expired.*HTTP 401.*req_model_auth/i),
      metadata: {
        kind: 'credential', permanence: 'hard', provider: 'codex', source: 'structured',
        diagnostic: {
          message: 'The access token expired while starting the model turn.',
          code: 'token_expired', status: 401, requestId: 'req_model_auth',
          model: 'gpt-5.5', operation: 'app-server notification',
        },
      },
    });
  });

  it('does not fail or quarantine a turn for an intermediate reconnect notification', async () => {
    await expect(run(undefined, 'reconnect-then-completed')).resolves.toEqual(expect.any(Array));
  });

  it('retries only an expired remote access token through the central refresh authority', () => {
    expect(isRecoverableRemoteCodexCredentialFailure(providerFailure('expired', {
      kind: 'credential', permanence: 'hard', provider: 'codex',
      diagnostic: { code: 'token_expired', status: 401 },
    }))).toBe(true);
    expect(isRecoverableRemoteCodexCredentialFailure(providerFailure('bad key', {
      kind: 'credential', permanence: 'hard', provider: 'codex',
      diagnostic: { code: 'invalid_api_key', status: 401 },
    }))).toBe(false);
    expect(isRecoverableRemoteCodexCredentialFailure(providerFailure('terminal reconnect', {
      kind: 'credential', permanence: 'hard', provider: 'codex',
      diagnostic: { message: 'Reconnecting... 5/5', code: 'unauthorized', status: 401 },
    }))).toBe(true);
    expect(isRecoverableRemoteCodexCredentialFailure(providerFailure('missing projected auth', {
      kind: 'credential', permanence: 'hard', provider: 'codex',
      diagnostic: {
        message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
        code: 'other', status: 401,
      },
    }))).toBe(true);
    expect(isRecoverableRemoteCodexCredentialFailure(providerFailure('unrelated 401', {
      kind: 'credential', permanence: 'hard', provider: 'codex',
      diagnostic: { message: 'organization access was denied', code: 'other', status: 401 },
    }))).toBe(false);
    expect(isRecoverableRemoteCodexCredentialFailure(providerFailure('remote sentinel cannot rotate', {
      kind: 'credential', permanence: 'hard', provider: 'codex',
      diagnostic: { message: 'OAuth refresh failed: invalid grant', code: 'invalid_grant', status: 401 },
    }))).toBe(true);
  });

  it('rejects a process/transport end without a completed terminal event', async () => {
    await expect(run(undefined, 'exit')).rejects.toThrow(/connection closed unexpectedly/i);
  });
});
