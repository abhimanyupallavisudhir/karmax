import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BrowserDeliveryAdapter, DeliveryDispatcher } from '../src/collaboration/delivery.js';
import { PushDeliveryAdapter, pushMessage } from '../src/collaboration/push-delivery.js';
import { encryptPushPayload, generateVapidKeys, pushEndpointAllowed, vapidAuthorization } from '../src/collaboration/web-push.js';
import type { InboxItem } from '../src/domain/types.js';
import { storeBackends } from './helpers/store-backends.js';

/**
 * Web Push (wiki features/push-and-voice): payloads encrypted per RFC 8291
 * (aes128gcm, RFC 8188), the application server identified per RFC 8292
 * (VAPID), sent per RFC 8030 by the inbox's delivery dispatcher.
 */

const b64 = (value: string) => Buffer.from(value.replace(/\s+/g, ''), 'base64url');

// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

/** The user agent's side of RFC 8291, to read what the server sent. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const record = body.subarray(21 + idlen);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2); // the last record's delimiter
  return padded.subarray(0, end).toString('utf8');
}

function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

describe('Web Push message encryption (RFC 8291)', () => {
  it('reproduces the RFC 8291 §5 example byte for byte', () => {
    const body = encryptPushPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      { salt: b64(RFC.salt), senderPrivateKey: b64(RFC.asPrivate), recordSize: 4096 });
    expect(body.toString('base64url')).toBe(RFC.body.replace(/\s+/g, ''));
  });

  it('is readable by the subscribing browser, with a fresh key and salt each time', () => {
    const ua = browserKeys();
    const a = encryptPushPayload('{"title":"Hi"}', ua.keys);
    const b = encryptPushPayload('{"title":"Hi"}', ua.keys);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, ua.ecdh.getPrivateKey(), ua.ecdh.getPublicKey(), ua.auth)).toBe('{"title":"Hi"}');
    expect(decrypt(b, ua.ecdh.getPrivateKey(), ua.ecdh.getPublicKey(), ua.auth)).toBe('{"title":"Hi"}');
  });

  it('refuses keys that are not a P-256 point and a 16-byte secret', () => {
    expect(() => encryptPushPayload('x', { p256dh: 'AAAA', auth: RFC.authSecret })).toThrow(/p256dh/);
    expect(() => encryptPushPayload('x', { p256dh: RFC.uaPublic, auth: 'AAAA' })).toThrow(/auth/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 JWT for the push service origin that the public key verifies', () => {
    const keys = generateVapidKeys();
    expect(b64(keys.publicKey)).toHaveLength(65);
    expect(b64(keys.privateKey)).toHaveLength(32);
    const now = Date.UTC(2026, 10, 17, 12);
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', keys, 'https://tavya.io', now);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, jwt, k] = match!;
    expect(k).toBe(keys.publicKey);
    const [head, claims, signature] = jwt!.split('.');
    expect(JSON.parse(b64(head!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b64(claims!).toString())).toEqual({ aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now / 1000) + 12 * 3600, sub: 'https://tavya.io' });
    const point = b64(keys.publicKey);
    const publicKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
    expect(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
      b64(signature!))).toBe(true);
  });

  it('sends only to the browsers\' push services, over HTTPS', () => {
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/QGx', 'https://wns2-par02p.notify.windows.com/w/?token=x'])
      expect(pushEndpointAllowed(endpoint), endpoint).toBe(true);
    for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://169.254.169.254/latest', 'https://localhost:8080/x',
      'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'not a url'])
      expect(pushEndpointAllowed(endpoint), endpoint).toBe(false);
  });
});

describe('what a push notification says', () => {
  const organization = { id: 'org_a', name: 'Acme Labs', slug: 'acme' };
  const project = { id: 'proj_a', name: 'Web App', organizationId: 'org_a' };
  const inbox = { id: 'inbox_1', organizationId: 'org_a', userId: 'u', eventSeq: 1, taskId: 'task_1', urgency: 'high' as const,
    unread: true, actionable: true, createdAt: 1 };

  it('names the task, the ask and opens the task page', () => {
    const message = pushMessage({ inbox: { ...inbox, kind: 'approval-requested' },
      task: { id: 'task_1', num: 42, title: 'Ship the login page', projectId: 'proj_a' } }, { organization, project, siteName: 'tavya' });
    expect(message).toEqual({ title: 'Ship the login page', body: '#42 · approval requested', url: '/acme/web-app/tasks/42/checkin',
      tag: 'inbox_1', urgency: 'high' });
  });

  it('reports a finished task by its status and a notice by its page', () => {
    expect(pushMessage({ inbox: { ...inbox, kind: 'update', actionable: false },
      task: { id: 'task_1', num: 7, title: 'Fix', projectId: 'proj_a', status: 'done' } }, { organization, project, siteName: 'tavya' }))
      .toMatchObject({ body: '#7 · done', url: '/acme/web-app/tasks/7' });
    expect(pushMessage({ inbox: { ...inbox, taskId: 'storage:org_a', kind: 'escalated',
      // Storage notices are stored without a declared type (Store.syncStorageInbox).
      subject: { kind: 'storage', stage: 'deleted', retainedBytes: 1, quotaBytes: 1, deleteAt: 1 } as unknown as InboxItem['subject'] } }, { organization, siteName: 'tavya' }))
      .toMatchObject({ title: 'Storage', body: 'Stored data deleted to fit the limit', url: '/acme/settings#settings-storage' });
  });

  it('keeps a long title short enough for a phone and the 4 KB push limit', () => {
    const message = pushMessage({ inbox: { ...inbox, kind: 'escalated' },
      task: { id: 'task_1', num: 1, title: 'x'.repeat(5000), projectId: 'proj_a' } }, { organization, project, siteName: 'tavya' });
    expect(message.title.length).toBeLessThanOrEqual(120);
    expect(message.title.endsWith('…')).toBe(true);
  });
});

describe.each(storeBackends)('push delivery ($name)', ({ open }) => {
  async function fixture() {
    const store = await open();
    const org = await store.createOrganization({ name: 'Push', ownerUserId: 'owner' });
    await store.setOrganizationMembership(org.id, 'other', 'member');
    const project = await store.createProject('App', {}, org.id);
    const vapid = generateVapidKeys();
    const sent: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    const answers = new Map<string, number>();
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: answers.get(url) ?? 201 });
    }) as unknown as typeof fetch;
    const push = new PushDeliveryAdapter({ store, keys: async () => vapid, fetcher, publicUrl: 'https://tavya.example',
      siteName: async () => 'tavya' });
    const dispatcher = new DeliveryDispatcher(store, { browser: new BrowserDeliveryAdapter(), push });
    const ask = async (urgency: string, title = urgency) => {
      const task = await store.createTask({ projectId: project.id, title, workflow: 'just-do', workflowVersion: '1',
        params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } });
      await store.appendEvent({ taskId: task.id, type: 'credential.approval-requested', ts: Date.now(), payload: { urgency } });
      return task;
    };
    return { store, org, project, vapid, sent, answers, dispatcher, ask };
  }

  it('pushes the levels a person chose to each of their devices, and drops a device the service says is gone', async () => {
    const f = await fixture();
    try {
      await f.store.setDeliveryPreferences({ userId: 'owner', organizationId: f.org.id, browser: true, email: false, slack: false,
        routine: true, pushUrgencies: { critical: true, high: false } });
      const phone = browserKeys(), laptop = browserKeys(), theirs = browserKeys();
      const phoneUrl = 'https://fcm.googleapis.com/fcm/send/phone', laptopUrl = 'https://updates.push.services.mozilla.com/wpush/v2/laptop';
      await f.store.savePushSubscription('owner', { endpoint: phoneUrl, keys: phone.keys, label: 'Phone' });
      await f.store.savePushSubscription('owner', { endpoint: laptopUrl, keys: laptop.keys, label: 'Laptop' });
      await f.store.savePushSubscription('other', { endpoint: 'https://fcm.googleapis.com/fcm/send/theirs', keys: theirs.keys });
      f.answers.set(laptopUrl, 410);
      await f.ask('high', 'Quiet one');
      await f.ask('critical', 'Loud one');
      await f.dispatcher.drain();
      expect(f.sent.map((request) => request.url).sort()).toEqual([phoneUrl, laptopUrl].sort());
      const request = f.sent.find((entry) => entry.url === phoneUrl)!;
      expect(request.headers).toMatchObject({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
        urgency: 'high', ttl: String(24 * 3600) });
      expect(request.headers.authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${f.vapid.publicKey}$`));
      const message = JSON.parse(decrypt(request.body, phone.ecdh.getPrivateKey(), phone.ecdh.getPublicKey(), phone.auth));
      expect(message).toMatchObject({ title: 'Loud one', urgency: 'critical' });
      // Same-origin: the service worker opens it in the console that subscribed.
      expect(message.url).toMatch(/^\/push\/app\/tasks\/\d+\/checkin$/);
      // 410 Gone: the browser unsubscribed; the next ask goes to the phone only.
      expect((await f.store.listPushSubscriptions('owner')).map((entry) => entry.label)).toEqual(['Phone']);
      expect(await f.store.listPushSubscriptions('other')).toHaveLength(1);
    } finally { await f.store.close(); }
  });

  it('pushes high and critical asks by default, and queues nothing for a person without a device', async () => {
    const f = await fixture();
    try {
      expect((await f.store.getDeliveryPreferences('owner', f.org.id)).pushUrgencies)
        .toEqual({ low: false, normal: false, high: true, critical: true });
      await f.ask('high');
      await f.dispatcher.drain();
      expect(f.sent).toEqual([]);
      const phone = browserKeys();
      await f.store.savePushSubscription('owner', { endpoint: 'https://fcm.googleapis.com/fcm/send/p', keys: phone.keys });
      await f.ask('normal');
      await f.ask('high');
      await f.dispatcher.drain();
      expect(f.sent).toHaveLength(1);
    } finally { await f.store.close(); }
  });

  it('retries when no device could be reached, but not a 404 that removed the only one', async () => {
    const f = await fixture();
    try {
      const phone = browserKeys(), url = 'https://fcm.googleapis.com/fcm/send/p';
      await f.store.savePushSubscription('owner', { endpoint: url, keys: phone.keys });
      f.answers.set(url, 503);
      await f.ask('critical');
      await f.dispatcher.drain();
      expect((await f.store.deliveryFailures()).filter((row) => row.channel === 'push')).toHaveLength(1);
      expect(await f.store.listPushSubscriptions('owner')).toHaveLength(1);
      f.answers.set(url, 404);
      await f.ask('critical', 'second');
      await f.dispatcher.drain();
      expect(await f.store.listPushSubscriptions('owner')).toEqual([]);
    } finally { await f.store.close(); }
  });

  it('moves a browser\'s subscription to whoever subscribes it last', async () => {
    const f = await fixture();
    try {
      const phone = browserKeys(), url = 'https://fcm.googleapis.com/fcm/send/shared';
      const first = await f.store.savePushSubscription('owner', { endpoint: url, keys: phone.keys, label: 'Shared' });
      const again = await f.store.savePushSubscription('owner', { endpoint: url, keys: phone.keys, label: 'Shared' });
      expect(again.id).toBe(first.id);
      await f.store.savePushSubscription('other', { endpoint: url, keys: phone.keys, label: 'Shared' });
      expect(await f.store.listPushSubscriptions('owner')).toEqual([]);
      expect(await f.store.listPushSubscriptions('other')).toHaveLength(1);
      expect(await f.store.deletePushSubscription('owner', first.id)).toBe(false);
    } finally { await f.store.close(); }
  });
});
