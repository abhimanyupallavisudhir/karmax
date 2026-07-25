import { describe, it, expect, afterEach } from 'vitest';
import { defaultMailboxRegistry, SelfManagedDomainProvider, HostedMailboxProvider } from '../src/autonomy/mailbox.js';
import { AgentMail, type AgentMailStore } from '../src/autonomy/agent-mail.js';

function memStore(): AgentMailStore {
  const kv = new Map<string, string>();
  return { kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v) };
}

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe('mailbox providers (§8: connect once, not an env var)', () => {
  it('self-managed: validates and stores a domain, forms the mint domain', () => {
    const p = new SelfManagedDomainProvider();
    expect(p.connect({ domain: 'not a domain' }).status).toBe('unavailable');
    const ok = p.connect({ domain: 'Agents.MyCo.com' });
    expect(ok.status).toBe('connected');
    expect(ok.config).toEqual({ provider: 'self-managed', domain: 'agents.myco.com' });
    expect(p.domainFor({ provider: 'self-managed', domain: 'agents.myco.com' })).toBe('agents.myco.com');
    expect(p.describe({ domain: 'agents.myco.com' }).connected).toBe(true);
  });

  it('hosted: operator enters both the domain and the API key (no env var)', () => {
    const p = new HostedMailboxProvider();
    expect(p.connect({ apiKey: 'k' }).status).toBe('unavailable'); // needs a domain
    expect(p.connect({ domain: 'mail.karmax.app' }).status).toBe('unavailable'); // needs the key
    const ok = p.connect({ domain: 'Mail.Karmax.App', apiKey: 'secret-key' });
    expect(ok.status).toBe('connected');
    expect(ok.config).toEqual({ provider: 'hosted', hostedDomain: 'mail.karmax.app' });
    expect(p.domainFor({ provider: 'hosted', hostedDomain: 'mail.karmax.app' })).toBe('mail.karmax.app');
  });

  it('registry reports the active provider domain', () => {
    delete process.env.KARMAX_AGENT_MAIL_DOMAIN;
    const r = defaultMailboxRegistry();
    expect(r.activeDomain({})).toBeUndefined();
    expect(r.activeDomain({ provider: 'self-managed', domain: 'x.com' })).toBe('x.com');
    expect(r.list({}).map((p) => p.name).sort()).toEqual(['hosted', 'self-managed']);
  });
});

describe('AgentMail address upgrades when a domain is connected later', () => {
  it('a placeholder @agent.local address upgrades to the real domain, same local part', () => {
    const store = memStore();
    // org first reads its address before any provider is connected
    const before = new AgentMail(store, undefined).address('org_a');
    expect(before).toMatch(/@agent\.local$/);
    const local = before.split('@')[0];
    // operator connects a domain; the same org now sees the upgraded address
    const after = new AgentMail(store, 'agents.myco.com').address('org_a');
    expect(after).toBe(`${local}@agents.myco.com`);
    // reverse route still points at the org (so inbound mail still lands)
    const mail = new AgentMail(store, 'agents.myco.com');
    expect(mail.ownerOf(after)).toBe('org_a');
    // a real domain is never downgraded back to the placeholder
    expect(new AgentMail(store, undefined).address('org_a')).toBe(after);
  });
});
