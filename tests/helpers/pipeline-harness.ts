import { bootHarness, type Harness } from './harness.js';
import { MockAdapter } from '../../src/agent/mock.js';
import type { AgentAdapter } from '../../src/agent/types.js';

// The software-dev pipeline suites (tests/pipeline*.test.ts) share this setup:
// real Temporal and git, and a mock agent with hooks that let a test hold or
// interrupt a turn. They were one file whose ~6.5 minutes no CI shard could
// beat; each file now boots its own harness.

export function input(over: { taskId: string; projectId?: string; repo: string; prompt: string; title?: string; subtaskNagMs?: number; subagentWaitMs?: number; recovery?: any; resolveAgentEnabled?: boolean }) {
  return {
    taskId: over.taskId,
    projectId: over.projectId ?? 'p1',
    title: over.title ?? 'Task',
    prompt: over.prompt,
    base: 'main',
    target: 'main',
    project: { repos: [over.repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
    ...(over.subtaskNagMs !== undefined ? { subtaskNagMs: over.subtaskNagMs } : {}),
    ...(over.subagentWaitMs !== undefined ? { subagentWaitMs: over.subagentWaitMs } : {}),
    ...(over.resolveAgentEnabled !== undefined ? { resolveAgentEnabled: over.resolveAgentEnabled } : {}),
    ...(over.recovery ? { recovery: over.recovery } : {}),
  };
}
export const view = (h: any) => h.query('view') as Promise<any>;

/** What the agent below shares with the tests that drive its hooks. */
export interface PipelineGates {
  cancellationCleanupFinishedAt: number;
  releaseAttemptMerge?: () => void;
  attemptMergeGate?: Promise<void>;
  gatedAttemptIds: Set<string>;
  releaseResourceCandidateTurn?: () => void;
  resourceCandidateTurnReleased: boolean;
}

export function pipelineGates(): PipelineGates {
  return { cancellationCleanupFinishedAt: 0, gatedAttemptIds: new Set(), resourceCandidateTurnReleased: false };
}

export async function bootPipelineHarness(gates: PipelineGates): Promise<Harness> {
  const mock = new MockAdapter();
  const restartSession = 'restart-regression-session';
  // Model the real Claude/Codex shutdown behaviour: provider cleanup consumes the
  // AbortError and returns partial output. The runtime boundary must still reject
  // that result so Temporal retries the activity after the worker comes back.
  const adapter: AgentAdapter = {
    provider: 'mock',
    async runTurn(input, ctx) {
      if (input.role === 'merge' && gates.gatedAttemptIds.has(input.world.handle.id)) await gates.attemptMergeGate;
      const latestUser = input.messages.filter((message) => message.role === 'user').at(-1);
      if (!gates.resourceCandidateTurnReleased
        && latestUser?.text.includes('@resource-candidate-regression')) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            gates.releaseResourceCandidateTurn = undefined;
            reject(new Error('aborted'));
          };
          gates.releaseResourceCandidateTurn = () => {
            ctx.signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          if (ctx.signal?.aborted) onAbort();
          else ctx.signal?.addEventListener('abort', onAbort, { once: true });
        });
        return mock.runTurn(input, ctx);
      }
      if (input.messages.some((m) => m.text.includes('@cancel-cleanup-regression'))) {
        const pulse = setInterval(() => {
          try { ctx.heartbeat?.(); } catch { /* cancellation is delivered through the signal */ }
        }, 50);
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) return resolve();
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        clearInterval(pulse);
        // Model provider cleanup/reaping that continues after it observes abort.
        await new Promise((resolve) => setTimeout(resolve, 300));
        gates.cancellationCleanupFinishedAt = Date.now();
        return { termination: { kind: 'success', status: 'mock.completed' }, output: 'cancelled partial output' };
      }
      const restartCase = input.session === restartSession || input.messages.some((m) => m.text.includes('@restart-regression'));
      if (!restartCase) return mock.runTurn(input, ctx);
      if (input.session === restartSession) {
        ctx.signalCompletion('resumed after restart');
        return { termination: { kind: 'success', status: 'mock.completed' }, session: restartSession, output: 'resumed and completed' };
      }
      ctx.onSession?.(restartSession);
      ctx.heartbeat?.();
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) return resolve();
        ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { termination: { kind: 'success', status: 'mock.completed' }, session: restartSession, output: 'partial output from interrupted turn' };
    },
  };
  return bootHarness('mock', adapter);
}

/** Release every held turn so the harness can stop. */
export async function stopPipelineHarness(h: Harness | undefined, gates: PipelineGates): Promise<void> {
  gates.releaseAttemptMerge?.();
  gates.releaseResourceCandidateTurn?.();
  gates.releaseResourceCandidateTurn = undefined;
  await h?.stop();
}
