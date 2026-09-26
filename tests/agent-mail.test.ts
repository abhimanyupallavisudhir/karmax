import { memoryTransaction } from './helpers/memory-transaction.js';
import { describe, it, expect } from 'vitest';
import {
  AgentMail,
  extractCode,
  extractLink,
  cleanAddress,
  normalizeInbound,
  extractMimeText,
  decodeQuotedPrintable,
  parseMultipart,
  parseUrlEncoded,
  ingestSecret,
  ingestScope,
  cloudflareWorkerScript,
  type AgentMailStore,
} from '../src/autonomy/agent-mail.js';

function memStore(): AgentMailStore {
  const kv = new Map<string, string>();
  return { transaction: memoryTransaction(kv), kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v) };
}

describe('agent mail code/link extraction (§8)', () => {
  it('prefers a labelled code, then a 6-digit block', () => {
    expect(extractCode('Your verification code is 483920', '')).toBe('483920');
    expect(extractCode(undefined, 'Enter code: AB12CD to continue')).toBe('AB12CD');
    expect(extractCode('Welcome', 'Your one-time code 224466 expires soon')).toBe('224466');
    expect(extractCode('Login', 'no code here')).toBeUndefined();
  });
  it('extracts a verification link', () => {
    expect(extractLink('Click https://site.com/verify?t=abc to confirm')).toBe('https://site.com/verify?t=abc');
    expect(extractLink('visit https://site.com/home or https://site.com/confirm/9')).toBe('https://site.com/confirm/9');
    expect(extractLink('no links')).toBeUndefined();
  });
});

describe('AgentMail inbox (per-organization tenancy)', () => {
  it('mints one stable address per organization (agent.local without a domain)', async () => {
    const store = memStore();
    const mail = new AgentMail(store);
    const a = (await mail.address('org_a'));
    const b = (await mail.address('org_b'));
    expect(a).toMatch(/^agent-[0-9a-f]{12}@agent\.local$/);
    expect((await mail.address('org_a'))).toBe(a); // stable
    expect(b).not.toBe(a); // distinct per tenant
    expect(mail.configured()).toBe(false);
    expect(new AgentMail(store, 'agents.example.com').configured()).toBe(true);
  });

  it('routes ingest by recipient and keeps tenants isolated', async () => {
    const mail = new AgentMail(memStore());
    const a = (await mail.address('org_a'));
    const b = (await mail.address('org_b'));
    expect((await mail.ingest({ from: 'noreply@github.com', to: a, subject: 'Confirm', text: 'code 112233\nhttps://github.com/verify/x' })).delivered).toBe(true);
    expect((await mail.ingest({ from: 'noreply@vercel.com', to: b, subject: 'Welcome', text: 'code 445566' })).delivered).toBe(true);
    // subaddress tags route to the base mailbox
    expect((await mail.ingest({ from: 'x@y.com', to: a.replace('@', '+github@'), text: 'tagged' })).delivered).toBe(true);
    // unknown recipients are dropped, not leaked into any tenant
    expect((await mail.ingest({ from: 'x@y.com', to: 'stranger@agent.local', text: 'code 999999' })).delivered).toBe(false);

    const inboxA = (await mail.recent('org_a'));
    const inboxB = (await mail.recent('org_b'));
    expect(inboxA.map((m) => m.from)).toEqual(['x@y.com', 'noreply@github.com']);
    expect(inboxB.map((m) => m.from)).toEqual(['noreply@vercel.com']);
    expect(inboxA.find((m) => m.from.includes('github'))!.code).toBe('112233');
    expect(inboxB[0]!.code).toBe('445566');
    // no cross-tenant visibility in either direction
    expect(JSON.stringify(inboxA)).not.toContain('445566');
    expect(JSON.stringify(inboxB)).not.toContain('112233');
  });

  it('domain-free hosted path: orgs ride +tags on one fixed provider address', async () => {
    const store = memStore();
    const mail = new AgentMail(store, 'inbound.postmarkapp.com', 'ab12cd');
    const a = (await mail.address('org_a'));
    expect(a).toMatch(/^ab12cd\+agent-[0-9a-f]{12}@inbound\.postmarkapp\.com$/);
    // Only the exact mailbox is owned; a rewritten base is a different address.
    expect((await mail.ownerOf(a))).toBe('org_a');
    expect((await mail.ownerOf(a.replace('ab12cd+', 'whatever+')))).toBeUndefined();
    expect((await mail.ingest({ from: 'x@y.com', to: a, text: 'code 123456' })).delivered).toBe(true);
  });

  it('provider switch migrates the address, preserving the org token', async () => {
    const store = memStore();
    const before = (await new AgentMail(store, undefined).address('org_a'));
    const token = before.match(/agent-[0-9a-f]+/)![0];
    const after = (await new AgentMail(store, 'agents.myco.com').address('org_a'));
    expect(after).toBe(`${token}@agents.myco.com`);
    const fixed = (await new AgentMail(store, 'inbound.svc.com', 'base1').address('org_a'));
    expect(fixed).toBe(`base1+${token}@inbound.svc.com`);
    // Retired addresses no longer route to the organization.
    expect((await new AgentMail(store).ownerOf(before))).toBeUndefined();
    expect((await new AgentMail(store).ownerOf(fixed))).toBe('org_a');
  });

  it('filters by match and since', async () => {
    const mail = new AgentMail(memStore());
    const a = (await mail.address('org_a'));
    (await mail.ingest({ from: 'noreply@github.com', to: a, text: 'one', receivedAt: 1000 }));
    (await mail.ingest({ from: 'noreply@vercel.com', to: a, text: 'two', receivedAt: 2000 }));
    expect((await mail.recent('org_a', { match: 'github' }))).toHaveLength(1);
    expect((await mail.recent('org_a', { since: 1500 })).map((m) => m.from)).toEqual(['noreply@vercel.com']);
  });
});

describe('inbound payload normalization (meet providers where they are)', () => {
  it('recognizes Postmark, CloudMailin, Mailgun, SendGrid, and our own JSON', () => {
    expect(normalizeInbound({ To: 'a@b.c', FromFull: { Email: 'x@y.z' }, Subject: 'Hi', TextBody: 'code 111222' }))
      .toEqual({ to: 'a@b.c', from: 'x@y.z', subject: 'Hi', text: 'code 111222' });
    expect(normalizeInbound({ envelope: { to: 'a@b.c', from: 'x@y.z' }, headers: { subject: 'Hi' }, plain: 'hello' }).text).toBe('hello');
    expect(normalizeInbound({ recipient: 'a@b.c', sender: 'x@y.z', subject: 'Hi', 'body-plain': 'hey' }).to).toBe('a@b.c');
    expect(normalizeInbound({ to: 'a@b.c', from: 'x@y.z', subject: 'Hi', text: 'plain' }).text).toBe('plain');
  });
  it('falls back to stripped HTML when no plain body exists', () => {
    expect(normalizeInbound({ To: 'a@b.c', From: 'x@y.z', HtmlBody: '<p>Your code is <b>987654</b></p>' }).text).toContain('987654');
  });
  it('cleanAddress extracts the address from display forms', () => {
    expect(cleanAddress('GitHub <noreply@github.com>')).toBe('noreply@github.com');
    expect(cleanAddress('plain@addr.com')).toBe('plain@addr.com');
  });
});

describe('raw MIME extraction (the Cloudflare Email Worker path)', () => {
  it('decodes quoted-printable and picks the text/plain part of a multipart message', () => {
    const raw = [
      'From: noreply@github.com', 'To: agent-ab@x.co', 'Subject: Verify', 'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="BB"', '',
      '--BB', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
      'Your code is 445566 =E2=80=94 enter it now.', '',
      '--BB', 'Content-Type: text/html', '', '<p>ignored html</p>', '--BB--', '',
    ].join('\r\n');
    const msg = normalizeInbound({ to: 'agent-ab@x.co', from: 'noreply@github.com', subject: 'Verify', text: raw });
    expect(msg.text).toContain('445566');
    expect(msg.text).not.toContain('ignored html');
  });
  it('decodes base64 bodies', () => {
    const body = Buffer.from('secret code 778899').toString('base64');
    const raw = `Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`;
    expect(extractMimeText(raw)).toContain('778899');
  });
  it('quoted-printable soft breaks and =XX escapes', () => {
    expect(decodeQuotedPrintable('one=\r\ntwo =3D three')).toBe('onetwo = three');
  });
});

describe('webhook body parsers + secret + worker script', () => {
  it('parses urlencoded and multipart form posts into fields', () => {
    expect(parseUrlEncoded('recipient=a%40b.c&sender=x%40y.z&subject=Hi&body-plain=code+123')['body-plain']).toBe('code 123');
    const mp = [
      '--XX', 'Content-Disposition: form-data; name="to"', '', 'a@b.c',
      '--XX', 'Content-Disposition: form-data; name="text"', '', 'code 456789',
      '--XX', 'Content-Disposition: form-data; name="file"; filename="x.eml"', '', 'IGNORED',
      '--XX--', '',
    ].join('\r\n');
    const fields = parseMultipart(mp, 'multipart/form-data; boundary=XX');
    expect(fields.to).toBe('a@b.c');
    expect(fields.text).toBe('code 456789');
    expect(fields.file).toBeUndefined();
  });
  it('mints a stable per-organization ingest secret that only reaches that organization', async () => {
    const store = memStore();
    const s = (await ingestSecret(store, 'org_a'));
    expect(s.length).toBeGreaterThan(15);
    expect((await ingestSecret(store, 'org_a'))).toBe(s);
    expect((await ingestSecret(store, 'org_b'))).not.toBe(s);
    expect((await ingestScope(store, s))).toEqual({ organizationId: 'org_a' });
    expect((await ingestScope(store, 'nope'))).toBeUndefined();
    expect((await ingestScope(store, undefined))).toBeUndefined();
    // the installation-wide secret earlier releases minted keeps working, for every organization
    (await store.kvSet('agent-mail:secret', 'legacy-secret'));
    expect((await ingestScope(store, 'legacy-secret'))).toEqual({});
    expect((await ingestScope(store, 'env-secret', 'env-secret'))).toEqual({});
    // a message for org_b's address is dropped when delivered with org_a's secret
    const mail = new AgentMail(store);
    const b = (await mail.address('org_b'));
    expect((await mail.ingest({ from: 'x@y.z', to: b, text: 'code 123456' }, 'org_a')).delivered).toBe(false);
    expect((await mail.ingest({ from: 'x@y.z', to: b, text: 'code 123456' }, 'org_b')).delivered).toBe(true);
    expect((await mail.ingest({ from: 'x@y.z', to: b, text: 'code 654321' })).delivered).toBe(true);
  });
  it('the Cloudflare worker script embeds the full webhook URL and relays raw MIME', () => {
    const script = cloudflareWorkerScript('https://kx.example/api/agent-mail/ingest?secret=abc');
    expect(script).toContain('secret=abc');
    expect(script).toContain('message.raw');
    expect(script).toContain('async email(message');
  });
});


describe('mail ownership boundaries (AU-1)', () => {
  it('refuses a second tenant claiming an exact address', async () => {
    const store = memStore();
    const mail = new AgentMail(store, undefined, undefined, 'shared@example.com');
    await mail.address('org_a');
    await expect(mail.address('org_b')).rejects.toThrow(/owned/);
    expect(await mail.ownerOf('shared@example.com')).toBe('org_a');
  });
  it('does not route the same local part on a foreign domain or a rewritten base', async () => {
    const store = memStore();
    const mail = new AgentMail(store, 'example.com', 'base');
    const address = await mail.address('org_a');
    expect(await mail.ownerOf(address.replace('@example.com', '@evil.com'))).toBeUndefined();
    expect(await mail.ownerOf(address.replace('base+', 'other+'))).toBeUndefined();
  });
  it('retires the old route when the provider changes', async () => {
    const store = memStore();
    const old = await new AgentMail(store, 'old.example').address('org_a');
    await new AgentMail(store, 'new.example').address('org_a');
    expect(await new AgentMail(store).ownerOf(old)).toBeUndefined();
  });
});

it('bounds stored mail bodies and total inbox bytes (AU-6)', async () => {
  const store = memStore();
  const mail = new AgentMail(store);
  const to = await mail.address('org_a');
  for (let i = 0; i < 70; i++) await mail.ingest({ to, from: 'a@example.com', text: 'x'.repeat(100_000), subject: 's'.repeat(100_000) });
  const raw = await store.kvGet('agent-mail:messages:org_a');
  expect(Buffer.byteLength(raw!)).toBeLessThanOrEqual(1_048_576);
  expect((await mail.recent('org_a'))[0]!.text.length).toBeLessThanOrEqual(16_384);
});
