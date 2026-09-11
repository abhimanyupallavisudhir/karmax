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
  return { kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v) };
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
  it('mints one stable address per organization (agent.local without a domain)', () => {
    const store = memStore();
    const mail = new AgentMail(store);
    const a = mail.address('org_a');
    const b = mail.address('org_b');
    expect(a).toMatch(/^agent-[0-9a-f]{12}@agent\.local$/);
    expect(mail.address('org_a')).toBe(a); // stable
    expect(b).not.toBe(a); // distinct per tenant
    expect(mail.configured()).toBe(false);
    expect(new AgentMail(store, 'agents.example.com').configured()).toBe(true);
  });

  it('routes ingest by recipient and keeps tenants isolated', () => {
    const mail = new AgentMail(memStore());
    const a = mail.address('org_a');
    const b = mail.address('org_b');
    expect(mail.ingest({ from: 'noreply@github.com', to: a, subject: 'Confirm', text: 'code 112233\nhttps://github.com/verify/x' }).delivered).toBe(true);
    expect(mail.ingest({ from: 'noreply@vercel.com', to: b, subject: 'Welcome', text: 'code 445566' }).delivered).toBe(true);
    // subaddress tags route to the base mailbox
    expect(mail.ingest({ from: 'x@y.com', to: a.replace('@', '+github@'), text: 'tagged' }).delivered).toBe(true);
    // unknown recipients are dropped, not leaked into any tenant
    expect(mail.ingest({ from: 'x@y.com', to: 'stranger@agent.local', text: 'code 999999' }).delivered).toBe(false);

    const inboxA = mail.recent('org_a');
    const inboxB = mail.recent('org_b');
    expect(inboxA.map((m) => m.from)).toEqual(['x@y.com', 'noreply@github.com']);
    expect(inboxB.map((m) => m.from)).toEqual(['noreply@vercel.com']);
    expect(inboxA.find((m) => m.from.includes('github'))!.code).toBe('112233');
    expect(inboxB[0]!.code).toBe('445566');
    // no cross-tenant visibility in either direction
    expect(JSON.stringify(inboxA)).not.toContain('445566');
    expect(JSON.stringify(inboxB)).not.toContain('112233');
  });

  it('domain-free hosted path: orgs ride +tags on one fixed provider address', () => {
    const store = memStore();
    const mail = new AgentMail(store, 'inbound.postmarkapp.com', 'ab12cd');
    const a = mail.address('org_a');
    expect(a).toMatch(/^ab12cd\+agent-[0-9a-f]{12}@inbound\.postmarkapp\.com$/);
    // routes on the exact local, and on the tag alone (provider may rewrite base)
    expect(mail.ownerOf(a)).toBe('org_a');
    expect(mail.ownerOf(a.replace('ab12cd+', 'whatever+'))).toBe('org_a');
    expect(mail.ingest({ from: 'x@y.com', to: a, text: 'code 123456' }).delivered).toBe(true);
  });

  it('provider switch migrates the address, preserving the org token', () => {
    const store = memStore();
    const before = new AgentMail(store, undefined).address('org_a');
    const token = before.match(/agent-[0-9a-f]+/)![0];
    const after = new AgentMail(store, 'agents.myco.com').address('org_a');
    expect(after).toBe(`${token}@agents.myco.com`);
    const fixed = new AgentMail(store, 'inbound.svc.com', 'base1').address('org_a');
    expect(fixed).toBe(`base1+${token}@inbound.svc.com`);
    // mail addressed to ANY historical form still routes to the org
    expect(new AgentMail(store).ownerOf(before)).toBe('org_a');
    expect(new AgentMail(store).ownerOf(fixed)).toBe('org_a');
  });

  it('filters by match and since', () => {
    const mail = new AgentMail(memStore());
    const a = mail.address('org_a');
    mail.ingest({ from: 'noreply@github.com', to: a, text: 'one', receivedAt: 1000 });
    mail.ingest({ from: 'noreply@vercel.com', to: a, text: 'two', receivedAt: 2000 });
    expect(mail.recent('org_a', { match: 'github' })).toHaveLength(1);
    expect(mail.recent('org_a', { since: 1500 }).map((m) => m.from)).toEqual(['noreply@vercel.com']);
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
  it('mints a stable per-organization ingest secret that only reaches that organization', () => {
    const store = memStore();
    const s = ingestSecret(store, 'org_a');
    expect(s.length).toBeGreaterThan(15);
    expect(ingestSecret(store, 'org_a')).toBe(s);
    expect(ingestSecret(store, 'org_b')).not.toBe(s);
    expect(ingestScope(store, s)).toEqual({ organizationId: 'org_a' });
    expect(ingestScope(store, 'nope')).toBeUndefined();
    expect(ingestScope(store, undefined)).toBeUndefined();
    // the installation-wide secret earlier releases minted keeps working, for every organization
    store.kvSet('agent-mail:secret', 'legacy-secret');
    expect(ingestScope(store, 'legacy-secret')).toEqual({});
    expect(ingestScope(store, 'env-secret', 'env-secret')).toEqual({});
    // a message for org_b's address is dropped when delivered with org_a's secret
    const mail = new AgentMail(store);
    const b = mail.address('org_b');
    expect(mail.ingest({ from: 'x@y.z', to: b, text: 'code 123456' }, 'org_a').delivered).toBe(false);
    expect(mail.ingest({ from: 'x@y.z', to: b, text: 'code 123456' }, 'org_b').delivered).toBe(true);
    expect(mail.ingest({ from: 'x@y.z', to: b, text: 'code 654321' }).delivered).toBe(true);
  });
  it('the Cloudflare worker script embeds the full webhook URL and relays raw MIME', () => {
    const script = cloudflareWorkerScript('https://kx.example/api/agent-mail/ingest?secret=abc');
    expect(script).toContain('secret=abc');
    expect(script).toContain('message.raw');
    expect(script).toContain('async email(message');
  });
});
