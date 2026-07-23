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

describe('AgentMail inbox', () => {
  it('mints a stable address (agent.local without a configured domain)', () => {
    const store = memStore();
    const mail = new AgentMail(store);
    const a = mail.address();
    expect(a).toMatch(/^agent-[0-9a-f]{8}@agent\.local$/);
    expect(mail.address()).toBe(a); // stable
    expect(mail.configured()).toBe(false);
    expect(new AgentMail(store, 'agents.example.com').configured()).toBe(true);
  });

  it('ingests messages with extracted code/link and reads them newest-first', () => {
    const mail = new AgentMail(memStore());
    const addr = mail.address();
    mail.ingest({ from: 'noreply@github.com', to: addr, subject: 'Confirm', text: 'code 112233\nhttps://github.com/verify/x', receivedAt: 1000 });
    mail.ingest({ from: 'noreply@vercel.com', to: addr, subject: 'Welcome', text: 'nothing useful', receivedAt: 2000 });
    const recent = mail.recent();
    expect(recent[0]!.from).toBe('noreply@vercel.com'); // newest first
    const gh = recent.find((m) => m.from.includes('github'))!;
    expect(gh.code).toBe('112233');
    expect(gh.link).toContain('/verify/');
    expect(mail.recent({ match: 'github' })).toHaveLength(1);
    expect(mail.recent({ since: 1500 }).map((m) => m.from)).toEqual(['noreply@vercel.com']);
  });
});
