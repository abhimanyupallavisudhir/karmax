import { describe, expect, it } from 'vitest';
import { activityTaskConcurrency } from '../src/temporal/worker.js';

describe('worker activity capacity', () => {
  it('does not put the private worker default on top of hosted plan concurrency', () => {
    expect(activityTaskConcurrency({} as NodeJS.ProcessEnv)).toBe(8);
    expect(activityTaskConcurrency({ KARMAX_DEPLOYMENT: 'hosted' } as NodeJS.ProcessEnv)).toBe(1_000);
    expect(activityTaskConcurrency({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_MAX_ACT: '64' } as NodeJS.ProcessEnv)).toBe(64);
  });
});
