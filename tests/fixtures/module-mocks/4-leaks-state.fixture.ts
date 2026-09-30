import { expect, it, vi } from 'vitest';

// Leaves every kind of process-wide state behind on purpose.
it('changes the environment and a global without restoring them', () => {
  process.env.KARMAX_FIXTURE_ASSIGNED = 'left behind';
  vi.stubEnv('KARMAX_FIXTURE_STUBBED', 'left behind');
  vi.stubGlobal('karmaxFixtureGlobal', 'left behind');
  expect(process.env.KARMAX_FIXTURE_STUBBED).toBe('left behind');
});
