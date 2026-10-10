import { expect, it } from 'vitest';

// Replaces the process.env object itself, as `process.env = { ...saved }` does.
it('replaces process.env with a copy', () => {
  process.env = { ...process.env, KARMAX_FIXTURE_REPLACED: 'left behind' };
  expect(process.env.KARMAX_FIXTURE_REPLACED).toBe('left behind');
});
