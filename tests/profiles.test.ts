import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';

describe('profile + account management (Global settings backend)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const J = (r: Response) => r.json() as Promise<any>;

  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway();
    base = gw.url;
    token = ((await (await fetch(`${base}/api/session`)).json()) as any).token;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('edits a role profile and reflects it back', async () => {
    const updated = await fetch(`${base}/api/profiles`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ id: 'do-default', name: 'Do agent', role: 'do', provider: 'codex', model: 'gpt-4.1', effort: 'high', capabilities: ['signal-completion'], maxTurns: 30 }),
    }).then(J);
    expect(updated.provider).toBe('codex');
    expect(updated.model).toBe('gpt-4.1');
    const list = await fetch(`${base}/api/profiles`, { headers: auth() }).then(J);
    const p = list.find((x: any) => x.id === 'do-default');
    expect(p.effort).toBe('high');
    expect(p.maxTurns).toBe(30);
  });

  it('registers an API key as a handle and lists it (no secret leaks)', async () => {
    const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'codex', account: 'work', apiKey: 'sk-super-secret' }) }).then(J);
    expect(r.handle).toBe('codex:work');
    const accounts = await fetch(`${base}/api/accounts`, { headers: auth() }).then(J);
    expect(accounts.handles).toContain('codex:work');
    expect(JSON.stringify(accounts)).not.toContain('sk-super-secret'); // secret never returned
  });

  it('rejects a profile without id/role', async () => {
    const res = await fetch(`${base}/api/profiles`, { method: 'PUT', headers: auth(), body: JSON.stringify({ provider: 'claude' }) });
    expect(res.status).toBe(400);
  });
});
