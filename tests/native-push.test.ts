import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { BrowserDeliveryAdapter, DeliveryDispatcher } from '../src/collaboration/delivery.js';
import { FCM_CREDENTIAL_HANDLE, fcmRequestBody, NativePush } from '../src/collaboration/native-push.js';
import { PushDeliveryAdapter } from '../src/collaboration/push-delivery.js';
import { generateVapidKeys } from '../src/collaboration/web-push.js';
import { storeBackends } from './helpers/store-backends.js';

/**
 * Native push for the phone apps (wiki features/phone-apps): FCM HTTP v1 with
 * an OAuth access token from the installation's Firebase service account
 * (an RS256 JWT signed with node:crypto), beside Web Push in the same device
 * list and urgency settings.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account', project_id: 'tavya-push', client_email: 'push@tavya-push.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://oauth2.googleapis.com/token',
};
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function broker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-native-push-'));
  dirs.push(dir);
  return new CredentialBroker(new Vault(path.join(dir, 'vault')));
}

/** Google's token endpoint and FCM, answering what each test sets. */
function google() {
  const assertions: string[] = [];
  const sends: Array<{ url: string; authorization: string; body: any }> = [];
  const answers = new Map<string, { status: number; body?: unknown }>();
  let issued = 0;
  let tokenStatus = 200;
  const fetcher = (async (url: string, init: RequestInit) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      assertions.push(form.get('assertion')!);
      if (tokenStatus !== 200) return Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: tokenStatus });
      return Response.json({ access_token: `ya29.token-${++issued}`, expires_in: 3599, token_type: 'Bearer' });
    }
    const body = JSON.parse(String(init.body));
    sends.push({ url, authorization: String((init.headers as Record<string, string>).authorization), body });
    const answer = answers.get(body.message.token) ?? { status: 200, body: { name: `projects/tavya-push/messages/${sends.length}` } };
    return Response.json(answer.body ?? {}, { status: answer.status });
  }) as unknown as typeof fetch;
  return { fetcher, assertions, sends, answers, setTokenStatus: (status: number) => { tokenStatus = status; } };
}

const unregistered = { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND',
  details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } };

describe('the FCM message', () => {
  const message = { title: 'Ship the login page', body: '#42 · approval requested', url: '/acme/web/tasks/42/checkin', tag: 'inbox_1', urgency: 'critical' as const };

  it('carries the console path to open, and rings at the inbox urgency on both platforms', () => {
    const now = Date.UTC(2026, 10, 17);
    const body = fcmRequestBody('device-token', message, 86_400, now) as any;
    expect(body).toEqual({ message: {
      token: 'device-token',
      notification: { title: 'Ship the login page', body: '#42 · approval requested' },
      // FCM data values are strings; the app reads `url` when the notification is tapped.
      data: { url: '/acme/web/tasks/42/checkin', tag: 'inbox_1', urgency: 'critical' },
      android: { priority: 'HIGH', ttl: '86400s', collapse_key: expect.any(String), notification: { tag: 'inbox_1', sound: 'default' } },
      apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'alert', 'apns-expiration': String(now / 1000 + 86_400),
        'apns-collapse-id': expect.any(String) }, payload: { aps: { sound: 'default' } } },
    } });
    expect(Buffer.byteLength(body.message.apns.headers['apns-collapse-id'])).toBeLessThanOrEqual(64);
  });

  it('stays quiet below high', () => {
    const body = fcmRequestBody('t', { ...message, urgency: 'normal' }, 60, 0) as any;
    expect(body.message.android.priority).toBe('NORMAL');
    expect(body.message.android.notification.sound).toBeUndefined();
    expect(body.message.apns.headers['apns-priority']).toBe('5');
    expect(body.message.apns.payload.aps.sound).toBeUndefined();
  });
});

describe('the installation\'s Firebase service account', () => {
  it('is unavailable until set, refuses a key Google refuses, and is kept in the vault', async () => {
    const vault = broker(), g = google();
    const push = new NativePush({ broker: vault, fetcher: g.fetcher });
    expect(await push.available()).toBe(false);
    expect(await push.view()).toEqual({ configured: false });
    await expect(push.configure('{"type":"service_account"}')).rejects.toThrow(/client_email, private_key and project_id/);
    g.setTokenStatus(400);
    await expect(push.configure(JSON.stringify(serviceAccount))).rejects.toThrow(/Google refused the service account key \(400\)/);
    expect(await vault.hasHandle(FCM_CREDENTIAL_HANDLE)).toBe(false);
    g.setTokenStatus(200);
    expect(await push.configure(JSON.stringify(serviceAccount)))
      .toEqual({ configured: true, projectId: 'tavya-push', clientEmail: 'push@tavya-push.iam.gserviceaccount.com' });
    expect(await push.available()).toBe(true);
    expect(await vault.hasHandle(FCM_CREDENTIAL_HANDLE)).toBe(true);
    // Another process (a restart) reads it back from the vault.
    expect(await new NativePush({ broker: vault, fetcher: g.fetcher }).available()).toBe(true);
    await push.remove();
    expect(await push.available()).toBe(false);
  });

  it('signs an RS256 JWT for the FCM scope that the account\'s public key verifies', async () => {
    const g = google();
    const push = new NativePush({ broker: broker(), fetcher: g.fetcher });
    await push.configure(JSON.stringify(serviceAccount));
    const [head, claims, signature] = g.assertions[0]!.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    expect(payload).toMatchObject({ iss: serviceAccount.client_email, aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/firebase.messaging' });
    expect(payload.exp - payload.iat).toBe(3600);
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });
});

describe.each(storeBackends)('native push delivery ($name)', ({ open }) => {
  async function fixture(configured = true) {
    const store = await open();
    const org = await store.createOrganization({ name: 'Native', ownerUserId: 'owner' });
    await store.setOrganizationMembership(org.id, 'other', 'member');
    const project = await store.createProject('App', {}, org.id);
    const g = google();
    const native = new NativePush({ broker: broker(), fetcher: g.fetcher });
    if (configured) await native.configure(JSON.stringify(serviceAccount));
    g.assertions.length = 0;
    const webSent: string[] = [];
    const webFetch = (async (url: string) => { webSent.push(url); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    const push = new PushDeliveryAdapter({ store, keys: async () => generateVapidKeys(), fetcher: webFetch, native,
      publicUrl: 'https://tavya.example', siteName: async () => 'tavya' });
    const dispatcher = new DeliveryDispatcher(store, { browser: new BrowserDeliveryAdapter(), push });
    const ask = async (urgency: string, title = urgency) => {
      const task = await store.createTask({ projectId: project.id, title, workflow: 'just-do', workflowVersion: '1',
        params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } });
      await store.appendEvent({ taskId: task.id, type: 'credential.approval-requested', ts: Date.now(), payload: { urgency } });
      return task;
    };
    return { store, org, g, native, webSent, dispatcher, ask };
  }

  it('sends each of a person\'s phones one FCM message at the levels they chose, beside their browsers', async () => {
    const f = await fixture();
    try {
      await f.store.setDeliveryPreferences({ userId: 'owner', organizationId: f.org.id, browser: true, email: false, slack: false,
        routine: true, pushUrgencies: { critical: true, high: false } });
      await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'pixel-token', platform: 'android', label: 'tavya on Android' });
      await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'iphone-token', platform: 'ios', label: 'tavya on iPhone' });
      await f.store.savePushSubscription('owner', { endpoint: 'https://fcm.googleapis.com/fcm/send/laptop',
        keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } });
      await f.store.savePushSubscription('other', { kind: 'fcm', token: 'their-token', platform: 'android' });
      await f.ask('high', 'Quiet one');
      await f.ask('critical', 'Loud one');
      await f.dispatcher.drain();
      // Only the critical ask, only the owner's devices; the access token checked when the key was saved serves both sends.
      expect(f.g.sends.map((send) => send.body.message.token).sort()).toEqual(['iphone-token', 'pixel-token']);
      expect(f.webSent).toEqual(['https://fcm.googleapis.com/fcm/send/laptop']);
      expect(f.g.assertions).toHaveLength(0);
      for (const send of f.g.sends) {
        expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/tavya-push/messages:send');
        expect(send.authorization).toBe('Bearer ya29.token-1');
        expect(send.body.message.notification.title).toBe('Loud one');
        expect(send.body.message.data.url).toMatch(/^\/native\/app\/tasks\/\d+\/checkin$/);
      }
      expect((await f.store.listPushSubscriptions('owner')).every((device) => device.kind === 'web' || device.lastPushedAt)).toBe(true);
    } finally { await f.store.close(); }
  });

  it('forgets a phone FCM no longer knows (UNREGISTERED), keeps one it merely refused', async () => {
    const f = await fixture();
    try {
      await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'gone-token', platform: 'android', label: 'Old phone' });
      await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'odd-token', platform: 'ios', label: 'New phone' });
      f.g.answers.set('gone-token', unregistered);
      f.g.answers.set('odd-token', { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad' } } });
      await f.ask('critical');
      await f.dispatcher.drain();
      expect((await f.store.listPushSubscriptions('owner')).map((device) => device.label)).toEqual(['New phone']);
      // Nothing worth retrying: the delivery is settled, not queued again.
      expect((await f.store.deliveryFailures()).filter((row) => row.channel === 'push')).toEqual([]);
    } finally { await f.store.close(); }
  });

  it('retries when FCM is down, and fetches a new access token once when FCM refuses the old one', async () => {
    const f = await fixture();
    try {
      await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'phone', platform: 'android' });
      f.g.answers.set('phone', { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } });
      await f.ask('critical');
      await f.dispatcher.drain();
      expect((await f.store.deliveryFailures()).filter((row) => row.channel === 'push')).toHaveLength(1);
      expect(await f.store.listPushSubscriptions('owner')).toHaveLength(1);

      let refused = false;
      f.g.answers.set('phone', { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED' } } });
      const original = f.g.sends.length;
      // The first answer is 401; the retry with a fresh token succeeds.
      const answers = f.g.answers;
      const realGet = answers.get.bind(answers);
      answers.get = (key: string) => { if (key === 'phone' && !refused) { refused = true; return realGet(key); } return undefined; };
      await f.ask('critical', 'after expiry');
      await f.dispatcher.drain();
      const later = f.g.sends.slice(original);
      expect(later).toHaveLength(2);
      expect(later[0]!.authorization).not.toBe(later[1]!.authorization);
    } finally { await f.store.close(); }
  });

  it('sends nothing to phones while the installation has no Firebase account, and keeps them', async () => {
    const f = await fixture(false);
    try {
      await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'phone', platform: 'android' });
      await f.ask('critical');
      await f.dispatcher.drain();
      expect(f.g.sends).toEqual([]);
      expect(await f.store.listPushSubscriptions('owner')).toHaveLength(1);
      expect((await f.store.deliveryFailures()).filter((row) => row.channel === 'push')).toEqual([]);
    } finally { await f.store.close(); }
  });

  it('moves a phone to whoever registers it last, and replaces a phone\'s previous token', async () => {
    const f = await fixture();
    try {
      const first = await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'shared', platform: 'android', label: 'Phone' });
      expect(first).toMatchObject({ kind: 'fcm', token: 'shared', platform: 'android' });
      expect((await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'shared', platform: 'android' })).id).toBe(first.id);
      const rotated = await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'rotated', platform: 'android', replaces: first.id });
      expect((await f.store.listPushSubscriptions('owner')).map((device) => device.id)).toEqual([rotated.id]);
      await f.store.savePushSubscription('other', { kind: 'fcm', token: 'rotated', platform: 'android' });
      expect(await f.store.listPushSubscriptions('owner')).toEqual([]);
      // `replaces` only ever removes the caller's own device.
      const theirs = (await f.store.listPushSubscriptions('other'))[0]!;
      await f.store.savePushSubscription('owner', { kind: 'fcm', token: 'mine', platform: 'ios', replaces: theirs.id });
      expect(await f.store.listPushSubscriptions('other')).toHaveLength(1);
    } finally { await f.store.close(); }
  });
});
