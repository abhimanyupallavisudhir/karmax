import { beforeEach, expect, it, vi } from 'vitest';

const wf = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  activities: {} as Record<string, any>,
  wait: undefined as undefined | (() => void),
  patches: true,
}));
vi.mock('@temporalio/workflow', async (importOriginal) => ({
  ...await importOriginal<typeof import('@temporalio/workflow')>(),
  proxyActivities: () => new Proxy({}, { get: (_target, name: string) => wf.activities[name] ?? vi.fn(async () => undefined) }),
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  defineUpdate: (name: string) => name,
  setHandler: (name: string, fn: (...args: any[]) => any) => wf.handlers.set(name, fn),
  workflowInfo: () => ({ runId: 'run', historyLength: 1 }),
  patched: () => wf.patches,
  isCancellation: () => false,
  log: { warn: vi.fn() },
  condition: async (predicate: () => boolean) => {
    if (!predicate()) wf.wait?.();
    if (!predicate()) throw new Error('test: unexpected wait');
    return true;
  },
  CancellationScope: class { async run(fn: () => any) { return fn(); } cancel() {} },
}));
import { justDoV1_7 } from '../src/workflows/just-do.js';
import { mergeOnlyV1_7 } from '../src/workflows/merge-only.js';
import { createAgentTurnLeaser } from '../src/workflows/agent-turn-lease.js';

const input = { taskId: 'task', projectId: 'project', title: 'T', prompt: 'work',
  project: { repos: [] }, confirm: { layers: [] } } as any;
beforeEach(() => {
  wf.handlers.clear(); wf.wait = undefined; wf.patches = true;
  wf.activities = {
    createWorld: vi.fn(async () => ({ id: 'task', kind: 'worktree', root: '/tmp/test', branch: 'b', base: 'main' })),
    publishView: vi.fn(async () => undefined),
    accountPoolSize: vi.fn(async () => 1),
    resolveProvider: vi.fn(async () => 'mock'),
    leaseAccount: vi.fn(async (_task, turnId) => {
      wf.handlers.get('accountGranted')!({ turnId, accountId: '(denied)' });
      return { waiting: false };
    }),
    runAgentTurn: vi.fn(async () => ({})),
    commitWork: vi.fn(async () => ({ committed: true })),
  };
});

it('WF-9: denied credentials park just-do visibly and cancellation completes', async () => {
  wf.wait = () => {
    const view = wf.handlers.get('view')!();
    expect(view.status).toBe('waiting');
    expect(view.waitingFor?.detail).toContain('credential');
    wf.handlers.get('cancel')!();
  };
  expect(await justDoV1_7(input)).toEqual({ stage: 'cancelled' });
  expect(wf.activities.runAgentTurn).not.toHaveBeenCalled();
});

