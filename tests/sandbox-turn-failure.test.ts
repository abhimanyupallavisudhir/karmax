import { describe, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import type { WorldDiagnosis } from '../src/world/types.js';
import { withClaudeStartupDeadline } from '../src/agent/sdk-stream.js';
import { providerFailure, ProviderOutage } from '../src/agent/limits.js';

/**
 * Tasks 348 and 349 escalated to a human because a sandbox frozen by memory
 * exhaustion produced errors ("Claude Code process exited with code -1",
 * E2B's "Sandbox is probably not running anymore") that were classified as
 * non-retryable agent errors. The sandbox's own metrics prove the cause.
 */
async function failTurn(failure: Error, diagnosis: WorldDiagnosis | undefined) {
  const store = (await Store.create(':memory:'));
  const worlds = new WorldRegistry();
  let asked: { since: number } | undefined;
  const world = {
    handle: { kind: 'fake-remote', id: 'sandbox-task', root: '/workspace', branch: 'karmax/sandbox-task', base: 'main' },
    async exec() { return { code: 0, stdout: '', stderr: '' }; },
    async writeFile() {}, async readFile() { return ''; }, async listFiles() { return []; }, async destroy() {},
    async diagnose(window: { since: number }) { asked = window; return diagnosis; },
  };
  worlds.register({
    kind: 'fake-remote', capabilities: { remote: true },
    async create() { throw new Error('unused'); },
    async open() { return world; },
    async destroy() {},
  } as any);
  const adapters = new Map([['mock', { provider: 'mock', async runTurn() { throw failure; } }]]) as any;
  const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') });
  const started = Date.now();
  try {
    const error = await core.runAgentTurn({
      taskId: 'sandbox-task', role: 'do', worldHandle: world.handle,
      messages: [{ id: 'm0', role: 'user', text: 'typecheck', ts: 0 }],
      task: { projectId: 'project', title: 'Sandbox', prompt: 'typecheck', project: {}, workflow: 'software-dev' },
    } as any).then(() => undefined, (caught) => caught);
    return { error, asked, started };
  } finally {
    // The failed turn publishes its activity events without awaiting them.
    await new Promise((resolve) => setTimeout(resolve, 100));
    (await store.close());
  }
}

const exhausted: WorldDiagnosis = {
  summary: 'sandbox memory reached 1961 of 1983 MB (99%) at 04:56:00 UTC', memoryExhausted: true,
};

describe('sandbox-caused turn failures', () => {
  it('routes a silent SDK startup through the automatic infrastructure retry path', async () => {
    vi.useFakeTimers();
    let failure: Error;
    const abort = vi.fn();
    try {
      const silent = (async function* () { await new Promise(() => {}); })();
      const failed = withClaudeStartupDeadline(silent, abort).next().catch(error => error);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      failure = await failed;
      expect(abort).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
    const { error } = await failTurn(failure!, undefined);
    expect(error).toMatchObject({ type: 'agent-infra', nonRetryable: false, message: failure!.message });
  });

  it('retries a turn the sandbox broke, and says why', async () => {
    for (const failure of [new Error('Claude Code process exited with code -1'),
      Object.assign(new Error('Sandbox is probably not running anymore'), { name: 'SandboxNotFoundError' })]) {
      const { error, asked, started } = await failTurn(failure, exhausted);
      expect(error).toMatchObject({ type: 'agent-infra', nonRetryable: false });
      expect(error.message).toBe(`${failure.message} — ${exhausted.summary}; a command in the sandbox likely used more memory than it has.`);
      expect(asked!.since).toBeGreaterThanOrEqual(started - 1_000);
    }
  });

  it('keeps a real agent error an agent error when the sandbox is healthy', async () => {
    const { error } = await failTurn(new Error('Claude Code process exited with code 1'), undefined);
    expect(error).toMatchObject({ type: 'agent-error', nonRetryable: true });
    expect(error.message).toBe('Claude Code process exited with code 1');
  });

  it('does not blame the control-plane host for a process killed inside a sandbox', async () => {
    const { error } = await failTurn(new Error('Claude Code process terminated by signal SIGKILL'), exhausted);
    expect(error).toMatchObject({ type: 'agent-infra', nonRetryable: false });
    expect(error.message).not.toMatch(/host memory|krmax restart/i);
    expect(error.message).toContain(exhausted.summary);
  });

  it('tells the retried agent what froze the sandbox', async () => {
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    const world = {
      handle: { kind: 'fake-remote', id: 'retry-task', root: '/workspace', branch: 'karmax/retry-task', base: 'main' },
      async exec() { return { code: 0, stdout: '', stderr: '' }; },
      async writeFile() {}, async readFile() { return ''; }, async listFiles() { return []; }, async destroy() {},
      async diagnose() { return exhausted; },
    };
    worlds.register({ kind: 'fake-remote', capabilities: { remote: true }, async create() { throw new Error('unused'); },
      async open() { return world; }, async destroy() {} } as any);
    const prompts: string[][] = [];
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any) {
      prompts.push(input.messages.map((m: any) => m.text));
      if (prompts.length === 1) throw new Error('Claude Code process exited with code -1');
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done', session: 'session-1' };
    } }]]) as any;
    const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') });
    let attempt = 1;
    const context = vi.spyOn(Context, 'current').mockImplementation(() => ({
      cancellationSignal: new AbortController().signal, heartbeat() {},
      info: { attempt, heartbeatDetails: { session: 'session-1' }, activityId: '1',
        workflowExecution: { workflowId: 'retry-task', runId: 'run' }, currentAttemptScheduledTimestampMs: Date.now() },
    } as any));
    const turn = () => core.runAgentTurn({
      taskId: 'retry-task', role: 'do', agentTurnId: 'retry-task#0', worldHandle: world.handle,
      messages: [{ id: 'm0', role: 'user', text: 'typecheck', ts: 0 }],
      task: { projectId: 'project', title: 'Retry', prompt: 'typecheck', project: {}, workflow: 'software-dev' },
    } as any);
    try {
      await expect(turn()).rejects.toMatchObject({ type: 'agent-infra' });
      attempt = 2;
      await turn();
      expect(prompts[1]).toEqual([`(This turn was interrupted mid-run: ${exhausted.summary}. Keep memory-hungry commands `
        + '(type checks, test suites, builds) within the memory `free -m` reports as available. Continue from where you left off; '
        + 'if the work was already finished, restate the final result.)']);
    } finally {
      context.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 100));
      (await store.close());
    }
  });

  it('treats an unreachable sandbox as retryable even without metrics', async () => {
    const failure = Object.assign(new Error('Sandbox is probably not running anymore'), { name: 'SandboxNotFoundError' });
    const { error } = await failTurn(failure, undefined);
    expect(error).toMatchObject({ type: 'agent-infra', nonRetryable: false, message: failure.message });
  });

  // A login the provider has just proven valid must never be parked for a
  // person to sign in again: that cannot fix an outage (2026-09-25).
  it('retries a provider outage as infrastructure instead of parking the login', async () => {
    const rejected = providerFailure('Codex credential rejected', { kind: 'credential', permanence: 'hard', provider: 'codex',
      diagnostic: { code: 'unauthorized', status: 401 } });
    const failure = new ProviderOutage('OpenAI is rejecting Codex model requests even though this ChatGPT login is valid', { cause: rejected });
    const { error } = await failTurn(failure, undefined);
    expect(error).toMatchObject({ type: 'agent-infra', nonRetryable: false, message: failure.message });
  });
});
