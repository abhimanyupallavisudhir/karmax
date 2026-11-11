import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { choosePromotion, PRODUCTION, STAGING } from '../scripts/promote.mjs';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const image = (n: number) => `ghcr.io/owner/karmax-app@sha256:${String(n).repeat(64).slice(0, 64)}`;
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
type Status = { state: string; createdAt: string; description: string };
const commit = (n: number, statuses: Record<string, Status> = {}) => ({ sha: sha(n), statuses });
const staged = (n: number, minutes: number, state = 'success') =>
  ({ [STAGING]: { state, createdAt: minutesAgo(minutes), description: state === 'success' ? image(n) : 'smoke failed' } });
const live = (minutes: number) => ({ [PRODUCTION]: { state: 'success', createdAt: minutesAgo(minutes), description: image(1) } });

describe('promotion', () => {
  it('promotes the newest commit that passed staging an hour ago, with the image staging ran', () => {
    const commits = [commit(5, staged(5, 10)), commit(4, staged(4, 70)), commit(3, staged(3, 90)), commit(2),
      commit(1, { ...staged(1, 600), ...live(300) })];
    expect(choosePromotion({ commits, now: NOW })).toMatchObject({ sha: sha(4), image: image(4) });
  });

  it('waits out the soak, the interval and a pause', () => {
    const fresh = [commit(2, staged(2, 20)), commit(1, live(300))];
    expect(choosePromotion({ commits: fresh, now: NOW }).reason).toContain('passed staging less than 60 minutes ago');
    const recent = [commit(2, staged(2, 200)), commit(1, live(30))];
    expect(choosePromotion({ commits: recent, now: NOW })).toMatchObject({ sha: '' });
    expect(choosePromotion({ commits: recent, now: NOW }).reason).toContain('next promotion after 2026-11-10T15:30:00.000Z');
    const ready = [commit(2, staged(2, 200)), commit(1, live(300))];
    expect(choosePromotion({ commits: ready, now: NOW, paused: true }).reason).toContain('paused');
    expect(choosePromotion({ commits: ready, now: NOW, soakMinutes: 300 })).toMatchObject({ sha: '' });
    expect(choosePromotion({ commits: ready, now: NOW, intervalMinutes: 400 })).toMatchObject({ sha: '' });
  });

  it('never promotes what failed staging, what never reached it, or what production already has', () => {
    expect(choosePromotion({ commits: [commit(3, staged(3, 200, 'failure')), commit(2), commit(1, live(300))], now: NOW }))
      .toMatchObject({ sha: '', reason: expect.stringContaining('nothing newer than production') });
    // Older than production: production never moves backwards.
    expect(choosePromotion({ commits: [commit(2, live(300)), commit(1, staged(1, 900))], now: NOW })).toMatchObject({ sha: '' });
    // A success without a release image (a deploy that built on the host) is not promotable.
    const unnamed = { [STAGING]: { state: 'success', createdAt: minutesAgo(200), description: 'deployed' } };
    expect(choosePromotion({ commits: [commit(2, unnamed), commit(1, live(300))], now: NOW })).toMatchObject({ sha: '' });
  });

  it('promotes now on request, waiving soak, interval and pause but never staging', () => {
    const commits = [commit(3, staged(3, 5)), commit(2), commit(1, live(10))];
    expect(choosePromotion({ commits, now: NOW, immediate: true, paused: true })).toMatchObject({ sha: sha(3), image: image(3) });
    expect(choosePromotion({ commits, now: NOW, requested: sha(3), paused: true })).toMatchObject({ sha: sha(3) });
    expect(choosePromotion({ commits, now: NOW, requested: sha(2) }).reason).toContain('has not passed staging');
    expect(choosePromotion({ commits, now: NOW, requested: sha(9) }).reason).toContain('not among');
    expect(choosePromotion({ commits: [commit(2, live(10)), commit(1, staged(1, 900))], now: NOW, requested: sha(1) }).reason)
      .toContain('not newer than production');
  });

  it('starts from the recent history when production has no record yet', () => {
    expect(choosePromotion({ commits: [commit(2, staged(2, 200)), commit(1)], now: NOW })).toMatchObject({ sha: sha(2) });
  });
});
