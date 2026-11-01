import { describe, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import type { WorldDiagnosis } from '../src/world/types.js';
import { withClaudeStartupDeadline } from '../src/agent/sdk-stream.js';
import { AgentToolsUnavailable, providerFailure, ProviderOutage } from '../src/agent/limits.js';

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
    handle: { kind: 'fake-remote', id: 'sandbox-task', root: '/workspace', branch: 'tavya/sandbox-task', base: 'main' },
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
      handle: { kind: 'fake-remote', id: 'retry-task', root: '/workspace', branch: 'tavya/retry-task', base: 'main' },
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
        + '(type checks, test suites, builds) within the memory `free -m` reports as available. '
        + 'Commands that were running in it, including run_in_background shells, were stopped: check whether they finished '
        + 'before relying on their results. Jobs from start_job kept running. '
        // exten-epi#5: told only to "restate the final result", an agent cut off
        // by a deploy assumed its answer had been read and sent "Nothing to recover".
        + 'Your final response from it was never posted: a reply is posted only when the turn ends. '
        + 'Continue from where you left off, then give your full final response, even if you had already written it; '
        + 'do not mention the interruption unless it changes the result.)']);
    } finally {
      context.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 100));
      (await store.close());
    }
  });

  // DharmaArtha's #5 (2026-10-31): the browser tool did not connect within 30 s
  // on a machine busy with the agent's own checks, and the task stopped for a person.
  it('retries a turn whose tools did not start, and the retry carries on without them', async () => {
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    const world = {
      handle: { kind: 'fake-remote', id: 'tools-task', root: '/workspace', branch: 'tavya/tools-task', base: 'main' },
      async exec() { return { code: 0, stdout: '', stderr: '' }; },
      async writeFile() {}, async readFile() { return ''; }, async listFiles() { return []; }, async destroy() {},
      async diagnose() { return undefined; },
    };
    worlds.register({ kind: 'fake-remote', capabilities: { remote: true }, async create() { throw new Error('unused'); },
      async open() { return world; }, async destroy() {} } as any);
    const optional: Array<boolean | undefined> = [];
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any) {
      optional.push(input.toolsOptional);
      if (!input.toolsOptional) throw new AgentToolsUnavailable([{ name: 'chrome-devtools', status: 'failed' }]);
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done', session: 'session-1' };
    } }]]) as any;
    const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') });
    let attempt = 1;
    const context = vi.spyOn(Context, 'current').mockImplementation(() => ({
      cancellationSignal: new AbortController().signal, heartbeat() {},
      info: { attempt, activityId: '1', workflowExecution: { workflowId: 'tools-task', runId: 'run' },
        currentAttemptScheduledTimestampMs: Date.now() },
    } as any));
    const turn = () => core.runAgentTurn({
      taskId: 'tools-task', role: 'do', agentTurnId: 'tools-task#0', worldHandle: world.handle,
      messages: [{ id: 'm0', role: 'user', text: 'check the site', ts: 0 }],
      task: { projectId: 'project', title: 'Tools', prompt: 'check the site', project: {}, workflow: 'software-dev' },
    } as any);
    try {
      await expect(turn()).rejects.toMatchObject({ type: 'agent-infra', nonRetryable: false,
        message: "The agent's tools didn't start: chrome-devtools (failed)" });
      attempt = 2;
      await turn();
      expect(optional).toEqual([undefined, true]);
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

describe('a world that fails to open', () => {
  // pramana#59 (2026-10-16): Hetzner failed the parked server's power-on with
  // "Unknown Error" (a second later the same request worked), and the turn
  // blocked the task as a non-retryable agent error.
  it('waits it out as infrastructure, never as the agent\'s error', async () => {
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    const handle = { kind: 'fake-remote', id: 'wake-task', root: '/workspace', branch: 'tavya/wake-task', base: 'main' };
    worlds.register({ kind: 'fake-remote', capabilities: { remote: true }, async create() { throw new Error('unused'); },
      async open() { throw new Error('Hetzner\'s start_server 661871646694797 failed: Unknown Error (unknown_error)'); },
      async destroy() {} } as any);
    const adapters = new Map([['mock', { provider: 'mock', async runTurn() { throw new Error('the agent never starts'); } }]]) as any;
    const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') });
    try {
      const error = await core.runAgentTurn({
        taskId: 'wake-task', role: 'do', worldHandle: handle,
        messages: [{ id: 'm0', role: 'user', text: 'go on', ts: 0 }],
        task: { projectId: 'project', title: 'Wake', prompt: 'go on', project: {}, workflow: 'software-dev' },
      } as any).then(() => undefined, (caught) => caught);
      expect(error).toMatchObject({ type: 'world-infra', nonRetryable: false, message: expect.stringMatching(/Unknown Error/) });
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      (await store.close());
    }
  });
});
