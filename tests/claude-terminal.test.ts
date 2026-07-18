import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sdkState = vi.hoisted(() => ({ messages: [] as any[], options: undefined as any }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (config: any) => ({ type: 'sdk', name: config.name, instance: {}, tools: config.tools }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
  query: (args: any) => {
    sdkState.options = args.options;
    return (async function* () {
      for (const message of sdkState.messages) yield message;
    })();
  },
}));

import { ClaudeAdapter } from '../src/agent/claude.js';
import { ProviderFailure } from '../src/agent/limits.js';

const input: any = {
  profile: { id: 'p', name: 'claude', provider: 'claude', role: 'do', capabilities: [] },
  world: { handle: { id: 'w', root: '/tmp', branch: 'task', base: 'main' } },
  messages: [{ id: 'm', role: 'user', text: 'do the task', ts: 0 }],
  systemPrompt: 'Do the task.',
  role: 'do',
  resolvedAuth: { configHome: '/tmp/claude-terminal-test' },
};

const ctx: any = {
  signalCompletion() {},
  createReviewInfo() {},
  createSubTask() {},
  respondToSubTask() {},
  raiseToParent() {},
  waitForSubtasks() {},
  saveSkill() {},
  resolveDecision() {},
  confirmDecision() {},
  requestSpend: async () => ({ status: 'denied' }),
  emit() {},
};

describe('Claude Agent SDK terminal outcome contract', () => {
  beforeEach(() => { sdkState.messages = []; sdkState.options = undefined; });

  it('uses one stdio platform server plus a disjoint local-control server', async () => {
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' }];
    await new ClaudeAdapter().runTurn({ ...input, extraEnv: { KARMAX_TOKEN: 'scoped' } }, ctx);
    expect(sdkState.options.strictMcpConfig).toBe(true);
    expect(sdkState.options.mcpServers.karmax).toMatchObject({
      command: process.execPath,
      env: expect.objectContaining({ KARMAX_TOKEN: 'scoped' }),
      alwaysLoad: true,
    });
    expect(sdkState.options.mcpServers.karmax_control).toMatchObject({ type: 'sdk', name: 'karmax_control' });
  });

  it('returns only after an explicit SDK success result', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' },
    ];
    const turn = await new ClaudeAdapter().runTurn(input, ctx);
    expect(turn.termination).toEqual({ kind: 'success', status: 'success', reason: 'end_turn' });
    expect(turn.output).toBe('done');
  });

  it('selects the remote Claude spawn rail and keeps all platform tools available', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-claude-'));
    fs.writeFileSync(path.join(home, '.credentials.json'), '{"oauth":"subscription"}');
    const files = new Map<string, Buffer>();
    const world: any = {
      handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'sealed', id: 'remote',
        root: '/workspace', branch: 'task', base: 'main' },
      async exec(_command: string, args: string[]) {
        if (args[1]?.includes('-type f -print')) return { stdout: '', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
      async writeFileBuffer(name: string, value: Buffer) { files.set(name, Buffer.from(value)); },
      async readFile(name: string) { const value = files.get(name); if (!value) throw new Error('missing'); return value.toString(); },
      async readFileBuffer(name: string) { const value = files.get(name); if (!value) throw new Error('missing'); return value; },
      async writeFile(name: string, value: string) { files.set(name, Buffer.from(value)); },
      async listFiles() { return [...files.keys()]; }, async destroy() {},
    };
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 'remote-session', stop_reason: 'end_turn' }];
    try {
      await new ClaudeAdapter().runTurn({ ...input, world, resolvedAuth: { configHome: home } }, ctx);
      expect(sdkState.options.spawnClaudeCodeProcess).toBeTypeOf('function');
      expect(sdkState.options.mcpServers.karmax).toBeUndefined();
      expect(sdkState.options.mcpServers.karmax_control.tools.map((tool: any) => tool.name))
        .toEqual(expect.arrayContaining(['message_agent', 'list_world_files', 'read_world_file']));
      expect(files.get('.karmax-injection/agent/claude/.credentials.json')?.toString()).toContain('subscription');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects an SDK error result even after partial assistant output', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial work' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', errors: ['stream disconnected'] },
    ];
    await expect(new ClaudeAdapter().runTurn(input, ctx)).rejects.toThrow(/error_during_execution.*stream disconnected/i);
  });

  it('types novel credit-exhaustion wording from an SDK error result', async () => {
    sdkState.messages = [
      {
        type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1',
        errors: ['Your prepaid balance has now been fully consumed.'],
      },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'hard', provider: 'claude', source: 'message',
    });
  });

  it('rejects a stream that ends without any result event', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial work' }] } },
    ];
    await expect(new ClaudeAdapter().runTurn(input, ctx)).rejects.toThrow(/stream ended unexpectedly.*successful result/i);
  });
});
