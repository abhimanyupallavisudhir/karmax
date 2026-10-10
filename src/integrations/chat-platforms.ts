import crypto from 'node:crypto';

/**
 * Chat platforms as project event sources (wiki planned/external-connectors-and-
 * automations): a message that mentions the project's bot becomes one
 * `chat.mention` event — the same shape from every platform, so one trigger
 * serves them all — and the bot answers in the thread when a run starts and
 * when it settles.
 *
 * Each adapter knows one platform's protocol: how a delivery proves it came from
 * the platform, which deliveries are protocol handshakes to answer at once, how
 * a mention reads, and how to reply. `thread` is the conversation a reply
 * belongs to (its root), so a trigger keyed on `{{channel.id}}/{{thread}}` with
 * concurrency `tell` sends follow-ups in a thread to the run it started.
 */

export type ChatPlatform = 'telegram' | 'slack' | 'discord' | 'whatsapp';
export const CHAT_PLATFORMS: ChatPlatform[] = ['telegram', 'slack', 'discord', 'whatsapp'];

/** What a person supplies when connecting a bot (labels for the form). */
export const CHAT_CREDENTIALS: Record<ChatPlatform, Array<{ name: string; label: string; secret: boolean }>> = {
  telegram: [{ name: 'botToken', label: 'Bot token', secret: true }],
  slack: [{ name: 'signingSecret', label: 'Signing secret', secret: true }, { name: 'botToken', label: 'Bot token', secret: true }],
  discord: [{ name: 'applicationId', label: 'Application ID', secret: false }, { name: 'publicKey', label: 'Public key', secret: false },
    { name: 'botToken', label: 'Bot token', secret: true }],
  whatsapp: [{ name: 'phoneNumberId', label: 'Phone number ID', secret: false }, { name: 'appSecret', label: 'App secret', secret: true },
    { name: 'accessToken', label: 'Access token', secret: true }],
};

export type ChatCredentials = Record<string, string>;

/** The platform-neutral `chat.mention` payload. */
export interface ChatMention {
  key: string;
  platform: ChatPlatform;
  text: string;
  author: { id: string; name?: string };
  channel: { id: string; name?: string };
  thread?: string;
  url?: string;
}

export interface ChatDelivery {
  method: string;
  raw: Buffer;
  headers: Record<string, string | string[] | undefined>;
  query: URLSearchParams;
}

/** A delivery's outcome: a protocol answer, mentions to record, or both. */
export interface ChatInbound {
  answer?: { status: number; body: unknown; text?: boolean };
  mentions: ChatMention[];
}

/** What a hook remembers about its bot (never secret). */
export interface ChatBotIdentity { username?: string; id?: string }

const header = (headers: ChatDelivery['headers'], name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};
const sameText = (a: string | undefined, b: string | undefined) => {
  if (a === undefined || b === undefined) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
const json = (raw: Buffer): any => { try { return JSON.parse(raw.toString('utf8')); } catch { return undefined; } };

export class ChatPlatformError extends Error {}

async function call(fetcher: typeof fetch, url: string, init: RequestInit, platform: string): Promise<any> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body: any = await response.json().catch(() => undefined);
  // Telegram and Slack answer 200 with ok:false; Discord and Meta use the status.
  if (!response.ok || body?.ok === false) {
    const reason = body?.description ?? body?.error ?? body?.message ?? body?.error?.message ?? `HTTP ${response.status}`;
    throw new ChatPlatformError(`${platform}: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
  }
  return body;
}

export interface ChatAdapter {
  /** Connect the bot to the hook's URL; returns its identity and any generated secret. */
  connect(credentials: ChatCredentials, url: string, fetcher: typeof fetch): Promise<{ identity: ChatBotIdentity; generated?: ChatCredentials }>;
  /** Read a delivery; refuses one the platform did not sign. */
  receive(credentials: ChatCredentials, identity: ChatBotIdentity, delivery: ChatDelivery): ChatInbound | 'refused';
  reply(credentials: ChatCredentials, to: { channel: string; thread?: string }, text: string, fetcher: typeof fetch): Promise<{ messageId?: string }>;
}

// ─── Telegram ────────────────────────────────────────────────────────────────

const telegram: ChatAdapter = {
  async connect(credentials, url, fetcher) {
    const base = `https://api.telegram.org/bot${credentials.botToken}`;
    const me = await call(fetcher, `${base}/getMe`, {}, 'Telegram');
    const webhookSecret = crypto.randomBytes(24).toString('hex');
    await call(fetcher, `${base}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, secret_token: webhookSecret, allowed_updates: ['message'] }) }, 'Telegram');
    return { identity: { username: me.result?.username, id: String(me.result?.id ?? '') }, generated: { webhookSecret } };
  },
  receive(credentials, identity, delivery) {
    if (!sameText(header(delivery.headers, 'x-telegram-bot-api-secret-token'), credentials.webhookSecret)) return 'refused';
    const update = json(delivery.raw);
    const message = update?.message;
    if (!message?.text || message.from?.is_bot) return { mentions: [] };
    const handle = identity.username ? `@${identity.username}` : undefined;
    const mentioned = message.chat?.type === 'private'
      || (handle && message.text.toLowerCase().includes(handle.toLowerCase()))
      || (identity.id && String(message.reply_to_message?.from?.id ?? '') === identity.id);
    if (!mentioned) return { mentions: [] };
    const text = handle ? message.text.replace(new RegExp(handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim() : message.text.trim();
    const chat = message.chat;
    const thread = String(message.reply_to_message?.message_id ?? message.message_id);
    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || message.from?.username;
    return { mentions: [{
      key: `telegram:${update.update_id}`, platform: 'telegram', text,
      author: { id: String(message.from?.id ?? ''), ...(name ? { name } : {}) },
      channel: { id: String(chat.id), ...(chat.title || chat.username ? { name: chat.title ?? chat.username } : {}) },
      thread,
      ...(chat.username ? { url: `https://t.me/${chat.username}/${message.message_id}` } : {}),
    }] };
  },
  async reply(credentials, to, text, fetcher) {
    const sent = await call(fetcher, `https://api.telegram.org/bot${credentials.botToken}/sendMessage`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: to.channel, text, ...(to.thread ? { reply_to_message_id: Number(to.thread), allow_sending_without_reply: true } : {}) }) },
    'Telegram');
    return { messageId: sent.result?.message_id ? String(sent.result.message_id) : undefined };
  },
};

// ─── Slack ───────────────────────────────────────────────────────────────────

const slack: ChatAdapter = {
  async connect(credentials, _url, fetcher) {
    const me = await call(fetcher, 'https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${credentials.botToken}` } }, 'Slack');
    return { identity: { id: String(me.user_id ?? ''), username: me.user } };
  },
  receive(credentials, identity, delivery) {
    const timestamp = header(delivery.headers, 'x-slack-request-timestamp');
    const signature = header(delivery.headers, 'x-slack-signature');
    if (!timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return 'refused';
    const expected = `v0=${crypto.createHmac('sha256', credentials.signingSecret ?? '').update(`v0:${timestamp}:${delivery.raw.toString('utf8')}`).digest('hex')}`;
    if (!sameText(signature, expected)) return 'refused';
    const body = json(delivery.raw);
    if (body?.type === 'url_verification') return { answer: { status: 200, body: { challenge: body.challenge } }, mentions: [] };
    const event = body?.event;
    if (body?.type !== 'event_callback' || !event || event.bot_id || event.user === identity.id) return { mentions: [] };
    const direct = event.type === 'message' && event.channel_type === 'im' && !event.subtype;
    if (event.type !== 'app_mention' && !direct) return { mentions: [] };
    return { mentions: [{
      key: `slack:${body.event_id}`, platform: 'slack', text: String(event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim(),
      author: { id: String(event.user ?? '') }, channel: { id: String(event.channel ?? '') }, thread: String(event.thread_ts ?? event.ts ?? ''),
    }] };
  },
  async reply(credentials, to, text, fetcher) {
    const sent = await call(fetcher, 'https://slack.com/api/chat.postMessage', { method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${credentials.botToken}` },
      body: JSON.stringify({ channel: to.channel, text, ...(to.thread ? { thread_ts: to.thread } : {}) }) }, 'Slack');
    return { messageId: sent.ts };
  },
};

// ─── Discord (slash command `/tavya`) ────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10';

function discordKey(publicKey: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'hex').toString('base64url') }, format: 'jwk' });
}

const discord: ChatAdapter = {
  async connect(credentials, url, fetcher) {
    if (!/^[0-9a-f]{64}$/i.test(credentials.publicKey ?? '')) throw new ChatPlatformError('Discord: the public key is 64 hex characters');
    const headers = { authorization: `Bot ${credentials.botToken}`, 'content-type': 'application/json' };
    await call(fetcher, `${DISCORD_API}/applications/${credentials.applicationId}/commands`, { method: 'PUT', headers,
      body: JSON.stringify([{ name: 'tavya', description: 'Ask tavya to do something', type: 1,
        options: [{ type: 3, name: 'request', description: 'What should happen', required: true }] }]) }, 'Discord');
    // Discord checks the URL with a signed PING before it accepts it.
    await call(fetcher, `${DISCORD_API}/applications/@me`, { method: 'PATCH', headers, body: JSON.stringify({ interactions_endpoint_url: url }) }, 'Discord');
    return { identity: { id: credentials.applicationId } };
  },
  receive(credentials, _identity, delivery) {
    const signature = header(delivery.headers, 'x-signature-ed25519');
    const timestamp = header(delivery.headers, 'x-signature-timestamp');
    if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return 'refused';
    let valid = false;
    try {
      valid = crypto.verify(null, Buffer.concat([Buffer.from(timestamp), delivery.raw]), discordKey(credentials.publicKey ?? ''), Buffer.from(signature, 'hex'));
    } catch { valid = false; }
    if (!valid) return 'refused';
    const interaction = json(delivery.raw);
    if (interaction?.type === 1) return { answer: { status: 200, body: { type: 1 } }, mentions: [] };
    if (interaction?.type !== 2 || interaction.data?.name !== 'tavya') return { answer: { status: 200, body: { type: 4, data: { content: 'Unknown command.', flags: 64 } } }, mentions: [] };
    const user = interaction.member?.user ?? interaction.user ?? {};
    const text = String(interaction.data?.options?.find((option: any) => option.name === 'request')?.value ?? '').trim();
    return {
      answer: { status: 200, body: { type: 4, data: { content: `> ${text.slice(0, 1800)}` } } },
      mentions: [{ key: `discord:${interaction.id}`, platform: 'discord', text,
        author: { id: String(user.id ?? ''), ...(user.global_name || user.username ? { name: user.global_name ?? user.username } : {}) },
        channel: { id: String(interaction.channel_id ?? interaction.channel?.id ?? '') } }],
    };
  },
  async reply(credentials, to, text, fetcher) {
    const sent = await call(fetcher, `${DISCORD_API}/channels/${to.channel}/messages`, { method: 'POST',
      headers: { authorization: `Bot ${credentials.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 2000) }) }, 'Discord');
    return { messageId: sent.id };
  },
};

// ─── WhatsApp (Meta Cloud API) ───────────────────────────────────────────────

const GRAPH = 'https://graph.facebook.com/v21.0';

const whatsapp: ChatAdapter = {
  async connect(credentials, _url, fetcher) {
    const phone = await call(fetcher, `${GRAPH}/${credentials.phoneNumberId}?fields=display_phone_number`,
      { headers: { authorization: `Bearer ${credentials.accessToken}` } }, 'WhatsApp');
    // Meta's dashboard asks for this token when the webhook URL is entered.
    return { identity: { id: credentials.phoneNumberId, username: phone.display_phone_number }, generated: { verifyToken: crypto.randomBytes(16).toString('hex') } };
  },
  receive(credentials, _identity, delivery) {
    if (delivery.method === 'GET') {
      if (delivery.query.get('hub.mode') !== 'subscribe' || !sameText(delivery.query.get('hub.verify_token') ?? undefined, credentials.verifyToken)) return 'refused';
      return { answer: { status: 200, body: delivery.query.get('hub.challenge') ?? '', text: true }, mentions: [] };
    }
    const expected = `sha256=${crypto.createHmac('sha256', credentials.appSecret ?? '').update(delivery.raw).digest('hex')}`;
    if (!sameText(header(delivery.headers, 'x-hub-signature-256'), expected)) return 'refused';
    const body = json(delivery.raw);
    const mentions: ChatMention[] = [];
    for (const entry of body?.entry ?? []) for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (value?.metadata?.phone_number_id && value.metadata.phone_number_id !== credentials.phoneNumberId) continue;
      const names = new Map((value?.contacts ?? []).map((contact: any) => [contact.wa_id, contact.profile?.name]));
      for (const message of value?.messages ?? []) {
        if (message?.type !== 'text' || !message.text?.body) continue;
        const name = names.get(message.from) as string | undefined;
        mentions.push({ key: `whatsapp:${message.id}`, platform: 'whatsapp', text: String(message.text.body).trim(),
          author: { id: String(message.from), ...(name ? { name } : {}) }, channel: { id: String(message.from) },
          thread: String(message.context?.id ?? message.id) });
      }
    }
    return { mentions };
  },
  async reply(credentials, to, text, fetcher) {
    const sent = await call(fetcher, `${GRAPH}/${credentials.phoneNumberId}/messages`, { method: 'POST',
      headers: { authorization: `Bearer ${credentials.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.channel, type: 'text', text: { body: text.slice(0, 4096) },
        ...(to.thread ? { context: { message_id: to.thread } } : {}) }) }, 'WhatsApp');
    return { messageId: sent.messages?.[0]?.id };
  },
};

export const CHAT_ADAPTERS: Record<ChatPlatform, ChatAdapter> = { telegram, slack, discord, whatsapp };

export function isChatPlatform(value: unknown): value is ChatPlatform {
  return typeof value === 'string' && (CHAT_PLATFORMS as string[]).includes(value);
}
