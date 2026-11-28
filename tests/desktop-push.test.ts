import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { appGrantFixture, type AppGrantFixture } from './helpers/app-grants.js';
import { DesktopPushSockets } from '../src/collaboration/desktop-push.js';
import { PushDeliveryAdapter } from '../src/collaboration/push-delivery.js';
import { generateVapidKeys } from '../src/collaboration/web-push.js';
import type { InboxItem } from '../src/domain/types.js';

/**
 * Push to the desktop apps (wiki features/desktop-apps, planned/native-apps-round-2
 * § contracts 4): a device of kind `desktop` in the person's push devices, with
 * the same Push column and levels as browsers and phones. A push reaches it over
 * the person's own `/ws` connections that announced that device — the desktop
 * app's console — and is dropped when none is connected (the inbox keeps it).
 */
const sockets = new DesktopPushSockets();
let f: AppGrantFixture;
const vapid = generateVapidKeys();
beforeAll(async () => { f = await appGrantFixture({ desktopPush: sockets, pushKeys: async () => vapid, deliveryChannels: ['browser', 'push'] } as any); });
afterAll(async () => { await f.g.close(); });

/** The console's live connection, as the desktop app opens it. */
async function connect(cookie: string) {
  const ws = new WebSocket(`${f.g.url.replace('http:', 'ws:')}/ws`, { headers: { cookie, origin: f.g.url } });
  const received: any[] = [];
  ws.on('message', (data) => { try { received.push(JSON.parse(data.toString())); } catch { /* not JSON */ } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return { ws, received, announce: async (deviceId: string) => { ws.send(JSON.stringify({ type: 'push-device', deviceId })); await waitFor(() => true, 150); } };
}
async function waitFor(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check() && ms > 200) return; await new Promise((r) => setTimeout(r, 25)); }
}

function adapter() {
  return new PushDeliveryAdapter({ store: f.g.store, keys: async () => vapid, siteName: async () => 'tavya', desktop: sockets,
    fetcher: (async () => new Response(null, { status: 201 })) as unknown as typeof fetch });
}
const inbox = (id: string, urgency: InboxItem['urgency'] = 'high'): InboxItem => ({ id, organizationId: f.organization.id, userId: f.user.id,
  eventSeq: 1, taskId: 'task_x', kind: 'review-requested', urgency, unread: true, actionable: true, createdAt: Date.now() });

describe('desktop push devices', () => {
  it('registers as kind desktop, again under the same key keeps its id, and is never read back by its key', async () => {
    const first = await f.call('POST', '/api/user/push-subscriptions', { cookie: f.cookie }, { kind: 'desktop', key: 'desk-key-0123456789abcdef', label: 'tavya on Mac' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ kind: 'desktop', label: 'tavya on Mac' });
    expect(JSON.stringify(first.body)).not.toContain('desk-key-0123456789abcdef');
    const again = await f.call('POST', '/api/user/push-subscriptions', { cookie: f.cookie }, { kind: 'desktop', key: 'desk-key-0123456789abcdef', label: 'tavya on Mac' });
    expect(again.body.id).toBe(first.body.id);
    const listed = (await f.call('GET', '/api/user/push-subscriptions', { cookie: f.cookie })).body as any[];
    expect(listed.filter((device) => device.kind === 'desktop')).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('desk-key');
    expect((await f.call('POST', '/api/user/push-subscriptions', { cookie: f.cookie }, { kind: 'desktop', key: 'short' })).status).toBe(400);
  });

  it('reaches the connections that announced the device, and only them', async () => {
    const device = (await f.call('POST', '/api/user/push-subscriptions', { cookie: f.cookie }, { kind: 'desktop', key: 'desk-key-reach-000000000', label: 'tavya on Linux' })).body;
    const app = await connect(f.cookie);
    const tab = await connect(f.cookie);
    await app.announce(device.id);
    await adapter().deliver({ inbox: inbox('inbox_reach'), task: { id: 'task_x', num: 7, title: 'Fix the login' } });
    await waitFor(() => app.received.some((m) => m.type === 'push'));
    expect(app.received.find((m) => m.type === 'push')).toEqual({ type: 'push', deviceId: device.id, title: 'Fix the login',
      body: '#7 · review requested', url: '/inbox', tag: 'inbox_reach', urgency: 'high' });
    expect(tab.received.some((m) => m.type === 'push')).toBe(false);
    const listed = (await f.call('GET', '/api/user/push-subscriptions', { cookie: f.cookie })).body as any[];
    expect(listed.find((entry) => entry.id === device.id).lastPushedAt).toBeGreaterThan(0);
    app.ws.close(); tab.ws.close();
  });

  it('is skipped, not retried, while no connection announced it', async () => {
    await f.call('POST', '/api/user/push-subscriptions', { cookie: f.cookie }, { kind: 'desktop', key: 'desk-key-absent-00000000' });
    await expect(adapter().deliver({ inbox: inbox('inbox_absent') })).resolves.toBeUndefined();
  });

  it('ignores an announcement of a device that is not the person\'s own, and stops at sign-out', async () => {
    const other = await f.g.owner({ name: 'Bo', email: 'bo@example.test', password: 'long-fixture-password', organization: 'Bo Co' });
    const theirs = await f.g.store.savePushSubscription(other.user.id, { kind: 'desktop', key: 'desk-key-theirs-0000000' });
    const mine = (await f.call('POST', '/api/user/push-subscriptions', { cookie: f.cookie }, { kind: 'desktop', key: 'desk-key-mine-00000000000' })).body;
    const app = await connect(f.cookie);
    await app.announce(theirs.id);
    expect(sockets.connected(theirs.id)).toBe(0);
    await app.announce(mine.id);
    expect(sockets.connected(mine.id)).toBe(1);
    app.ws.close();
    await waitFor(() => sockets.connected(mine.id) === 0, 2000);
    expect(sockets.connected(mine.id)).toBe(0);
  });
});
