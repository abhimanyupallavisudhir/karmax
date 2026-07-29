import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('Better Auth identity hardening', () => {
  it('throttles credential endpoints, promotes the account it created, and keeps its signing secret', () => {
    // Same reason as tests/identity.test.ts: Better Auth dynamically loads Node's
    // built-in SQLite adapter, which Vite rewrites to an optional `sqlite` import.
    const raw = execFileSync(process.execPath,
      ['--import', 'tsx', path.join(process.cwd(), 'tests/fixtures/identity-hardening.ts')], { encoding: 'utf8' });
    expect(JSON.parse(raw.trim().split('\n').at(-1)!)).toEqual({
      // Better Auth defaults rateLimit to `isProduction`; karmax never sets
      // NODE_ENV=production, so sign-in/reset/verification were unthrottled in
      // every deployment until this was passed explicitly.
      rateLimitEnabled: true,
      // Each racing bootstrap gets back the account IT created, not `listUsers()[0]`.
      bootstrapClaims: ['first@example.com', 'second@example.com'],
      // …and every response that claimed administrator names a real administrator.
      claimsHonest: true,
      // Reopening reuses the persisted secret rather than minting a new one.
      secretStable: true,
      // A non-ENOENT read failure surfaces instead of masquerading as first boot…
      unreadableThrew: true,
      // …and does not overwrite whatever is actually there.
      secretNotClobbered: true,
    });
  }, 60_000);
});
