import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('confirmation email delivery reports its own failures', () => {
  it('creates the account anyway, but fails an explicit resend the provider refused', () => {
    // Same reason as tests/identity.test.ts: Better Auth dynamically loads Node's
    // built-in SQLite adapter, which Vite rewrites to an optional `sqlite` import.
    const raw = execFileSync(process.execPath,
      ['--import', 'tsx', path.join(process.cwd(), 'tests/fixtures/identity-email.ts')],
      { encoding: 'utf8' });
    expect(JSON.parse(raw.trim().split('\n').at(-1)!)).toEqual({
      // A provider that refuses every message must not block account creation —
      // otherwise a misconfigured mailer locks everyone out of a new instance.
      signupSucceeded: true,
      accountsAfterFailedSend: 1,
      // The bug this covers: the send error was swallowed, so "Resend link"
      // answered 200 and the console said "check your inbox" while Resend had
      // refused the message for an unverified domain. Only the container log
      // knew. An explicit resend now fails loudly.
      rejectedIsError: true,
      // A healthy provider is unaffected…
      okStatus: 200,
      // …and with no outbound email configured there is nothing to report, which
      // is the zero-config local default rather than an error.
      unconfiguredStatus: 200,
      // The emailed link is absolute and points at this instance, not a relative
      // path or a stringified config object.
      verificationLinkAbsolute: true,
      // sign-up sends one, the explicit resend sends the second.
      emailsSent: 2,
    });
  }, 60_000);
});
