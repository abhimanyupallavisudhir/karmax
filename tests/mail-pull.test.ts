import { describe, it, expect } from 'vitest';
import { ImapPuller, AgentMailPuller, MailPoller, createPuller, type PullStore, type ImapConn } from '../src/autonomy/mail-pull.js';
import { ImapMailboxProvider, AgentMailboxProvider, guessImapHost, type MailboxConfig } from '../src/autonomy/mailbox.js';
import { AgentMail } from '../src/autonomy/agent-mail.js';

function store(seed: Record<string, string> = {}): PullStore & { kv: Map<string, string>; orgs: { id: string }[] } {
  const kv = new Map<string, string>(Object.entries(seed));
  const orgs: { id: string }[] = [];
  return { kv, orgs, kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v), appendAudit: () => 0 };
}

describe('mailbox pull providers: connect', () => {
  it('IMAP connect validates + guesses the host', () => {
    const p = new ImapMailboxProvider();
    expect(p.connect({ address: 'x@gmail.com' }).status).toBe('unavailable'); // no password
    const ok = p.connect({ address: 'Agent@Gmail.com', apiKey: 'app-pass' });
    expect(ok.status).toBe('connected');
    expect(ok.config).toMatchObject({ provider: 'imap', fixedAddress: 'agent@gmail.com', imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'agent@gmail.com' } });
    expect(guessImapHost('a@fastmail.com')).toBe('imap.fastmail.com');
    expect(p.pull).toBe(true);
  });
  it('AgentMail connect needs an inbox address and key', () => {
    const p = new AgentMailboxProvider();
    expect(p.connect({ apiKey: 'k' }).status).toBe('unavailable');
    const ok = p.connect({ apiKey: 'k', domain: 'Inbox@AgentMail.to' });
    expect(ok.config).toEqual({
      provider: 'agentmail',
      agentmailDomain: 'agentmail.to',
      agentmailAddress: 'inbox@agentmail.to',
    });
    expect(p.pull).toBe(true);
  });
});

describe('ImapPuller', () => {
  const config: MailboxConfig = { provider: 'imap', apiKeyHandle: 'mailbox:imap:org_a:auth', fixedAddress: 'agent@gmail.com', imap: { host: 'imap.gmail.com', port: 993, user: 'agent@gmail.com', secure: true } };
  const raw = (uid: number, to: string, code: string) => ({ uid, source:
    `Delivered-To: ${to}\r\nFrom: GitHub <noreply@github.com>\r\nTo: ${to}\r\nSubject: Verify\r\nContent-Type: text/plain\r\n\r\nYour code is ${code}\r\n` });

  it('fetches since the stored UID, routes by Delivered-To, advances the cursor', async () => {
    const s = store();
    // one org with a +tag address on the mailbox
    const mail = new AgentMail(s as any, 'gmail.com', 'agent');
    s.orgs.push({ id: 'org_a' });
    const addr = mail.address('org_a'); // agent+agent-<tok>@gmail.com
    const conn: ImapConn = { fetchSince: async (last) => [raw(5, addr, '111222'), raw(6, addr, '333444')].filter((m) => m.uid > last), close: async () => {} };
    const puller = new ImapPuller(config, {
      store: s, organizationId: 'org_a', resolveSecret: (h) => (h === config.apiKeyHandle ? 'app-pass' : undefined),
      ingest: (m) => mail.ingest(m), openImap: async () => conn,
    });
    expect(await puller.poll()).toBe(2);
    expect(s.kvGet('agent-mail:imap-uid:org_a')).toBe('6');
    expect(mail.recent('org_a').map((m) => m.code)).toContain('111222');
    // a second poll starts after uid 6 → nothing new
    conn.fetchSince = async (last) => [raw(6, addr, '333444')].filter((m) => m.uid > last);
    expect(await puller.poll()).toBe(0);
  });

  it('returns 0 (no crash) when no password is stored', async () => {
    const puller = new ImapPuller(config, { store: store(), resolveSecret: () => undefined, ingest: () => ({ delivered: true }) });
    expect(await puller.poll()).toBe(0);
  });
});

describe('AgentMailPuller', () => {
  const config: MailboxConfig = {
    provider: 'agentmail',
    agentmailDomain: 'agentmail.to',
    agentmailAddress: 'inbox@agentmail.to',
    apiKeyHandle: 'mailbox:agentmail:org_a:auth',
  };
  it('lists the organization inbox, routes messages, and advances the timestamp cursor', async () => {
    const s = store();
    const mail = new AgentMail(s as any, 'agentmail.to', undefined, config.agentmailAddress);
    s.orgs.push({ id: 'org_a' });
    const addr = mail.address('org_a');
    const calls: string[] = [];
    const fetchFn: any = async (url: string, init: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/messages')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ messages: [{ message_id: 'm1', timestamp: '2026-07-25T12:00:00Z', from: 'noreply@github.com', to: [addr], subject: 'Verify', text: 'code 909090' }] }) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
    };
    const puller = new AgentMailPuller(config, { store: s, organizationId: 'org_a', resolveSecret: (h) => (h === config.apiKeyHandle ? 'am-key' : undefined), ingest: (m) => mail.ingest(m), fetchFn });
    expect(await puller.poll()).toBe(1);
    expect(calls.some((c) => c.includes(`/inboxes/${encodeURIComponent(addr)}/messages`))).toBe(true);
    expect(mail.recent('org_a')[0]!.code).toBe('909090');
    expect(s.kvGet(`agent-mail:am-cursor:${addr}`)).toBe('2026-07-25T12:00:00Z');
    calls.length = 0;
    await puller.poll();
    expect(calls.some((c) => c.includes('after=2026-07-25T12%3A00%3A00Z'))).toBe(true);
  });
});

describe('MailPoller loop', () => {
  it('is inert for push providers and delivers for pull providers; never throws', async () => {
    const s = store();
    const poller = (config: MailboxConfig, ingestCount: { n: number }, fail = false) => new MailPoller({
      store: s,
      readConfigs: () => [{ organizationId: 'org_a', config }],
      resolveSecret: () => 'secret',
      makeIngest: () => (_m) => { if (fail) throw new Error('boom'); ingestCount.n++; return { delivered: true }; },
    });
    // push provider → createPuller returns undefined → 0
    expect(await poller({ provider: 'self-managed', domain: 'x.com' }, { n: 0 }).sweep()).toBe(0);
    // a provider whose poll throws is caught and audited, not thrown
    const c = { n: 0 };
    await expect((async () => poller({ provider: 'imap', fixedAddress: 'a@b.com', imap: { host: 'h', port: 993, user: 'a@b.com', secure: true } }, c, true).sweep())()).resolves.toBeTypeOf('number');
  });
  it('createPuller picks the right backend', () => {
    const deps = { store: store(), resolveSecret: () => undefined, ingest: () => ({ delivered: false }) };
    expect(createPuller({ provider: 'imap', apiKeyHandle: 'imap-key', imap: { host: 'h', port: 993, user: 'u', secure: true }, fixedAddress: 'a@b.com' }, deps)).toBeInstanceOf(ImapPuller);
    expect(createPuller({ provider: 'agentmail', apiKeyHandle: 'am-key', agentmailDomain: 'agentmail.to', agentmailAddress: 'x@agentmail.to' }, deps)).toBeInstanceOf(AgentMailPuller);
    expect(createPuller({ provider: 'self-managed', domain: 'x.com' }, deps)).toBeUndefined();
  });
});
