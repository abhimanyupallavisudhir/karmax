/**
 * Sizes the sticky workflow cache to the workflow thread's heap (RT-35).
 *
 * Every cached workflow lives in the worker's workflow thread, a V8 isolate
 * with its own heap limit; reaching it aborts the whole process and every
 * tenant's work with it. The SDK cannot resize or evict its cache in place,
 * but a worker that stops polling evicts all of it, so `WorkerManager` rolls
 * to a new worker with the limit this decides. An evicted workflow costs a
 * history replay the next time it is touched: slower, never lost.
 */
export interface GovernorConfig {
  /** The configured cache size the governor grows back to. */
  configured: number;
  floor: number;
  /** Heap used/limit at or above which a sample counts as pressure. */
  high: number;
  /** Below this the heap counts as calm. */
  low: number;
  samplesToShrink: number;
  checkMs: number;
  cooldownMs: number;
  calmToGrowMs: number;
}

export interface GovernorState {
  limit: number;
  highStreak: number;
  lastChangeAt: number;
  calmSince?: number;
}

export interface HeapSample { ratio: number; cached: number; now: number }

export function governorConfig(env: NodeJS.ProcessEnv, configured: number): GovernorConfig {
  const fraction = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!(value > 0 && value < 1)) throw new Error(`${name} must be a fraction between 0 and 1`);
    return value;
  };
  const checkRaw = env.KARMAX_HEAP_CHECK_MS?.trim();
  const checkMs = checkRaw ? Number(checkRaw) : 15_000;
  if (!Number.isSafeInteger(checkMs) || checkMs <= 0) throw new Error('KARMAX_HEAP_CHECK_MS must be a positive number of milliseconds');
  return { configured, floor: Math.min(10, configured), high: fraction('KARMAX_HEAP_HIGH_WATERMARK', 0.8), low: 0.5,
    samplesToShrink: 2, checkMs, cooldownMs: 8 * checkMs, calmToGrowMs: 120 * checkMs };
}

export function governWorkflowCache(state: GovernorState, sample: HeapSample, config: GovernorConfig): GovernorState {
  if (sample.ratio >= config.high) {
    const highStreak = state.highStreak + 1;
    if (highStreak < config.samplesToShrink || state.limit <= config.floor
      || sample.now - state.lastChangeAt < config.cooldownMs) return { ...state, highStreak, calmSince: undefined };
    // Half of what is cached: if the cache is not full, halving the limit
    // alone would leave the same workflows to be cached again.
    const limit = Math.max(config.floor, Math.floor(Math.min(state.limit, sample.cached) / 2));
    return { limit, highStreak: 0, lastChangeAt: sample.now };
  }
  if (sample.ratio >= config.low) return { ...state, highStreak: 0, calmSince: undefined };
  const calmSince = state.calmSince ?? sample.now;
  if (state.limit < config.configured && sample.now - calmSince >= config.calmToGrowMs
    && sample.now - state.lastChangeAt >= config.calmToGrowMs)
    return { limit: Math.min(config.configured, state.limit * 2), highStreak: 0, lastChangeAt: sample.now, calmSince: sample.now };
  return { ...state, highStreak: 0, calmSince };
}
