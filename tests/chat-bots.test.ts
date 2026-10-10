import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxApi, WebhookAuthError } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ChatReplies, chatThreadKey } from '../src/integrations/chat-replies.js';

/** Chat bots as project event sources (src/integrations/chat-platforms.ts),
 * against each platform's real protocol shapes and a fake platform API. */
describe('chat bots', () => {
  let dir: string;
  let store: Store;
  let broker: CredentialBroker;
  let api: KarmaxApi;
  let token: string;
  let projectId: string;
  let calls: Array<{ url: string; body?: any; headers?: any }>;
  const answers: Record<string, unknown> = {};

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers });
    const match = Object.entries(answers).find(([fragment]) => url.includes(fragment));
    return new Response(JSON.stringify(match?.[1] ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-chat-'));
    store = await Store.create(':memory:');
    broker = new CredentialBroker(new Vault(dir));
    const tokens = new TokenAuthority(store);
    api = new KarmaxApi({ store, tokens, client: { workflow: { getHandle: () => ({}) } } as any, worlds: new WorldRegistry(), taskQueue: 'test', broker });
    projectId = (await store.createProject('Chat')).id;
    token = (await tokens.mintPrincipal('user:a', ['*'], projectId)).token;
    calls = [];
    for (const key of Object.keys(answers)) delete answers[key];
  });
  afterEach(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const connect = (kind: string, credentials: Record<string, string>) =>
    api.createIncomingWebhook(token, projectId, { name: kind, kind, credentials }, { hookUrl: (id) => `https://tavya.example/api/hooks/${id}`, fetcher });
  const receive = (hookId: string, body: unknown, headers: Record<string, string> = {}, method = 'POST', query = '') => {
    const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return api.receiveIncomingWebhook(hookId, { method, raw, contentType: 'application/json', headers, query: new URLSearchParams(query) });
  };

  it('Telegram: connects the webhook, reads mentions and replies, and refuses unsigned updates', async () => {
    answers.getMe = { ok: true, result: { id: 42, username: 'tavya_bot' } };
    const { hook } = await connect('telegram', { botToken: '123:abc' });
    expect(hook).toMatchObject({ kind: 'telegram', type: 'chat.mention', bot: { username: 'tavya_bot', id: '42' } });
    const setWebhook = calls.find((call) => call.url.endsWith('/bot123:abc/setWebhook'))!;
    expect(setWebhook.body).toMatchObject({ url: `https://tavya.example/api/hooks/${hook.id}`, allowed_updates: ['message'] });
    const secret = setWebhook.body.secret_token as string;

    const update = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ update_id: id, message: { message_id: 500 + id, text,
      from: { id: 7, first_name: 'Ada', is_bot: false }, chat: { id: -100, type: 'supergroup', title: 'Team', username: 'team' }, ...extra } });
    const result = await receive(hook.id, update(1, '@tavya_bot please fix the login page'), { 'x-telegram-bot-api-secret-token': secret });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.event).toMatchObject({ type: 'chat.mention', source: `chat:${hook.id}`, key: 'telegram:1', subject: 'https://t.me/team/501',
      payload: { platform: 'telegram', text: 'please fix the login page', author: { id: '7', name: 'Ada' }, channel: { id: '-100', name: 'Team' }, thread: '501' } });
    expect((await receive(hook.id, update(2, 'just chatting'), { 'x-telegram-bot-api-secret-token': secret })).events).toEqual([]);
    await expect(receive(hook.id, update(3, '@tavya_bot hi'), { 'x-telegram-bot-api-secret-token': 'wrong' })).rejects.toBeInstanceOf(WebhookAuthError);

    // A reply to the bot's own answer joins the thread that answer belongs to.
    await store.kvSet(chatThreadKey(hook.id, '900'), '501');
    const reply = await receive(hook.id, update(4, 'also the signup page', { reply_to_message: { message_id: 900, from: { id: 42 } } }),
      { 'x-telegram-bot-api-secret-token': secret });
    expect(reply.events[0]!.event.payload).toMatchObject({ thread: '501', text: 'also the signup page' });
  });

  it('Slack: answers the URL check and reads signed app mentions only', async () => {
    answers['auth.test'] = { ok: true, user_id: 'UBOT', user: 'tavya' };
    const { hook } = await connect('slack', { signingSecret: 'shh', botToken: 'xoxb-1' });
    const signed = (body: unknown, at = Math.floor(Date.now() / 1000)) => {
      const raw = JSON.stringify(body);
      return [body, { 'x-slack-request-timestamp': String(at),
        'x-slack-signature': `v0=${crypto.createHmac('sha256', 'shh').update(`v0:${at}:${raw}`).digest('hex')}` }] as const;
    };
    expect((await receive(hook.id, ...signed({ type: 'url_verification', challenge: 'c-1' }))).answer).toEqual({ status: 200, body: { challenge: 'c-1' } });
    const mention = { type: 'event_callback', event_id: 'Ev1', event: { type: 'app_mention', user: 'U1', text: '<@UBOT> deploy staging', channel: 'C1', ts: '1.1', thread_ts: '1.0' } };
    expect((await receive(hook.id, ...signed(mention))).events[0]!.event).toMatchObject({ key: 'slack:Ev1',
      payload: { platform: 'slack', text: 'deploy staging', channel: { id: 'C1' }, thread: '1.0' } });
    const own = { ...mention, event_id: 'Ev2', event: { ...mention.event, user: 'UBOT' } };
    expect((await receive(hook.id, ...signed(own))).events).toEqual([]);
    await expect(receive(hook.id, ...signed(mention, Math.floor(Date.now() / 1000) - 600))).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it('Discord: registers /tavya, answers PING, and reads signed commands', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw32 = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const { hook } = await connect('discord', { applicationId: 'app1', publicKey: Buffer.from(raw32, 'base64url').toString('hex'), botToken: 'bot-1' });
    expect(calls.find((call) => call.url.endsWith('/applications/app1/commands'))!.body[0]).toMatchObject({ name: 'tavya' });
    expect(calls.find((call) => call.url.endsWith('/applications/@me'))!.body).toEqual({ interactions_endpoint_url: `https://tavya.example/api/hooks/${hook.id}` });
    const signed = (body: unknown) => {
      const raw = JSON.stringify(body);
      const at = String(Math.floor(Date.now() / 1000));
      return [raw, { 'x-signature-timestamp': at, 'x-signature-ed25519': crypto.sign(null, Buffer.from(at + raw), privateKey).toString('hex') }] as const;
    };
    expect((await receive(hook.id, ...signed({ type: 1 }))).answer).toEqual({ status: 200, body: { type: 1 } });
    const command = await receive(hook.id, ...signed({ type: 2, id: 'i-1', channel_id: 'ch-1', member: { user: { id: 'u-1', username: 'grace' } },
      data: { name: 'tavya', options: [{ name: 'request', value: 'triage new issues' }] } }));
    expect(command.answer).toMatchObject({ status: 200, body: { type: 4 } });
    expect(command.events[0]!.event).toMatchObject({ key: 'discord:i-1', payload: { text: 'triage new issues', channel: { id: 'ch-1' }, author: { name: 'grace' } } });
    const [raw, headers] = signed({ type: 1 });
    await expect(receive(hook.id, raw.replace('1', '2'), headers)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it('WhatsApp: answers the verification challenge and reads signed messages', async () => {
    answers['phone-1?fields'] = { display_phone_number: '+1 555' };
    const created = await connect('whatsapp', { phoneNumberId: 'phone-1', appSecret: 'app-secret', accessToken: 'EAA' });
    expect(created.verifyToken).toMatch(/^[0-9a-f]{32}$/);
    const challenge = await receive(created.hook.id, '', {}, 'GET', `hub.mode=subscribe&hub.verify_token=${created.verifyToken}&hub.challenge=42`);
    expect(challenge.answer).toEqual({ status: 200, body: '42', text: true });
    await expect(receive(created.hook.id, '', {}, 'GET', 'hub.mode=subscribe&hub.verify_token=no&hub.challenge=42')).rejects.toBeInstanceOf(WebhookAuthError);
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, contacts: [{ wa_id: '4477', profile: { name: 'Lin' } }],
      messages: [{ id: 'wamid.1', from: '4477', type: 'text', text: { body: 'restart the worker' } }] } }] }] });
    const result = await receive(created.hook.id, body, { 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}` });
    expect(result.events[0]!.event).toMatchObject({ key: 'whatsapp:wamid.1', payload: { text: 'restart the worker', author: { id: '4477', name: 'Lin' }, channel: { id: '4477' } } });
  });

  it('refuses a bot its platform does not accept, and creates nothing', async () => {
    answers.getMe = { ok: false, description: 'Unauthorized' };
    await expect(connect('telegram', { botToken: 'bad' })).rejects.toThrow(/Telegram: Unauthorized/);
    expect(await api.listIncomingWebhooks(token, projectId)).toEqual([]);
    await expect(connect('telegram', {})).rejects.toThrow(/Bot token is required/);
  });

  it('answers in the thread when a run starts and once when it finishes', async () => {
    answers.getMe = { ok: true, result: { id: 42, username: 'tavya_bot' } };
    answers.sendMessage = { ok: true, result: { message_id: 777 } };
    const { hook } = await connect('telegram', { botToken: '123:abc' });
    const secret = calls.find((call) => call.url.endsWith('/setWebhook'))!.body.secret_token;
    const { events: [{ event }] } = await receive(hook.id, { update_id: 9, message: { message_id: 55, text: '@tavya_bot ship it',
      from: { id: 7, first_name: 'Ada' }, chat: { id: 3, type: 'group', title: 'Ops' } } }, { 'x-telegram-bot-api-secret-token': secret }) as any;
    const run = await store.createTask({ projectId, title: 'Ship', workflow: 'software-dev', workflowVersion: '1.28.0', params: { prompt: 'p' } });
    const replies = new ChatReplies({ store, broker, publicUrl: () => 'https://tavya.example', fetcher });
    calls = [];
    await replies.announce(event, run.id, 'started');
    await replies.announce(event, run.id, 'started');
    const sent = calls.filter((call) => call.url.endsWith('/sendMessage'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ chat_id: '3', reply_to_message_id: 55 });
    expect(sent[0]!.body.text).toMatch(/^On it: https:\/\/tavya\.example\/.+\/tasks\/\d+$/);
    expect(await store.kvGet(chatThreadKey(hook.id, '777'))).toBe('55');

    await store.saveView(run.id, { status: 'done', stage: 'done', reviewInfo: { summary: 'Shipped v2.' }, messages: [] } as any);
    const done = { type: 'view.updated', taskId: run.id, ts: 1, payload: { status: 'done', stage: 'done' } };
    await replies.observe(done);
    await replies.observe(done);
    const finished = calls.filter((call) => call.url.endsWith('/sendMessage')).slice(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.body.text).toMatch(/^Done\.\nShipped v2\.\nhttps:/);
  });
});
