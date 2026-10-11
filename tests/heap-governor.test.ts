import { describe, expect, it } from 'vitest';
import { governorConfig, governWorkflowCache, type GovernorState } from '../src/temporal/heap-governor.js';

const config = governorConfig({}, 250);
const start = (limit = 250): GovernorState => ({ limit, highStreak: 0, lastChangeAt: 0 });

describe('workflow cache heap governor (RT-35)', () => {
  it('halves the cache after sustained pressure on the workflow heap, not on one spike', () => {
    let state = governWorkflowCache(start(), { ratio: 0.9, cached: 240, now: 1_000_000 }, config);
    expect(state.limit).toBe(250);
    state = governWorkflowCache(state, { ratio: 0.5, cached: 240, now: 1_015_000 }, config);
    state = governWorkflowCache(state, { ratio: 0.9, cached: 240, now: 1_030_000 }, config);
    expect(state.limit).toBe(250); // the streak restarted
    state = governWorkflowCache(state, { ratio: 0.85, cached: 240, now: 1_045_000 }, config);
    expect(state).toMatchObject({ limit: 120, highStreak: 0, lastChangeAt: 1_045_000 });
  });

  it('halves what is actually cached, waits out a cooldown, and stops at a floor', () => {
    let state = start();
    const pressure = (now: number) => { state = governWorkflowCache(state, { ratio: 0.95, cached: 60, now }, config); };
    pressure(1_000_000); pressure(1_015_000);
    expect(state.limit).toBe(30); // half of the 60 cached, not of the 250 allowed
    pressure(1_030_000); pressure(1_045_000);
    expect(state.limit).toBe(30); // cooldown: the last shrink has not had time to take effect
    for (let t = 1_045_000 + config.cooldownMs; t < 1_045_000 + 20 * config.cooldownMs; t += 15_000) pressure(t);
    expect(state.limit).toBe(config.floor);
  });

  it('grows back toward the configured size only after a long calm', () => {
    let state: GovernorState = { limit: 30, highStreak: 0, lastChangeAt: 0 };
    let now = 10_000_000;
    state = governWorkflowCache(state, { ratio: 0.2, cached: 30, now }, config);
    expect(state.limit).toBe(30);
    now += config.calmToGrowMs - 1;
    state = governWorkflowCache(state, { ratio: 0.2, cached: 30, now }, config);
    expect(state.limit).toBe(30);
    // Moderate use interrupts the calm.
    state = governWorkflowCache(state, { ratio: 0.6, cached: 30, now: now + 1 }, config);
    state = governWorkflowCache(state, { ratio: 0.2, cached: 30, now: now + 2 }, config);
    state = governWorkflowCache(state, { ratio: 0.2, cached: 30, now: now + 2 + config.calmToGrowMs }, config);
    expect(state.limit).toBe(60);
    for (let i = 0; i < 10; i++)
      state = governWorkflowCache(state, { ratio: 0.2, cached: state.limit, now: now + (i + 3) * config.calmToGrowMs }, config);
    expect(state.limit).toBe(250);
  });

  it('reads its thresholds from the environment and rejects nonsense', () => {
    expect(governorConfig({ KARMAX_HEAP_HIGH_WATERMARK: '0.7', KARMAX_HEAP_CHECK_MS: '1000' }, 20))
      .toMatchObject({ high: 0.7, checkMs: 1000, floor: 10 });
    expect(governorConfig({}, 4).floor).toBe(4);
    expect(() => governorConfig({ KARMAX_HEAP_HIGH_WATERMARK: '1.5' }, 20)).toThrow('KARMAX_HEAP_HIGH_WATERMARK');
    expect(() => governorConfig({ KARMAX_HEAP_CHECK_MS: '0' }, 20)).toThrow('KARMAX_HEAP_CHECK_MS');
  });
});
