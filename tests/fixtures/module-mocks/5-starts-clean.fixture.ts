import { expect, it, vi } from 'vitest';

it('inherits no environment or global from the file before it', () => {
  expect(process.env.KARMAX_FIXTURE_ASSIGNED).toBeUndefined();
  expect(process.env.KARMAX_FIXTURE_STUBBED).toBeUndefined();
  expect((globalThis as any).karmaxFixtureGlobal).toBeUndefined();
});

it('can still stub and unstub environment variables after a file replaced process.env', () => {
  expect(process.env.KARMAX_FIXTURE_REPLACED).toBeUndefined();
  vi.stubEnv('KARMAX_FIXTURE_LIMIT', '1');
  expect(process.env.KARMAX_FIXTURE_LIMIT).toBe('1');
  vi.unstubAllEnvs();
  expect(process.env.KARMAX_FIXTURE_LIMIT).toBeUndefined();
});
