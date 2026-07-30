import { IdentityService } from '../../src/auth/identity.js';

/** A mailer whose provider refuses the message, exactly as Resend does for an
 *  unverified sending domain. */
const rejecting = () => ({
  configured: () => true,
  send: async () => {
    throw new Error('Resend rejected the message (403): The krmax.io domain is not verified');
  },
});

const resend = (svc: IdentityService, email: string) =>
  svc.auth.handler(new Request('http://localhost:4711/api/auth/send-verification-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, callbackURL: '/?verified=1' }),
  }));

// A rejecting provider must not stop an account being created — otherwise a
// misconfigured mailer locks everyone out of a fresh instance.
const broken = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4711' });
(broken as unknown as { mailer: unknown }).mailer = rejecting();
let signupSucceeded = false;
try {
  await broken.bootstrap({ name: 'Admin', email: 'admin@example.com', password: 'long-enough-password' });
  signupSucceeded = true;
} catch { signupSucceeded = false; }
const accountsAfterFailedSend = broken.listUsers().length;

// …but an explicit resend must report the failure rather than answer 200 and
// leave someone waiting on an email that was never accepted.
const rejectedStatus = (await resend(broken, 'admin@example.com')).status;

// A working provider still succeeds, and actually hands the mailer a link.
const sent: string[] = [];
const healthy = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4711' });
(healthy as unknown as { mailer: unknown }).mailer = {
  configured: () => true,
  send: async (m: { text: string }) => { sent.push(String(m.text).match(/https?:\/\/\S+/)?.[0] ?? ''); },
};
await healthy.bootstrap({ name: 'Admin', email: 'admin@example.com', password: 'long-enough-password' });
const okStatus = (await resend(healthy, 'admin@example.com')).status;

// With no outbound email configured at all the endpoint stays successful: there
// is nothing to report, and this is the zero-config local default.
const unconfigured = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4711' });
(unconfigured as unknown as { mailer: unknown }).mailer = { configured: () => false, send: async () => {} };
await unconfigured.bootstrap({ name: 'Admin', email: 'admin@example.com', password: 'long-enough-password' });
const unconfiguredStatus = (await resend(unconfigured, 'admin@example.com')).status;

console.log(JSON.stringify({
  signupSucceeded,
  accountsAfterFailedSend,
  rejectedIsError: rejectedStatus >= 400,
  okStatus,
  unconfiguredStatus,
  verificationLinkAbsolute: sent.every((u) => u.startsWith('http://localhost:4711/api/auth/verify-email?')),
  emailsSent: sent.length,
}));
