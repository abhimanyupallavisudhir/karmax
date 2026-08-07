import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * Installation-wide settings are the operator's, not the tenant's.
 *
 * Safe mode reboots the whole cell and outbound email is the one sender every
 * organization's confirmations and invites go through — on a managed cell those
 * belong to whoever runs it, and the reader of an organization settings page is
 * generally not that person. The console does no capability gating of its own
 * (every card renders for everyone and the server rejects on write), so the
 * server has to say who may manage what: the same server-derived `canManage`
 * the Stripe Connect card already takes.
 *
 * Deployment mode is deliberately NOT the lever. Outbound email has no env
 * path — it is configured through this UI and nowhere else — so hiding it on
 * `hosted` would leave a SaaS operator unable to configure email at all.
 */
describe('installation-wide settings report who may manage them', () => {
  let home: string;
  let store: Store;
  let base: string;
  let tokens: TokenAuthority;
  let operator: string;
  let tenant: string;
  let close: () => Promise<void>;

  const as = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-instsettings-'));
    store = new Store(':memory:');
    tokens = new TokenAuthority();
    const gateway = new Gateway({
      store,
      bus: new KarmaxBus(),
      tokens,
      contributions: new ContributionRegistry(),
      overlays: new Overlays(),
      client: {} as any,
      api: {} as any,
      taskQueue: 'test',
      staticDir: home,
      agentInfo: { provider: 'mock', reason: 'installation settings test' },
      worlds: new WorldRegistry(),
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_400));
    base = running.url;
    close = running.close;
    operator = tokens.mintPrincipal('user:op', ['safe-mode:write', 'settings:write', 'settings:read']).token;
    // An organization member with ordinary project authority and nothing installation-wide.
    tenant = tokens.mintPrincipal('user:tenant', ['project:read', 'project:settings:write', 'task:*']).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lets a caller read safe mode without holding the capability to change it', () => {
    // Reading must not require safe-mode:write, or the console could never learn
    // that it should hide the toggle.
    expect(routeCapability('GET', '/api/safe-mode', new URL('http://x/api/safe-mode'))).not.toBe('safe-mode:write');
    expect(routeCapability('POST', '/api/safe-mode', new URL('http://x/api/safe-mode'))).toBe('safe-mode:write');
  });

  it('tells the operator they may manage safe mode, and the tenant they may not', async () => {
    const forOperator = await (await fetch(`${base}/api/safe-mode`, { headers: as(operator) })).json() as any;
    expect(forOperator).toMatchObject({ safeMode: false, canManage: true });

    // `settings:read` is installation-scoped in its own right, so an ordinary
    // member is refused the read outright rather than told `canManage: false`.
    // Either answer means the same thing to the console: do not offer the toggle.
    const forTenant = await fetch(`${base}/api/safe-mode`, { headers: as(tenant) });
    if (forTenant.ok) expect((await forTenant.json() as any).canManage).toBe(false);
    else expect(forTenant.status).toBe(403);
  });

  it('still refuses the write itself, not merely the button', async () => {
    const refused = await fetch(`${base}/api/safe-mode`, {
      method: 'POST', headers: as(tenant), body: JSON.stringify({ enabled: true }),
    });
    expect(refused.status).toBe(403);
    expect(store.kvGet('safe-mode')).toBeFalsy();
  });

  it('reports the same for outbound email, which has no env path to fall back on', async () => {
    const forOperator = await (await fetch(`${base}/api/email`, { headers: as(operator) })).json() as any;
    expect(forOperator.canManage).toBe(true);

    const forTenant = await fetch(`${base}/api/email`, { headers: as(tenant) });
    // settings:read is installation-scoped too, so a tenant may simply be refused
    // the read — either way the console must not offer them the form.
    if (forTenant.ok) expect((await forTenant.json() as any).canManage).toBe(false);
    else expect(forTenant.status).toBe(403);
  });

  it('exposes the Installation page probe only to the operator', async () => {
    const allowed = await fetch(`${base}/api/settings/installation`, { headers: as(operator) });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ canManage: true });

    const refused = await fetch(`${base}/api/settings/installation`, { headers: as(tenant) });
    expect(refused.status).toBe(403);
  });
});
