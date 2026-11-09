import { describe, expect, it } from 'vitest';
import { GITHUB_WATCH_MAX_MS, githubWatchDelayMs } from '../src/domain/github-polling.js';

describe('githubWatchDelayMs', () => {
  it('doubles from the poll interval while nothing changes, up to ten minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((unchanged) => githubWatchDelayMs(30_000, unchanged, 0)))
      .toEqual([30_000, 60_000, 120_000, 240_000, 480_000, GITHUB_WATCH_MAX_MS, GITHUB_WATCH_MAX_MS]);
    expect(githubWatchDelayMs(30_000, 10_000, 0)).toBe(GITHUB_WATCH_MAX_MS);
  });

  it('waits for the hourly reset once less than a fifth of the budget is left', () => {
    const now = 1_000_000;
    const resetAt = now + 25 * 60_000;
    expect(githubWatchDelayMs(30_000, 0, now, { limit: 5000, remaining: 999, resetAt })).toBe(25 * 60_000 + 1_000);
    expect(githubWatchDelayMs(30_000, 0, now, { limit: 5000, remaining: 1000, resetAt })).toBe(30_000);
    // A reset already past, or one GitHub put implausibly far away, is not waited out.
    expect(githubWatchDelayMs(30_000, 0, now, { limit: 5000, remaining: 0, resetAt: now - 1 })).toBe(30_000);
    expect(githubWatchDelayMs(30_000, 0, now, { limit: 5000, remaining: 0, resetAt: now + 5 * 3_600_000 })).toBe(3_600_000);
  });
});
