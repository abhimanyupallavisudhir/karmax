import type { WorldDiagnosis } from './types.js';

/** One provider metrics sample (E2B reports these every few seconds). */
export interface MemorySample { at: number; memUsed: number; memTotal: number }

/** A sandbox this full leaves no page cache for program text: Linux thrashes
 * instead of OOM-killing, and the provider daemon stops answering. */
const EXHAUSTED = 0.95;
/** Samples arrive every 5–30 s, so a longer silence means the sandbox stalled. */
const SILENT_MS = 60_000;
/** Only a spike this close to the latest sample can explain the failure. */
const RECENT_MS = 5 * 60_000;

/**
 * Explain a turn failure from the sandbox's own resource metrics, which the
 * provider's control plane still serves when the sandbox itself is frozen.
 * Returns undefined unless the metrics show the sandbox was the problem, so a
 * healthy sandbox never masks a real agent error.
 */
export function diagnoseMetrics(samples: MemorySample[], { since, now }: { since: number; now: number }): WorldDiagnosis | undefined {
  const ordered = samples.filter(s => s.memTotal > 0).sort((a, b) => a.at - b.at);
  const last = ordered.at(-1);
  if (!last) return undefined;
  const peak = ordered.filter(s => s.at >= last.at - RECENT_MS)
    .reduce((top, s) => (s.memUsed / s.memTotal > top.memUsed / top.memTotal ? s : top));
  const memoryExhausted = peak.memUsed / peak.memTotal >= EXHAUSTED;
  // A resumed sandbox has no samples from its pause, and metrics lag a little.
  const silent = now - Math.max(last.at, since) > SILENT_MS;
  if (!memoryExhausted && !silent) return undefined;
  const memory = `memory reached ${Math.round(peak.memUsed / 2 ** 20)} of ${Math.round(peak.memTotal / 2 ** 20)} MB `
    + `(${Math.round((peak.memUsed / peak.memTotal) * 100)}%) at ${clock(peak.at)}`;
  const stalled = `stopped responding (no metrics since ${clock(last.at)})`;
  const summary = memoryExhausted && silent ? `sandbox ${memory}, then it ${stalled}`
    : memoryExhausted ? `sandbox ${memory}` : `sandbox ${stalled}`;
  return { summary, memoryExhausted };
}

const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
