import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxApi, WebhookAuthError } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ChatReplies, chatThreadKey } from '../src/integrations/chat-replies.js';
import { ChatLinks } from '../src/integrations/chat-links.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { EventRunRefused, triggerContext } from '../src/domain/project-events.js';
import { createTriggerTell } from '../src/platform/trigger-scheduler.js';

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

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
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
    await api.updateIncomingWebhook(token, hook.id, { allowed: [{ id: '7' }] });

    const update = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ update_id: id, message: { message_id: 500 + id, text,
      from: { id: 7, first_name: 'Ada', is_bot: false }, chat: { id: -100, type: 'supergroup', title: 'Team', username: 'team' }, ...extra } });
    const result = await receive(hook.id, update(1, '@tavya_bot please fix the login page'), { 'x-telegram-bot-api-secret-token': secret });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.event).toMatchObject({ type: 'chat.mention', source: `chat:${hook.id}`, key: 'telegram:1', subject: `chat:${hook.id}/-100/501`,
      payload: { platform: 'telegram', text: 'please fix the login page', author: { id: '7', name: 'Ada' }, channel: { id: '-100', name: 'Team' }, thread: '501' } });
    expect((await receive(hook.id, update(2, 'just chatting'), { 'x-telegram-bot-api-secret-token': secret })).events).toEqual([]);
    await expect(receive(hook.id, update(3, '@tavya_bot hi'), { 'x-telegram-bot-api-secret-token': 'wrong' })).rejects.toBeInstanceOf(WebhookAuthError);

    // A reply to the bot's own answer joins the thread that answer belongs to.
    await store.kvSet(chatThreadKey(hook.id, '900'), '501');
    const reply = await receive(hook.id, update(4, 'also the signup page', { reply_to_message: { message_id: 900, from: { id: 42 } } }),
      { 'x-telegram-bot-api-secret-token': secret });
    expect(reply.events[0]!.event.payload).toMatchObject({ thread: '501', text: 'also the signup page' });
    // …and so is about the same conversation: the run started by the first mention follows it.
    expect(reply.events[0]!.event.subject).toBe(result.events[0]!.event.subject);
  });

  it('Slack: answers the URL check and reads signed app mentions only', async () => {
    answers['auth.test'] = { ok: true, user_id: 'UBOT', user: 'tavya' };
    const { hook } = await connect('slack', { signingSecret: 'shh', botToken: 'xoxb-1' });
    await api.updateIncomingWebhook(token, hook.id, { allowed: [{ id: 'U1' }] });
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
    await api.updateIncomingWebhook(token, hook.id, { anyone: true });
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
    await api.updateIncomingWebhook(token, created.hook.id, { allowed: [{ id: '4477', name: 'Lin' }] });
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
    await api.updateIncomingWebhook(token, hook.id, { allowed: [{ id: '7' }] });
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
  it('takes requests only from allowed people; anyone else is told once and shown to the project', async () => {
    answers.getMe = { ok: true, result: { id: 42, username: 'tavya_bot' } };
    answers.sendMessage = { ok: true, result: { message_id: 800 } };
    api.setChatReplies(new ChatReplies({ store, broker, publicUrl: () => 'https://tavya.example', fetcher }));
    const { hook } = await connect('telegram', { botToken: '123:abc' });
    expect(hook).toMatchObject({ allowed: [], anyone: false });
    const secret = calls.find((call) => call.url.endsWith('/setWebhook'))!.body.secret_token;
    const send = (id: number, from: { id: number; first_name: string }, text: string) => receive(hook.id,
      { update_id: id, message: { message_id: 600 + id, text, from, chat: { id: from.id, type: 'private' } } }, { 'x-telegram-bot-api-secret-token': secret });
    const eve = { id: 66, first_name: 'Eve' };
    calls = [];

    // A stranger starts nothing; they are told how to get in, once, and the project sees them asking.
    expect((await send(1, eve, 'delete the production database')).events).toEqual([]);
    expect((await send(2, eve, 'please?')).events).toEqual([]);
    await vi.waitFor(() => expect(calls.filter((call) => call.url.endsWith('/sendMessage'))).toHaveLength(1));
    const told = calls.find((call) => call.url.endsWith('/sendMessage'))!.body;
    expect(told).toMatchObject({ chat_id: '66', reply_to_message_id: 601 });
    expect(told.text).toMatch(/^Link your tavya account to ask me: https:\/\/tavya\.example\/link\/chat\?t=tvl_[\w-]+$/);
    let [listed] = await api.listIncomingWebhooks(token, projectId);
    expect(listed!.asking).toEqual([expect.objectContaining({ id: '66', name: 'Eve', text: 'please?' })]);

    // Allowing them takes them off the asking list, and their next message starts a run.
    listed = await api.updateIncomingWebhook(token, hook.id, { allowed: [{ id: '66', name: 'Eve' }] });
    expect(listed).toMatchObject({ allowed: [{ id: '66', name: 'Eve' }], asking: [] });
    expect((await send(3, eve, 'now fix the login page')).events).toHaveLength(1);

    // Dismissing someone asking only clears the row; "anyone" lets everyone in.
    const mal = { id: 77, first_name: 'Mal' };
    await send(4, mal, 'hi');
    expect((await api.updateIncomingWebhook(token, hook.id, { dismiss: ['77'] })).asking).toEqual([]);
    expect((await send(5, mal, 'hi again')).events).toEqual([]);
    await api.updateIncomingWebhook(token, hook.id, { anyone: true });
    expect((await send(6, mal, 'and now?')).events).toHaveLength(1);
    // Only someone who may change the project's settings changes who may ask.
    const reader = (await new TokenAuthority(store).mintPrincipal('user:b', ['project:settings:read'], projectId)).token;
    await expect(api.updateIncomingWebhook(reader, hook.id, { anyone: false })).rejects.toThrow();
  });

  it('Discord: tells a person not allowed in the command answer, privately', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw32 = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    api.setChatReplies(new ChatReplies({ store, broker, publicUrl: () => 'https://tavya.example', fetcher }));
    const { hook } = await connect('discord', { applicationId: 'app1', publicKey: Buffer.from(raw32, 'base64url').toString('hex'), botToken: 'bot-1' });
    const raw = JSON.stringify({ type: 2, id: 'i-9', channel_id: 'ch-1', member: { user: { id: 'u-9', username: 'mallory' } },
      data: { name: 'tavya', options: [{ name: 'request', value: 'wipe it' }] } });
    const at = String(Math.floor(Date.now() / 1000));
    calls = [];
    const result = await receive(hook.id, raw, { 'x-signature-timestamp': at, 'x-signature-ed25519': crypto.sign(null, Buffer.from(at + raw), privateKey).toString('hex') });
    expect(result.events).toEqual([]);
    expect(result.answer).toMatchObject({ status: 200, body: { type: 4, data: { flags: 64 } } });
    expect((result.answer!.body as any).data.content).toMatch(/^Link your tavya account to ask me: https:\/\/tavya\.example\/link\/chat\?t=tvl_/);
    expect(calls.filter((call) => call.url.includes('/channels/'))).toEqual([]);
    expect((await api.listIncomingWebhooks(token, projectId))[0]!.asking).toEqual([expect.objectContaining({ id: 'u-9', name: 'mallory', text: 'wipe it' })]);
  });
});

/**
 * Chat accounts linked to people (wiki planned/assistant §3): someone the bot
 * does not know gets a link; once they confirm it, their runs act as them —
 * created by them, with the series' grant cut to what they hold in the project.
 */
describe('chat accounts linked to people', () => {
  let dir: string;
  let calls: Array<{ url: string; body?: any }>;
  const override: Record<string, unknown> = {};
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = Object.entries(override).find(([fragment]) => url.includes(fragment))?.[1]
      ?? (url.includes('getMe') ? { ok: true, result: { id: 42, username: 'tavya_bot' } }
      : url.includes('sendMessage') ? { ok: true, result: { message_id: 900 } } : { ok: true });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  async function fixture() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-chat-link-'));
    calls = [];
    for (const key of Object.keys(override)) delete override[key];
    const store = await Store.create(':memory:');
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = await store.createProject('Site', {}, organization.id);
    const authorization = await AuthorizationService.create(store);
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    for (const userId of ['admin', 'maint', 'dev', 'reader']) await store.setOrganizationMembership(organization.id, userId, 'member');
    await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: organizationScope(organization.id), profileId: 'administrator' });
    await authorization.grant('system:test', { principalId: 'user:maint', scopeKey: projectScope(project.id), profileId: 'maintainer' });
    await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
    await authorization.grant('system:test', { principalId: 'user:reader', scopeKey: projectScope(project.id), profileId: 'viewer' });
    const tokens = new TokenAuthority(store);
    const broker = new CredentialBroker(new Vault(dir));
    const started: any[] = [];
    const client = { workflow: { getHandle: () => ({}), start: async (_type: string, options: any) => { started.push(options.args[0]); return {}; } } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization, broker, worlds: new WorldRegistry() });
    api.setChatReplies(new ChatReplies({ store, broker, publicUrl: () => 'https://tavya.example', fetcher }));
    const human = async (userId: string) => (await tokens.mintPrincipal(`user:${userId}`,
      await authorization.capabilities(`user:${userId}`, project.id, organization.id), project.id, undefined, organization.id)).token;
    const connect = async (name = 'Telegram bot') => {
      const { hook } = await api.createIncomingWebhook(await human('maint'), project.id, { name, kind: 'telegram', credentials: { botToken: `123:${name}` } },
        { hookUrl: (id) => `https://tavya.example/api/hooks/${id}`, fetcher });
      const secret = calls.filter((call) => call.url.endsWith('/setWebhook')).at(-1)!.body.secret_token as string;
      let update = 0;
      const send = (from: { id: number; first_name: string }, text: string) => api.receiveIncomingWebhook(hook.id, { method: 'POST', contentType: 'application/json',
        raw: Buffer.from(JSON.stringify({ update_id: ++update, message: { message_id: 600 + update, text, from, chat: { id: from.id, type: 'private' } } })),
        headers: { 'x-telegram-bot-api-secret-token': secret }, query: new URLSearchParams() });
      return { hook, send };
    };
    const linkSent = () => {
      const text = calls.filter((call) => call.url.endsWith('/sendMessage')).at(-1)?.body.text as string | undefined;
      return text?.match(/https:\/\/tavya\.example\/link\/chat\?t=(tvl_[\w-]+)/)?.[1];
    };
    /** The project's chat series, as the task store installs it, saved by its maintainer. */
    const series = async (level: string, by = 'maint') => api.createTask(await human(by), { projectId: project.id, workflow: 'just-do',
      prompt: 'Answer the chat', authorization: { level, scope: 'projects', projectIds: [project.id] },
      params: { repeatable: true, triggers: [{ kind: 'event', type: 'chat.mention', recurring: true }] } } as any);
    const system = async () => (await tokens.mintPrincipal('system:triggers', ['*'])).token;
    return { store, organization, project, authorization, tokens, api, human, connect, linkSent, series, system, started };
  }
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const ada = { id: 7, first_name: 'Ada' };

  it('sends someone it does not know a link; signed in, they link the chat account to themselves, once', async () => {
    const f = await fixture();
    const { hook, send } = await f.connect();
    expect((await send(ada, 'fix the login page')).events).toEqual([]);
    await vi.waitFor(() => expect(f.linkSent()).toBeTruthy());
    const token = f.linkSent()!;
    expect(calls.filter((call) => call.url.endsWith('/sendMessage')).at(-1)!.body.text).toMatch(/^Link your tavya account to ask me: https:\/\/tavya\.example\/link\/chat\?t=tvl_/);
    // Asking again while the link works sends nothing more.
    await send(ada, 'hello?');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((call) => call.url.endsWith('/sendMessage'))).toHaveLength(1);

    expect(await f.api.pendingChatLink(await f.human('dev'), token)).toMatchObject({ platform: 'telegram', platformName: 'Ada', platformUserId: '7',
      bot: { name: 'Telegram bot', username: 'tavya_bot' } });
    const link = await f.api.linkChatAccount(await f.human('dev'), token);
    expect(link).toMatchObject({ bot: { id: hook.id, name: 'Telegram bot' }, userId: 'dev', platformUserId: '7', platformName: 'Ada' });
    // The token is single-use, and only ever a digest is stored.
    await expect(f.api.linkChatAccount(await f.human('maint'), token)).rejects.toThrow(/used already or is not valid/);
    await expect(f.api.pendingChatLink(await f.human('dev'), token)).rejects.toThrow(/used already, expired or is not valid/);
    expect(JSON.stringify(await f.store.kvEntries('chat-link'))).not.toContain(token);
    expect(await f.api.listChatLinks(await f.human('dev'))).toMatchObject([{ id: link.id, platform: 'telegram', platformName: 'Ada', bot: { name: 'Telegram bot' } }]);
  });

  it('a link token reaches only its person: a group is told to message the bot directly, and the link goes there', async () => {
    const f = await fixture();
    const { hook } = await f.connect();
    const secret = calls.filter((call) => call.url.endsWith('/setWebhook')).at(-1)!.body.secret_token as string;
    let update = 100;
    const inGroup = (from: { id: number; first_name: string }, text: string) => f.api.receiveIncomingWebhook(hook.id, { method: 'POST', contentType: 'application/json',
      raw: Buffer.from(JSON.stringify({ update_id: ++update, message: { message_id: 700 + update, text, from, chat: { id: -100, type: 'supergroup', title: 'Team' } } })),
      headers: { 'x-telegram-bot-api-secret-token': secret }, query: new URLSearchParams() });
    const sent = () => calls.filter((call) => call.url.endsWith('/sendMessage')).map((call) => call.body);

    // Someone the bot does not know asks in a group: everyone there would see a
    // link, so the group is told to message the bot instead, and no token exists.
    expect((await inGroup(ada, '@tavya_bot fix the login page')).events).toEqual([]);
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ chat_id: '-100' });
    expect(sent()[0].text).toBe('Message me directly to link your tavya account: https://t.me/tavya_bot');
    expect(JSON.stringify(sent())).not.toContain('/link/chat');
    expect(await f.store.kvEntries('chat-link-token:')).toEqual([]);
    // …once while that would still hold, so the group is not spammed.
    await inGroup(ada, '@tavya_bot hello?');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toHaveLength(1);

    // In a direct message the link goes to them alone.
    const direct = await f.api.receiveIncomingWebhook(hook.id, { method: 'POST', contentType: 'application/json',
      raw: Buffer.from(JSON.stringify({ update_id: ++update, message: { message_id: 800, text: 'hi', from: ada, chat: { id: 7, type: 'private' } } })),
      headers: { 'x-telegram-bot-api-secret-token': secret }, query: new URLSearchParams() });
    expect(direct.events).toEqual([]);
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toMatchObject({ chat_id: '7' });
    expect(f.linkSent()).toBeTruthy();
  });

  it('Slack: a channel mention gets its link where only the sender sees it; a failed whisper never falls back to the channel', async () => {
    const f = await fixture();
    const { hook } = await f.api.createIncomingWebhook(await f.human('maint'), f.project.id, { name: 'Slack bot', kind: 'slack',
      credentials: { signingSecret: 'sss', botToken: 'xoxb-1' } }, { hookUrl: (id) => `https://tavya.example/api/hooks/${id}`, fetcher });
    let n = 0;
    const slack = (user: string, event: Record<string, unknown>) => {
      const raw = JSON.stringify({ type: 'event_callback', event_id: `Ev${++n}`, event: { user, ts: `17000.${n}`, ...event } });
      const at = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${crypto.createHmac('sha256', 'sss').update(`v0:${at}:${raw}`).digest('hex')}`;
      return f.api.receiveIncomingWebhook(hook.id, { method: 'POST', contentType: 'application/json', raw: Buffer.from(raw),
        headers: { 'x-slack-request-timestamp': at, 'x-slack-signature': signature }, query: new URLSearchParams() });
    };
    const posted = () => calls.filter((call) => call.url.endsWith('/chat.postMessage')).map((call) => call.body);
    const whispered = () => calls.filter((call) => call.url.endsWith('/chat.postEphemeral')).map((call) => call.body);
    calls = [];

    expect((await slack('U7', { type: 'app_mention', channel: 'C1', text: '<@UBOT> fix it' })).events).toEqual([]);
    await vi.waitFor(() => expect(whispered()).toHaveLength(1));
    expect(whispered()[0]).toMatchObject({ channel: 'C1', user: 'U7', thread_ts: '17000.1' });
    expect(whispered()[0].text).toMatch(/^Link your tavya account to ask me: https:\/\/tavya\.example\/link\/chat\?t=tvl_/);
    expect(posted()).toEqual([]);

    // A direct message is private: the link is posted there.
    await slack('U8', { type: 'message', channel_type: 'im', channel: 'D8', text: 'hi' });
    await vi.waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toMatchObject({ channel: 'D8' });
    expect(posted()[0].text).toMatch(/\/link\/chat\?t=tvl_/);

    // Slack refuses the whisper: nothing reaches the channel, and their next mention tries again.
    override['chat.postEphemeral'] = { ok: false, error: 'user_not_in_channel' };
    await slack('U9', { type: 'app_mention', channel: 'C1', text: '<@UBOT> hi' });
    await vi.waitFor(() => expect(whispered()).toHaveLength(2));
    await vi.waitFor(async () => expect(await new ChatLinks(f.store).offered(hook.id, 'U9')).toBe(false));
    expect(posted()).toHaveLength(1);
    delete override['chat.postEphemeral'];
    await slack('U9', { type: 'app_mention', channel: 'C1', text: '<@UBOT> hi again' });
    await vi.waitFor(() => expect(whispered()).toHaveLength(3));
    expect(whispered()[2]).toMatchObject({ user: 'U9' });
  });

  it('a link token expires, and an agent cannot link one for its person', async () => {
    const f = await fixture();
    const { hook } = await f.connect();
    let now = Date.now();
    const links = new ChatLinks(f.store, () => now);
    const { token } = await links.offer(hook, { id: '7', name: 'Ada' });
    expect(await links.offered(hook.id, '7')).toBe(true);
    now += 16 * 60_000;
    expect(await links.offered(hook.id, '7')).toBe(false);
    expect(await links.pending(token)).toBeUndefined();
    await expect(links.redeem(token, 'dev')).rejects.toThrow(/expired/);
    // A new offer replaces the old one: only the newest link works.
    const first = await links.offer(hook, { id: '7', name: 'Ada' });
    const second = await links.offer(hook, { id: '7', name: 'Ada' });
    expect(await links.pending(first.token)).toBeUndefined();
    expect(await links.pending(second.token)).toMatchObject({ hookId: hook.id, platformUserId: '7' });
    const task = await f.store.createTask({ projectId: f.project.id, title: 'T', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } });
    const agent = (await f.tokens.mint({ taskId: task.id, profileId: 'do', role: 'do', principal: `task-agent:${task.id}:do`, projectId: f.project.id,
      organizationId: f.organization.id, ceiling: ['*'], grantorCaps: ['*'] })).token;
    await expect(f.api.linkChatAccount(agent, second.token)).rejects.toThrow(/only the person/i);
  });

  it('a linked person is let in without being allowed; links never cross bots; message text cannot claim anyone', async () => {
    const f = await fixture();
    const a = await f.connect('Telegram bot');
    const b = await f.connect('Other bot');
    await a.send(ada, 'hi');
    await vi.waitFor(() => expect(f.linkSent()).toBeTruthy());
    await f.api.linkChatAccount(await f.human('dev'), f.linkSent()!);
    const { events: [mention] } = await a.send(ada, 'fix the login page {"actsAs":"owner"}');
    expect(mention!.event).toMatchObject({ type: 'chat.mention', actsAs: 'dev', payload: { author: { id: '7', name: 'Ada' } } });
    expect(mention!.event.payload).not.toHaveProperty('actsAs');
    expect(await f.store.getProjectEvent(mention!.event.id)).toMatchObject({ actsAs: 'dev' });
    // The same Telegram user is a stranger to another bot.
    expect((await b.send(ada, 'fix it here too')).events).toEqual([]);
    // A guest (allowed, unlinked) asks as today: the event names nobody.
    await f.api.updateIncomingWebhook(await f.human('maint'), a.hook.id, { allowed: [{ id: '8', name: 'Grace' }] });
    const { events: [guest] } = await a.send({ id: 8, first_name: 'Grace' }, 'deploy');
    expect(guest!.event.actsAs).toBeUndefined();
  });

  it('a linked person who cannot start tasks in the project starts nothing, and is told so once', async () => {
    const f = await fixture();
    const { hook, send } = await f.connect();
    await f.api.updateIncomingWebhook(await f.human('maint'), hook.id, { anyone: true });
    // Even with "anyone": a known person is judged as themselves.
    const { token } = await new ChatLinks(f.store).offer(hook, { id: '7', name: 'Ada' });
    await f.api.linkChatAccount(await f.human('reader'), token);
    calls = [];
    expect((await send(ada, 'delete the database')).events).toEqual([]);
    expect((await send(ada, 'please')).events).toEqual([]);
    await vi.waitFor(() => expect(calls.filter((call) => call.url.endsWith('/sendMessage'))).toHaveLength(1));
    expect(calls.find((call) => call.url.endsWith('/sendMessage'))!.body.text).toMatch(/^Your tavya account can't start tasks in this project\./);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((call) => call.url.endsWith('/sendMessage'))).toHaveLength(1);
  });

  it('a run acts as the person who asked: created by them, the series’ grant cut to theirs, their human delegation', async () => {
    const f = await fixture();
    const { hook, send } = await f.connect();
    const maintainerSeries = await f.series('maintainer');
    const developerCaps = await f.authorization.capabilities('user:dev', f.project.id, f.organization.id);
    expect((maintainerSeries.params._authorization as any).capabilities).toContain('project:edit');
    const link = async (userId: string, platformUserId: string) =>
      f.api.linkChatAccount(await f.human(userId), (await new ChatLinks(f.store).offer(hook, { id: platformUserId, name: userId })).token);
    await link('dev', '7');
    await link('admin', '9');

    // Less authority than the series': the run gets only what the developer holds.
    const { events: [mention] } = await send(ada, 'fix the login page');
    const { startedTaskId } = await f.api.fireTriggeredTask(await f.system(), maintainerSeries.id, 'clone', triggerContext(mention!.event));
    const run = (await f.store.getTask(startedTaskId))!;
    expect(run.createdBy).toEqual({ kind: 'user', userId: 'dev' });
    const grant = run.params._authorization as any;
    expect(grant).toMatchObject({ principal: 'user:dev', profileAttenuated: true });
    expect(grant.capabilities).not.toContain('project:edit');
    expect(grant.capabilities.every((cap: string) => developerCaps.some((held) => held === cap || held.endsWith('*') && cap.startsWith(held.slice(0, -1))))).toBe(true);
    expect(grant.scope).toBeUndefined();
    expect(await f.store.getHumanDelegation(grant.delegationId)).toMatchObject({ humanUserId: 'dev', taskId: run.id, projectId: f.project.id });
    expect(f.started.at(-1)).toMatchObject({ taskId: run.id, grantPrincipal: 'user:dev', delegationId: grant.delegationId });

    // More authority than the series': capped at the series' grant.
    const developerSeries = await f.series('developer');
    const seriesCaps = (developerSeries.params._authorization as any).capabilities as string[];
    const { events: [adminAsks] } = await send({ id: 9, first_name: 'Ida' }, 'and the signup page');
    const adminRun = (await f.store.getTask((await f.api.fireTriggeredTask(await f.system(), developerSeries.id, 'clone', triggerContext(adminAsks!.event))).startedTaskId))!;
    expect(adminRun.createdBy).toEqual({ kind: 'user', userId: 'admin' });
    expect([...(adminRun.params._authorization as any).capabilities].sort()).toEqual([...seriesCaps].sort());
    expect((adminRun.params._authorization as any).capabilities).not.toContain('project:edit');

    // A trigger context claiming someone the stored event does not name changes nothing.
    const forged = { ...triggerContext(adminAsks!.event), actsAs: 'owner' };
    const forgedRun = (await f.store.getTask((await f.api.fireTriggeredTask(await f.system(), developerSeries.id, 'clone', forged)).startedTaskId))!;
    expect(forgedRun.createdBy).toEqual({ kind: 'user', userId: 'admin' });

    // Someone who lost the project between asking and the run starting starts nothing; the dispatcher skips it for good.
    await f.authorization.revoke('system:test', 'user:dev', projectScope(f.project.id));
    await expect(f.api.fireTriggeredTask(await f.system(), maintainerSeries.id, 'clone', triggerContext(mention!.event)))
      .rejects.toBeInstanceOf(EventRunRefused);
  });

  it('a guest’s run acts as the series, as before', async () => {
    const f = await fixture();
    const { hook, send } = await f.connect();
    await f.api.updateIncomingWebhook(await f.human('maint'), hook.id, { allowed: [{ id: '8', name: 'Grace' }] });
    const chat = await f.series('maintainer');
    const { events: [mention] } = await send({ id: 8, first_name: 'Grace' }, 'deploy');
    const run = (await f.store.getTask((await f.api.fireTriggeredTask(await f.system(), chat.id, 'clone', triggerContext(mention!.event))).startedTaskId))!;
    expect(run.createdBy).toEqual(chat.createdBy);
    expect(run.params._authorization).toMatchObject({ principal: 'user:maint' });
    expect([...(run.params._authorization as any).capabilities].sort()).toEqual([...(chat.params._authorization as any).capabilities].sort());
  });

  it('a thread reply a run hears is attributed to its linked author', async () => {
    const f = await fixture();
    const { hook, send } = await f.connect();
    await f.api.linkChatAccount(await f.human('dev'), (await new ChatLinks(f.store).offer(hook, { id: '7', name: 'Ada' })).token);
    const { events: [mention] } = await send(ada, 'also the signup page');
    const working = await f.store.createTask({ projectId: f.project.id, title: 'Working', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } });
    await f.api.fireTriggeredTask(await f.system(), working.id, 'followUp', triggerContext(mention!.event), { kind: 'event', type: 'chat.mention' } as any);
    const pending = JSON.parse((await f.store.kvGet(`pending-messages:${working.id}`)) ?? '[]');
    expect(pending.at(-1)?.message).toMatchObject({ author: 'user:dev' });
    // A reply `tell`'d to a run (concurrency mode tell) is theirs too; only the platform may say so.
    const told: any[] = [];
    await createTriggerTell({ postTaskMessage: async (_token: string, _taskId: string, input: any) => { told.push(input); return { notified: [] }; } } as any, f.tokens)(
      working.id, triggerContext(mention!.event));
    expect(told[0]).toMatchObject({ onBehalfOf: 'dev' });
    const posted = await f.api.postTaskMessage(await f.system(), working.id, { text: 'from chat', onBehalfOf: 'dev' });
    expect(posted.message).toMatchObject({ author: 'user:dev' });
    const spoofed = await f.api.postTaskMessage(await f.human('maint'), working.id, { text: 'me', onBehalfOf: 'dev' });
    expect(spoofed.message).toMatchObject({ author: 'user:maint' });
  });

  it('the person and the project each list links and remove them', async () => {
    const f = await fixture();
    const { hook } = await f.connect();
    const link = await f.api.linkChatAccount(await f.human('dev'), (await new ChatLinks(f.store).offer(hook, { id: '7', name: 'Ada' })).token);
    const other = await f.api.linkChatAccount(await f.human('dev'), (await new ChatLinks(f.store).offer(hook, { id: '70', name: 'Ada2' })).token);
    expect((await f.api.listIncomingWebhooks(await f.human('maint'), f.project.id))[0]!.linked).toEqual([
      { id: link.id, userId: 'dev', platformUserId: '7', platformName: 'Ada', createdAt: link.createdAt },
      { id: other.id, userId: 'dev', platformUserId: '70', platformName: 'Ada2', createdAt: other.createdAt }]);
    // Someone else cannot remove a person's link; the person can.
    await expect(f.api.deleteChatLink(await f.human('maint'), link.id)).rejects.toThrow(/no such link/);
    await f.api.deleteChatLink(await f.human('dev'), link.id);
    expect((await f.api.listChatLinks(await f.human('dev'))).map((entry) => entry.id)).toEqual([other.id]);
    // The project removes one with the bot's settings.
    expect((await f.api.updateIncomingWebhook(await f.human('maint'), hook.id, { unlink: [other.id] })).linked).toEqual([]);
    expect(await f.api.listChatLinks(await f.human('dev'))).toEqual([]);
    // Deleting the bot takes its links.
    await f.api.linkChatAccount(await f.human('dev'), (await new ChatLinks(f.store).offer(hook, { id: '7', name: 'Ada' })).token);
    await f.api.deleteIncomingWebhook(await f.human('maint'), hook.id);
    expect(await f.api.listChatLinks(await f.human('dev'))).toEqual([]);
  });

  it('a person’s links are read from their own index, which follows re-linking and removal', async () => {
    const f = await fixture();
    const { hook } = await f.connect();
    const links = new ChatLinks(f.store);
    const first = await links.redeem((await links.offer(hook, { id: '7', name: 'Ada' })).token, 'dev');
    await links.redeem((await links.offer(hook, { id: '8', name: 'Grace' })).token, 'maint');
    expect((await links.forUser('dev')).map((link) => link.id)).toEqual([first.id]);
    // The same chat user linked to someone else leaves the first person's list.
    const again = await links.redeem((await links.offer(hook, { id: '7', name: 'Ada' })).token, 'maint');
    expect(await links.forUser('dev')).toEqual([]);
    expect((await links.forUser('maint')).map((link) => link.platformUserId)).toEqual(['8', '7']);
    await links.remove(again);
    expect((await links.forUser('maint')).map((link) => link.platformUserId)).toEqual(['8']);
    expect((await f.store.kvEntries('chat-link-user:')).map((row) => row.key)).toEqual([expect.stringMatching(/^chat-link-user:maint:/)]);
    // A deleted bot takes its people's index rows too.
    await f.api.deleteIncomingWebhook(await f.human('maint'), hook.id);
    expect(await f.store.kvEntries('chat-link')).toEqual([]);
  });

  it('a deleted project or organization takes its links and open link tokens', async () => {
    const f = await fixture();
    const { hook } = await f.connect();
    const links = new ChatLinks(f.store);
    await links.redeem((await links.offer(hook, { id: '7', name: 'Ada' })).token, 'dev');
    await links.offer(hook, { id: '8', name: 'Grace' });
    const other = await f.store.createProject('Other', {}, f.organization.id);
    const kept = await links.redeem((await links.offer({ id: 'hook_other', projectId: other.id, organizationId: f.organization.id }, { id: '7' })).token, 'dev');
    // Two links (each with a row in its person's index) and an open offer (its token and the person's offer).
    expect((await f.store.kvEntries('chat-link')).length).toBe(6);
    await f.store.deleteProject(f.project.id);
    expect((await f.store.kvEntries('chat-link')).map((row) => row.key)).toEqual([`chat-link-user:dev:${kept.id}`, `chat-link:hook_other:7`]);
    expect((await links.forUser('dev')).map((link) => link.id)).toEqual([kept.id]);
    await f.store.deleteOrganization(f.organization.id);
    expect(await f.store.kvEntries('chat-link')).toEqual([]);
  });
});
