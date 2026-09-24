import { describe, expect, it } from 'vitest';
import { diagnoseMetrics } from '../src/world/health.js';

const at = (time: string) => Date.parse(`2026-09-24T${time}Z`);
const mb = 2 ** 20;
const sample = (time: string, used: number, total = 1983) => ({ at: at(time), memUsed: used * mb, memTotal: total * mb });

describe('sandbox health from provider metrics', () => {
  it('attributes a turn failure to memory exhaustion just before it (task 348)', () => {
    const samples = [sample('04:55:00', 796), sample('04:55:30', 1604), sample('04:56:00', 1961)];
    expect(diagnoseMetrics(samples, { since: at('04:50:43'), now: at('04:56:50') })).toEqual({
      summary: 'sandbox memory reached 1961 of 1983 MB (99%) at 04:56:00 UTC',
      memoryExhausted: true,
    });
  });

  it('recognizes a sandbox frozen after memory exhaustion (task 349)', () => {
    const samples = [sample('05:01:55', 1689), sample('05:02:10', 1933), sample('05:03:00', 1967)];
    expect(diagnoseMetrics(samples, { since: at('05:18:43'), now: at('05:21:35') })).toEqual({
      summary: 'sandbox memory reached 1967 of 1983 MB (99%) at 05:03:00 UTC, then it stopped responding (no metrics since 05:03:00 UTC)',
      memoryExhausted: true,
    });
  });

  it('reports an unresponsive sandbox even when its last memory reading was normal', () => {
    expect(diagnoseMetrics([sample('05:10:00', 900)], { since: at('05:09:00'), now: at('05:14:00') })).toEqual({
      summary: 'sandbox stopped responding (no metrics since 05:10:00 UTC)',
      memoryExhausted: false,
    });
  });

  it('stays silent for healthy, just-resumed, or unmeasured sandboxes', () => {
    expect(diagnoseMetrics([sample('04:56:30', 900)], { since: at('04:50:00'), now: at('04:56:50') })).toBeUndefined();
    // Metrics lag a resume: an old sample from before the pause is not a freeze.
    expect(diagnoseMetrics([sample('01:00:00', 900)], { since: at('04:56:20'), now: at('04:56:50') })).toBeUndefined();
    expect(diagnoseMetrics([], { since: at('04:50:00'), now: at('04:56:50') })).toBeUndefined();
  });

  it('does not blame a memory spike that ended well before the failure', () => {
    const samples = [sample('04:39:00', 1959), sample('04:40:30', 773), sample('04:50:00', 780), sample('04:56:30', 790)];
    expect(diagnoseMetrics(samples, { since: at('04:36:38'), now: at('04:56:50') })).toBeUndefined();
  });
});
