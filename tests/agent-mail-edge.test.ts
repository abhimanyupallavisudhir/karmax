import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { agentMailIngestKey, decodeEncodedWords, parseRawMail } from '../src/autonomy/agent-mail.js';
import { AGENT_MAIL_MAX_BYTES, MAIL_FROM_HEADER, MAIL_SIGNATURE_HEADER, MAIL_TO_HEADER, SIGNATURE_MAX_AGE_S, signMail, verifyMail }
  from '../src/edge/agent-mail-signature.js';
import { MAIL_EDGE_SCRIPT, bundleMailEdge, deployMailEdge } from '../src/ops/agent-mail-edge-deploy.js';

// Agent mail without a mail server: Cloudflare Email Routing's catch-all for
// the mail domain hands each message to an Email Worker, which posts the raw
// MIME to tavya signed with a key both hold; tavya files it in the inbox of the
// organization that owns the recipient, or drops it.
const DOMAIN = 'mail.tavyausercontent.test';
const AUTH_SECRET = 'a'.repeat(48);
const KEY = agentMailIngestKey({ KARMAX_AUTH_SECRET: AUTH_SECRET });
const encoder = new TextEncoder();

function mime(to: string, subject: string, body: string, messageId = `<${Math.random()}@sender.test>`): string {
  return [`From: GitHub <noreply@github.test>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${messageId}`,
    'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"', '', '--b1',
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', body, '--b1',
    'Content-Type: text/html; charset=utf-8', '', `<p>${body}</p>`, '--b1--', ''].join('\r\n');
}

/** What Email Routing hands the Worker, and what the Worker did with it. */
function inbound(to: string, raw: string, rawSize = encoder.encode(raw).length) {
  const outcome: { rejected?: string } = {};
  return { outcome, message: { from: 'bounce+123@github.test', to, rawSize,
    raw: new Response(raw).body!, setReject(reason: string) { outcome.rejected = reason; } } };
}

describe('the signature the Worker and tavya share', () => {
  const body = encoder.encode('raw message');
  it('covers the time, the envelope and every body byte', async () => {
    const signature = await signMail(KEY, 'a@x', 'b@y', body);
    expect(await verifyMail(KEY, signature, 'a@x', 'b@y', body)).toBe(true);
    expect(await verifyMail(KEY, signature, 'c@x', 'b@y', body)).toBe(false);
    expect(await verifyMail(KEY, signature, 'a@x', 'z@y', body)).toBe(false);
    expect(await verifyMail(KEY, signature, 'a@x', 'b@y', encoder.encode('raw messagE'))).toBe(false);
    expect(await verifyMail(`${KEY}x`, signature, 'a@x', 'b@y', body)).toBe(false);
    expect(await verifyMail('', signature, 'a@x', 'b@y', body)).toBe(false);
    expect(await verifyMail(KEY, undefined, 'a@x', 'b@y', body)).toBe(false);
    expect(await verifyMail(KEY, 't=1,v1=zz', 'a@x', 'b@y', body)).toBe(false);
  });
  it('expires, so a captured delivery cannot be replayed later', async () => {
    const then = Date.now() - (SIGNATURE_MAX_AGE_S + 1) * 1000;
    expect(await verifyMail(KEY, await signMail(KEY, 'a@x', 'b@y', body, then), 'a@x', 'b@y', body)).toBe(false);
  });
  it('is derived from the auth secret for this purpose alone', () => {
    expect(KEY).toHaveLength(43);
    expect(KEY).not.toContain(AUTH_SECRET.slice(0, 8));
    expect(agentMailIngestKey({ KARMAX_AUTH_SECRET: 'b'.repeat(48) })).not.toBe(KEY);
    expect(agentMailIngestKey({})).toBe('');
  });
  it('reads encoded subjects, where sign-up codes often are', () => {
    expect(decodeEncodedWords('=?UTF-8?B?WW91ciBjb2RlIGlzIDQ4MzkyMA==?=')).toBe('Your code is 483920');
    expect(decodeEncodedWords('=?iso-8859-1?Q?Caf=E9_code?= 12')).toBe('Café code 12');
    const parsed = parseRawMail(mime('x@y', '=?UTF-8?Q?V=C3=A9rification?=', 'Code: 271828', '<id-1@sender.test>'));
    expect(parsed).toMatchObject({ subject: 'Vérification', messageId: '<id-1@sender.test>' });
    expect(parsed.text.trim()).toBe('Code: 271828');
  });
});

describe('agent mail through the Email Worker', () => {
  let store: Store;
  let url = '';
  let close: (() => Promise<void>) | undefined;
  let worker: { email(message: unknown, env: unknown): Promise<void> };
  let workerEnv: { INGEST_URL: string; MAIL_DOMAIN: string; INGEST_SECRET: string };
  let tokens: TokenAuthority;
  let other: string;
  const saved = { domain: process.env.KARMAX_AGENT_MAIL_DOMAIN, auth: process.env.KARMAX_AUTH_SECRET };

  const agent = async (organizationId: string) => {
    const minted = await tokens.mint({ taskId: `task_${organizationId}`, profileId: 'do', principal: 'task:mail',
      organizationId, ceiling: ['credential:read'], grantorCaps: ['credential:read'] });
    return platformToolHandlers({} as any, {
      platformRequest: async (method: string, requestPath: string) => {
        const response = await fetch(`${url}${requestPath}`, { method, headers: { authorization: `Bearer ${minted.token}` } });
        const json = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(json));
        return json;
      },
      emit() {}, emitActivity() {},
    } as any);
  };
  const checkMail = async (organizationId: string, args: Record<string, unknown> = {}) =>
    JSON.parse(await (await agent(organizationId)).check_agent_mail!({ organization_id: organizationId, ...args }));
  const post = async (to: string, body: Uint8Array, signature?: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/agent-mail/ingest`, { method: 'POST', body, headers: { 'content-type': 'message/rfc822',
      [MAIL_TO_HEADER]: to, [MAIL_FROM_HEADER]: 'x@sender.test',
      [MAIL_SIGNATURE_HEADER]: signature ?? await signMail(KEY, to, 'x@sender.test', body), ...headers } });

  beforeAll(async () => {
    process.env.KARMAX_AUTH_SECRET = AUTH_SECRET;
    delete process.env.KARMAX_AGENT_MAIL_DOMAIN;
    store = await Store.create(':memory:');
    other = (await store.createOrganization({ name: 'Other' })).id;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-agent-mail-edge-'));
    tokens = new TokenAuthority();
    const gateway = await Gateway.create({ store, broker: new CredentialBroker(new Vault(path.join(home, 'vault'))), bus: new KarmaxBus(),
      tokens, contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any, api: {} as any,
      taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'agent mail edge test' }, worlds: new WorldRegistry() } as any);
    const running = await gateway.listen(await findFreePortFrom(48_700));
    url = running.url;
    close = running.close;
    // The bundle Cloudflare runs, not the source: web-standard code only.
    const code = await bundleMailEdge();
    expect(code).not.toMatch(/\bfrom\s*["']node:|\brequire\(/);
    worker = (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default;
    workerEnv = { INGEST_URL: `${url}/api/agent-mail/ingest`, MAIL_DOMAIN: DOMAIN, INGEST_SECRET: KEY };
  });

  afterAll(async () => {
    await close?.();
    for (const [name, value] of [['KARMAX_AGENT_MAIL_DOMAIN', saved.domain], ['KARMAX_AUTH_SECRET', saved.auth]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('upgrades a placeholder address to the mail domain, keeping its token, and keeps a bring-your-own inbox', async () => {
    const before = (await checkMail(other)).address;
    expect(before).toMatch(/^agent-[0-9a-f]{12}@agent\.local$/);
    // org_personal brought its own AgentMail inbox.
    await store.kvSet('agent-mail:provider:org_personal', JSON.stringify({ provider: 'agentmail',
      agentmailDomain: 'agentmail.test', agentmailAddress: 'owner-bot@agentmail.test' }));
    process.env.KARMAX_AGENT_MAIL_DOMAIN = DOMAIN;
    const after = await checkMail(other);
    expect(after.address).toBe(before.replace('@agent.local', `@${DOMAIN}`));
    expect(after.configured).toBe(true);
    expect((await checkMail('org_personal')).address).toBe('owner-bot@agentmail.test');
  });

  it('delivers what the Worker posts to the owning organization only, and check_agent_mail reads the code', async () => {
    const address = (await checkMail(other)).address;
    const raw = mime(address, '=?UTF-8?B?WW91ciBHaXRIdWIgY29kZQ==?=', 'Your verification code is 483920 https://github.test/verify?t=1');
    const { message, outcome } = inbound(address.toUpperCase(), raw);
    await worker.email(message, workerEnv);
    expect(outcome.rejected).toBeUndefined();
    const inbox = await checkMail(other, { match: 'github' });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ to: address, from: 'bounce+123@github.test', subject: 'Your GitHub code',
      code: '483920', link: 'https://github.test/verify?t=1' });
    expect((await checkMail('org_personal')).messages).toEqual([]);
  });

  it('files a retried delivery once', async () => {
    const address = (await checkMail(other)).address;
    const raw = mime(address, 'Retry', 'code 112233', '<retried@sender.test>');
    for (let i = 0; i < 2; i++) await worker.email(inbound(address, raw).message, workerEnv);
    expect((await checkMail(other, { match: 'retry' })).messages).toHaveLength(1);
  });

  it('drops mail for an address no organization owns, without saying whose addresses exist', async () => {
    const body = encoder.encode(mime(`agent-000000000000@${DOMAIN}`, 'Hi', 'code 999999'));
    const response = await post(`agent-000000000000@${DOMAIN}`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: false });
    // The Worker's key reaches only the installation's mail domain, never an
    // organization's own provider address.
    const byo = encoder.encode(mime('owner-bot@agentmail.test', 'Hi', 'code 999999'));
    expect(await (await post('owner-bot@agentmail.test', byo)).json()).toEqual({ delivered: false });
    expect((await checkMail('org_personal')).messages).toEqual([]);
  });

  it('refuses a delivery whose signature does not match', async () => {
    const address = (await checkMail(other)).address;
    const body = encoder.encode(mime(address, 'Forged', 'code 666666'));
    const forged = await signMail('not-the-key-not-the-key-not-the-key', address, 'x@sender.test', body);
    expect((await post(address, body, forged)).status).toBe(401);
    expect((await post(address, body, 't=1,v1=00')).status).toBe(401);
    // Signed for a different recipient.
    expect((await post(address, body, await signMail(KEY, `agent-111111111111@${DOMAIN}`, 'x@sender.test', body))).status).toBe(401);
    // A Worker holding the wrong key gets the same answer and keeps the message.
    await expect(worker.email(inbound(address, mime(address, 'Forged', 'code 666666')).message, { ...workerEnv, INGEST_SECRET: 'wrong' }))
      .rejects.toThrow(/did not take the message \(401\)/);
    expect((await checkMail(other, { match: 'forged' })).messages).toEqual([]);
  });

  it('enforces the size limit at both ends', async () => {
    const address = (await checkMail(other)).address;
    const big = new Uint8Array(AGENT_MAIL_MAX_BYTES + 1).fill(65);
    expect((await post(address, big)).status).toBe(413);
    const declared = inbound(address, 'small', AGENT_MAIL_MAX_BYTES + 1);
    await worker.email(declared.message, workerEnv);
    expect(declared.outcome.rejected).toBe('Message too large');
  });

  it('rejects, during SMTP, mail for anywhere but the mail domain', async () => {
    for (const to of ['someone@tavyausercontent.test', `x@sub.${DOMAIN}`, `x@${DOMAIN}.evil.test`]) {
      const { message, outcome } = inbound(to, mime(to, 'Hi', 'code 1'));
      await worker.email(message, { ...workerEnv, INGEST_URL: 'http://127.0.0.1:1/never-called' });
      expect(outcome.rejected, to).toBe('No such mailbox here');
    }
  });
});

describe('deploying the mail Worker', () => {
  const ACCOUNT = '35e42bcea7b0b9f09dce2860d587d418';
  it('uploads it with the webhook, the domain and the key as a Worker secret, and serves it on no URL', async () => {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const fake: typeof fetch = async (input, init) => {
      const pathName = String(input).replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers`, '');
      let body: any;
      if (init?.body instanceof FormData) body = { metadata: JSON.parse(await (init.body.get('metadata') as Blob).text()),
        module: await (init.body.get('worker.js') as Blob).text() };
      else if (typeof init?.body === 'string') body = JSON.parse(init.body);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cf-token');
      calls.push({ method: init?.method ?? 'GET', path: pathName, body });
      return Response.json({ success: true, result: {} });
    };
    const script = await deployMailEdge({ apiToken: 'cf-token', accountId: ACCOUNT, origin: 'https://tavya.io/',
      domain: 'Mail.TavyaUserContent.com', secret: KEY, fetch: fake });
    expect(script).toBe(MAIL_EDGE_SCRIPT);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`PUT /scripts/${MAIL_EDGE_SCRIPT}`, `POST /scripts/${MAIL_EDGE_SCRIPT}/subdomain`]);
    expect(calls[0]!.body.metadata.bindings).toEqual([
      { type: 'plain_text', name: 'INGEST_URL', text: 'https://tavya.io/api/agent-mail/ingest' },
      { type: 'plain_text', name: 'MAIL_DOMAIN', text: 'mail.tavyausercontent.com' },
      { type: 'secret_text', name: 'INGEST_SECRET', text: KEY },
    ]);
    expect(calls[0]!.body.module).toContain('async email(');
    expect(calls[1]!.body).toEqual({ enabled: false, previews_enabled: false });
  });
  it('refuses without a key or a real domain', async () => {
    const options = { apiToken: 't', accountId: ACCOUNT, origin: 'https://tavya.io', fetch: (() => { throw new Error('called'); }) as any };
    await expect(deployMailEdge({ ...options, domain: DOMAIN, secret: '' })).rejects.toThrow(/no auth secret/);
    await expect(deployMailEdge({ ...options, domain: 'not a domain', secret: KEY })).rejects.toThrow(/not a mail domain/);
  });
});
