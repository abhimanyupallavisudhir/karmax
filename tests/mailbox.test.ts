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

  it('hosted: a domain OR a single fixed address connects; API key is optional', () => {
    const p = new HostedMailboxProvider();
    expect(p.connect({ apiKey: 'k' }).status).toBe('unavailable'); // needs the address/domain
    const dom = p.connect({ domain: 'Mail.Karmax.App' });
    expect(dom.status).toBe('connected');
    expect(dom.config).toEqual({ provider: 'hosted', hostedDomain: 'mail.karmax.app', fixedAddress: undefined });
    // the domain-free path: the ONE inbound address the service issued
    const fixed = p.connect({ domain: 'AB12cd@inbound.postmarkapp.com' });
    expect(fixed.status).toBe('connected');
    expect(fixed.config).toEqual({ provider: 'hosted', hostedDomain: 'inbound.postmarkapp.com', fixedAddress: 'ab12cd@inbound.postmarkapp.com' });
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
