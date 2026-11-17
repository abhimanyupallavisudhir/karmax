import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleCeiling } from '../src/contrib/manifests.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { generateVapidKeys } from '../src/collaboration/web-push.js';

/**
 * A person's push subscriptions (wiki features/push-and-voice): one per device,
 * theirs alone — nobody else lists, removes or takes over their devices — and
 * the installation's VAPID public key for the browser to subscribe with.
 */
describe('push subscriptions through the gateway', () => {
  let home: string;
  let store: Store;
  let base: string;
  let close: () => Promise<void>;
  const tokens = new TokenAuthority();
  const vapid = generateVapidKeys();
  const tokenFor: Record<string, string> = {};
  const call = async (who: string, method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${tokenFor[who]}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

  /** A token that speaks for `userId`: an agent acting under that person's delegation. */
  async function personToken(userId: string, organizationId: string): Promise<string> {
    const human = await tokens.mintPrincipal(`user:${userId}`, ['*'], undefined, undefined, organizationId);
    const delegation = (await tokens.delegateHuman(human.token, { taskId: `t-${userId}`, organizationId }))!;
    return (await tokens.mint({ taskId: `t-${userId}`, principal: `task:t-${userId}`, profileId: 'member', organizationId,
      delegationId: delegation.id, ceiling: roleCeiling('do'), grantorCaps: ['*'] })).token;
  }

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-push-'));
    fs.copyFileSync(new URL('../web/index.html', import.meta.url), path.join(home, 'index.html'));
    store = await Store.create(':memory:');
    const gateway = await Gateway.create({
      store, bus: new KarmaxBus(), tokens, contributions: new ContributionRegistry(), overlays: new Overlays(),
      client: {} as any, api: {} as any, taskQueue: 'test', staticDir: home,
      agentInfo: { provider: 'mock', reason: 'push test' }, worlds: new WorldRegistry(),
      pushKeys: async () => vapid, deliveryChannels: ['browser', 'push'],
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_700));
    base = running.url;
    close = running.close;
    const org = await store.createOrganization({ name: 'Team', ownerUserId: 'alice' });
    await store.setOrganizationMembership(org.id, 'bob', 'member');
    tokenFor.alice = await personToken('alice', org.id);
    tokenFor.bob = await personToken('bob', org.id);
    tokenFor.robot = (await tokens.mintPrincipal('system:robot', ['*'])).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is self-service, listed for agents', () => {
    for (const [method, route] of [['GET', '/api/push/key'], ['GET', '/api/user/push-subscriptions'],
      ['POST', '/api/user/push-subscriptions'], ['DELETE', '/api/user/push-subscriptions/x']])
      expect(routeCapability(method!, route!), `${method} ${route}`).toBe('none');
    expect(PLATFORM_API_CATALOG.identityRequirements.humanSubject).toContain('GET|POST|DELETE /api/user/push-subscriptions');
    expect(PLATFORM_API_CATALOG.operations.some((entry: string) => entry.startsWith('GET /api/push/key'))).toBe(true);
  });

  it('serves the installation\'s VAPID public key, never the private one', async () => {
    const answer = await call('alice', 'GET', '/api/push/key');
    expect(answer).toEqual({ status: 200, body: { publicKey: vapid.publicKey } });
    expect(JSON.stringify(answer.body)).not.toContain(vapid.privateKey);
  });

  it('keeps each person\'s devices to themselves', async () => {
    const added = await call('alice', 'POST', '/api/user/push-subscriptions',
      { endpoint: 'https://fcm.googleapis.com/fcm/send/alice-phone', keys, label: 'Chrome on Android' });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ id: expect.any(String), endpoint: 'https://fcm.googleapis.com/fcm/send/alice-phone', label: 'Chrome on Android' });
    // The keys are the browser's secret with the server; they are not read back.
    expect(added.body.keys).toBeUndefined();
    expect((await call('bob', 'POST', '/api/user/push-subscriptions',
      { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/bob', keys })).status).toBe(200);

    const alices = await call('alice', 'GET', '/api/user/push-subscriptions');
    expect(alices.body.map((entry: any) => entry.label)).toEqual(['Chrome on Android']);
    const bobs = await call('bob', 'GET', '/api/user/push-subscriptions');
    expect(bobs.body).toHaveLength(1);

    // Bob cannot remove Alice's device; Alice can.
    expect((await call('bob', 'DELETE', `/api/user/push-subscriptions/${added.body.id}`)).status).toBe(404);
    expect((await call('alice', 'GET', '/api/user/push-subscriptions')).body).toHaveLength(1);
    expect((await call('alice', 'DELETE', `/api/user/push-subscriptions/${added.body.id}`)).status).toBe(200);
    expect((await call('alice', 'GET', '/api/user/push-subscriptions')).body).toEqual([]);
    expect((await call('bob', 'GET', '/api/user/push-subscriptions')).body).toHaveLength(1);
  });

  it('needs a person, and a real push service endpoint with well-formed keys', async () => {
    expect((await call('robot', 'GET', '/api/user/push-subscriptions')).status).toBe(403);
    expect((await call('robot', 'POST', '/api/user/push-subscriptions',
      { endpoint: 'https://fcm.googleapis.com/fcm/send/robot', keys })).status).toBe(403);
    for (const body of [{ endpoint: 'https://169.254.169.254/latest/meta-data', keys },
      { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'short', auth: keys.auth } },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: keys.p256dh, auth: 'AAAA' } },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x' }])
      expect((await call('alice', 'POST', '/api/user/push-subscriptions', body)).status, JSON.stringify(body)).toBe(400);
  });

  it('stores push urgencies beside email urgencies', async () => {
    const org = (await store.listOrganizations('alice'))[0]!;
    const saved = await call('alice', 'PUT', `/api/inbox/preferences?organizationId=${org.id}`,
      { browser: true, email: false, slack: false, routine: true, pushUrgencies: { low: false, normal: true, high: true, critical: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.pushUrgencies).toEqual({ low: false, normal: true, high: true, critical: true });
    expect((await call('alice', 'PUT', `/api/inbox/preferences?organizationId=${org.id}`, { pushUrgencies: { urgent: true } })).status).toBe(400);
  });
});
