import { describe, expect, it } from 'vitest';
import { memoryBudget } from '../src/runtime/memory-budget.js';
import { activityTaskConcurrency, workflowCacheSize, workflowTaskConcurrency } from '../src/temporal/worker.js';

const MiB = 1024 * 1024;
const fourGiB = () => memoryBudget({ limitBytes: 4096 * MiB, separateWorker: true });

describe('worker activity capacity', () => {
  it('does not put the private worker default on top of hosted plan concurrency', () => {
    expect(activityTaskConcurrency({} as NodeJS.ProcessEnv)).toBe(8);
    expect(activityTaskConcurrency({ KARMAX_DEPLOYMENT: 'hosted' } as NodeJS.ProcessEnv)).toBe(1_000);
    expect(activityTaskConcurrency({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_MAX_ACT: '64' } as NodeJS.ProcessEnv)).toBe(64);
  });

  // WF-28 / LT-13: every open task's workflow is queried by the console and by
  // its running turn; past the cache, each of those is a full history replay.
  it('caches enough workflows for a hosted cell', () => {
    expect(workflowCacheSize({} as NodeJS.ProcessEnv)).toBe(20);
    // 250 in the turnkey stack's default 4 GiB app container; it scales with
    // the workflow heap (memory-budget.test.ts), never below the governor's floor.
    expect(workflowCacheSize({ KARMAX_DEPLOYMENT: 'hosted' } as NodeJS.ProcessEnv, fourGiB)).toBe(250);
    expect(workflowCacheSize({ KARMAX_DEPLOYMENT: 'hosted' } as NodeJS.ProcessEnv,
      () => memoryBudget({ limitBytes: 256 * MiB, separateWorker: true }))).toBe(39);
    expect(workflowCacheSize({ KARMAX_DEPLOYMENT: 'hosted' } as NodeJS.ProcessEnv,
      () => ({ limitMb: 64, gatewayHeapMb: 10, workerHeapMb: 20 }))).toBe(10);
    expect(workflowCacheSize({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_MAX_CACHED_WORKFLOWS: '40' } as NodeJS.ProcessEnv)).toBe(40);
  });

  // Load test 2026-10: at 128 tenants workflow tasks queued behind 8 slots on a
  // 4-vCPU host. Slots overlap waits on Temporal, so hosted scales them with the
  // host's cores, from 8 to at most 16 (all share one workflow thread).
  it('scales hosted workflow-task slots with cores, between 8 and 16', () => {
    const hosted = { KARMAX_DEPLOYMENT: 'hosted' } as NodeJS.ProcessEnv;
    expect([1, 2, 4, 6, 8, 16, 64].map(cores => workflowTaskConcurrency(hosted, cores))).toEqual([8, 8, 8, 12, 16, 16, 16]);
    expect(workflowTaskConcurrency({} as NodeJS.ProcessEnv, 64)).toBe(8);
    expect(workflowTaskConcurrency({ ...hosted, KARMAX_MAX_WFT: '24' }, 8)).toBe(24);
    expect(workflowTaskConcurrency(hosted)).toBeGreaterThanOrEqual(8);
  });
});
