import { describe, it, expect } from 'vitest';
import { AgentMail, extractCode, extractLink, type AgentMailStore } from '../src/autonomy/agent-mail.js';

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

  it('filters by match and since', () => {
    const mail = new AgentMail(memStore());
    const a = mail.address('org_a');
    mail.ingest({ from: 'noreply@github.com', to: a, text: 'one', receivedAt: 1000 });
    mail.ingest({ from: 'noreply@vercel.com', to: a, text: 'two', receivedAt: 2000 });
    expect(mail.recent('org_a', { match: 'github' })).toHaveLength(1);
    expect(mail.recent('org_a', { since: 1500 }).map((m) => m.from)).toEqual(['noreply@vercel.com']);
  });
});
