// The `KARMAX_PASSWORD` deployment mode ("require login", CLAUDE.md) had no test
// at all: the harness has supported `startGateway({ password })` all along and no
// suite ever passed it, so every assertion about auth ran against the
// passwordless branch. A refactor that made /api/session mint a token even when a
// password is configured would have turned every password-protected install into
// an open one, silently. This pins the branch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';

describe('gateway with KARMAX_PASSWORD set (login required)', () => {
  let h: Harness;
  let base: string;
  const PASSWORD = 'correct-horse-battery-staple';

  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway({ password: PASSWORD });
    base = gw.url;
  }, 60_000);
  afterAll(async () => { await h?.stop(); });

  const login = (password: string) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  it('advertises that auth is required and hands out no token', async () => {
    const session: any = await (await fetch(`${base}/api/session`)).json();
    expect(session.authRequired).toBe(true);
    // The load-bearing assertion: no token may leak from the unauthenticated
    // session probe. This is the whole point of the mode.
    expect(session.token).toBeUndefined();
  });

  it('rejects API calls without a token', async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong password and a missing one', async () => {
    expect((await login('hunter2')).status).toBe(401);
    expect((await login('')).status).toBe(401);
    // A near-miss must not be accepted by a prefix/loose comparison.
    expect((await login(PASSWORD.slice(0, -1))).status).toBe(401);
    expect((await login(`${PASSWORD}x`)).status).toBe(401);
  });

  it('accepts the right password and issues a token that works', async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.token).toBeTruthy();

    const projects = await fetch(`${base}/api/projects`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(projects.status).toBe(200);
  });

  it('still rejects a bogus bearer token', async () => {
    const res = await fetch(`${base}/api/projects`, { headers: { authorization: 'Bearer not-a-session' } });
    expect(res.status).toBe(401);
  });
});
