import { describe, expect, it } from 'vitest';
import { activityTaskConcurrency, workflowCacheSize } from '../src/temporal/worker.js';

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
    expect(workflowCacheSize({ KARMAX_DEPLOYMENT: 'hosted' } as NodeJS.ProcessEnv)).toBe(250);
    expect(workflowCacheSize({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_MAX_CACHED_WORKFLOWS: '40' } as NodeJS.ProcessEnv)).toBe(40);
  });
});
