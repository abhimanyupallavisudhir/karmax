import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * The gateway half of the tag/view scope hole.
 *
 * `requestScope` derived a `projectId` only from `/api/projects/…`,
 * `/api/defaults/…`, `/api/settings/(quick/)?project/…`, a resolvable `taskId`,
 * or an explicit `?projectId=`. `/api/tags/:id` and `/api/views/:id` matched
 * none of them, so `TokenAuthority.check` was handed no project and its tenant
 * guard never fired — a `task:edit` token from any project of any organization
 * could rename or delete another tenant's tag or saved view, and
 * `describe_platform` advertises both routes.
 *
 * Boots a real Gateway + KarmaxApi with stub deps — no Temporal, no worker.
 */
describe('gateway request scope for bare-id routes', () => {
  let home: string;
  let store: Store;
  let base: string;
  let close: () => Promise<void>;
  let mine: string;
  let theirs: string;
  let token: string;
  /** What the stub GitHub webhook handler throws on the next delivery. */
  let webhookFailure: Error | undefined;

  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-scope-'));
    store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const acme = store.createOrganization({ name: 'Acme', ownerUserId: 'a' });
    const other = store.createOrganization({ name: 'Other', ownerUserId: 'b' });
    mine = store.createProject('Mine', {}, acme.id).id;
    theirs = store.createProject('Theirs', {}, other.id).id;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens, contentDir: home, worlds: new WorldRegistry() });
    const gateway = new Gateway({
      api, store, tokens,
      bus: new KarmaxBus(),
      contributions: new ContributionRegistry(),
      overlays: new Overlays(),
      authorization: new AuthorizationService(store),
      client: {} as any,
      taskQueue: 'test',
      staticDir: home,
      agentInfo: { provider: 'mock', reason: 'scope test' },
      worlds: new WorldRegistry(),
      githubApp: {
        status: () => ({ userAuthorized: false }),
        handleWebhook: async () => {
          if (webhookFailure) throw webhookFailure;
          return { ok: true, events: [] };
        },
      },
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_400));
    base = running.url;
    close = running.close;
    // Exactly the developer profile's task authority, scoped to one project of
    // one organization — the shape a workflow mints for an agent.
    token = tokens.mintPrincipal('user:a', ['task:*', 'project:read'], mine, 60_000, acme.id).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refuses PATCH/DELETE /api/tags/:id across a project and tenant boundary', async () => {
    const foreign = store.createTag({ projectId: theirs, name: 'security' });
    const own = store.createTag({ projectId: mine, name: 'bug' });

    const renamed = await fetch(`${base}/api/tags/${foreign.id}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'pwned' }),
    });
    expect(renamed.status).toBe(403);
    const removed = await fetch(`${base}/api/tags/${foreign.id}`, { method: 'DELETE', headers: auth() });
    expect(removed.status).toBe(403);
    expect(store.getTag(foreign.id)?.name).toBe('security');

    // The same call inside the token's own project is untouched.
    const ok = await fetch(`${base}/api/tags/${own.id}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'defect' }),
    });
    expect(ok.status).toBe(200);
    expect(store.getTag(own.id)?.name).toBe('defect');
  });

  it('refuses PATCH/DELETE/reorder /api/views/:id across a project and tenant boundary', async () => {
    const foreign = store.createView({ projectId: theirs, name: 'Theirs', query: {} as any });
    const own = store.createView({ projectId: mine, name: 'Mine', query: {} as any });

    for (const [method, suffix, body] of [
      ['PATCH', '', JSON.stringify({ name: 'pwned' })],
      ['POST', '/reorder', JSON.stringify({ ord: 0 })],
      ['DELETE', '', undefined],
    ] as const) {
      const response = await fetch(`${base}/api/views/${foreign.id}${suffix}`, { method, headers: auth(), body });
      expect(response.status, `${method} /api/views/:id${suffix}`).toBe(403);
    }
    expect(store.getView(foreign.id)?.name).toBe('Theirs');

    const ok = await fetch(`${base}/api/views/${own.id}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(ok.status).toBe(200);
  });

  /**
   * `Gateway.fail` used to flatten every non-CapabilityError to a 500, so
   * `no such task <id>` reached an agent looking like a server fault ("back
   * off") rather than a bad identifier ("retry with another id").
   */
  it('answers a missing identifier with 404 rather than 500', async () => {
    const missing = await fetch(`${base}/api/tasks/task_missing/tag`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ add: ['bug'] }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error).toMatch(/no such task/i);
  });

  /**
   * The webhook handler turned ANY exception into a 401, which makes GitHub
   * redeliver — but `handleWebhook` has already inserted the delivery dedupe row
   * by then, so the redelivery short-circuits as a duplicate and the reconcile is
   * lost forever. Only a real signature failure may answer 401.
   */
  it('answers a GitHub webhook processing fault with 500, and a bad signature with 401', async () => {
    const deliver = () => fetch(`${base}/api/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd1' },
      body: JSON.stringify({ action: 'closed' }),
    });

    webhookFailure = new Error('invalid GitHub webhook signature');
    expect((await deliver()).status).toBe(401);

    webhookFailure = new Error('SQLITE_BUSY: database is locked');
    expect((await deliver()).status).toBe(500);

    webhookFailure = undefined;
    expect((await deliver()).status).toBe(200);
  });
});
