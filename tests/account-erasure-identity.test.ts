import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

it('fences real Better Auth cookies and new sessions, then removes identity idempotently', () => {
  const result = execFileSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/account-erasure-identity.ts'], { encoding: 'utf8' });
  expect(result).toContain('account-erasure-identity:ok');
});
