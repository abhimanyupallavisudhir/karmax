import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('Better Auth identity boundary', () => {
  it('bootstraps one administrator, persists secure sessions, and creates multiple users', async () => {
    // Better Auth dynamically loads Node's built-in SQLite adapter. Run this one
    // boundary test natively (the same `tsx` path production uses), rather than
    // through Vite 5 which rewrites that protocol import to optional `sqlite`.
    const raw = execFileSync(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'tests/fixtures/identity-smoke.ts')], { encoding: 'utf8' });
    expect(JSON.parse(raw.trim())).toEqual({
      firstRole: 'admin',
      sessionEmail: 'admin@example.com',
      users: 2,
      bootstrapBlocked: true,
      setupRequired: true,
      visibleProjects: ['Allowed'],
      usersDenied: 403,
      signupEntersApp: true,
      signupHasPersonalWorkspace: true,
      signupDashboardOk: true,
      signupAccountVisible: true,
      loggedOut: true,
    });
  });
});
