import { expect, it } from 'vitest';

it('inherits no environment or global from the file before it', () => {
  expect(process.env.KARMAX_FIXTURE_ASSIGNED).toBeUndefined();
  expect(process.env.KARMAX_FIXTURE_STUBBED).toBeUndefined();
  expect((globalThis as any).karmaxFixtureGlobal).toBeUndefined();
});
