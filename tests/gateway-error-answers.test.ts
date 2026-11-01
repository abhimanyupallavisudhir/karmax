import { afterAll, describe, expect, it } from 'vitest';
import { IdentityService } from '../src/auth/identity.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { Gateway } from '../src/gateway/server.js';
import { errorStatus } from '../src/gateway/error-status.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { CapabilityError, NotFoundError, ValidationError } from '../src/platform/errors.js';
import { GithubApiError } from '../src/integrations/github-pr.js';
import { WebhookAuthError } from '../src/platform/api.js';
import { IdentityRequirementError } from '../src/platform/identity.js';

const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of closers) await close().catch(() => {}); });

describe('the status an error is answered with', () => {
  it('keeps a platform error’s own, and never passes on another service’s sign-out', () => {
    expect(errorStatus(new CapabilityError('denied: task:create'), 500)).toBe(403);
    expect(errorStatus(new NotFoundError('no task'), 500)).toBe(404);
    expect(errorStatus(new ValidationError('bad'), 500)).toBe(400);
    // GitHub refusing tavya's token is GitHub failing this request, not the
    // person being signed out of tavya (the console signs out on a 401).
    expect(errorStatus(new GithubApiError(401, 'GitHub API 401: Bad credentials'), 500)).toBe(502);
    expect(errorStatus(new GithubApiError(404, 'GitHub API 404: Not Found'), 500)).toBe(404);
    // tavya's own 401s stay: a webhook without a valid signature, a route that needs a person signed in.
    expect(errorStatus(new WebhookAuthError(), 500)).toBe(401);
    expect(errorStatus(new IdentityRequirementError('interactive-human'), 500)).toBe(401);
    expect(errorStatus(new URIError('URI malformed'), 500)).toBe(400);
    expect(errorStatus(new Error('boom'), 500)).toBe(500);
    expect(errorStatus(Object.assign(new Error('odd'), { status: 200 }), 409)).toBe(409);
  });
});

describe('a request the gateway cannot use is the caller’s mistake (4xx), said plainly', () => {
  it('answers a malformed address and a body that is not an object with 400', async () => {
    const port = await findFreePortFrom(48370);
    const identity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}` });
    const store = await Store.create(':memory:');
    const gateway = await Gateway.create({
      api: {} as any, store, bus: new KarmaxBus(), tokens: new TokenAuthority(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), client: {} as any, taskQueue: 'test', staticDir: process.cwd(),
      agentInfo: { provider: 'mock', reason: 'error answers test' }, identity,
      authorization: await AuthorizationService.create(store), worlds: new WorldRegistry(),
    });
    const running = await gateway.listen(port);
    closers.push(() => running.close());
    const setup = await fetch(`${running.url}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', password: 'long-enough-password' }) });
    const cookie = setup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
    const call = (method: string, path: string, body?: string) => fetch(`${running.url}${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, ...(body !== undefined ? { body } : {}) });

    const malformed = await call('GET', '/api/templates/%E0%A4%A');
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: string }).error).toMatch(/malformed address/);

    for (const body of ['null', '[1]', '"text"']) {
      const answer = await call('PATCH', '/api/user/preferences', body);
      expect(answer.status).toBe(400);
      expect(await answer.json()).toEqual({ error: 'the request body must be a JSON object' });
    }
    // The ordinary case still works.
    expect((await call('PATCH', '/api/user/preferences', JSON.stringify({ dismiss: ['x'] }))).status).toBe(200);
  });
});
