import { expect, it, vi } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';
import { policyVersions } from '../src/launch/legal.js';

it('reuses passwordless sessions and bounds authenticated legacy sessions (#18)', async () => {
  const h = await stubGateway();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, async () => (await (await fetch(`${h.base}/api/session`)).json()) as any));
    expect(new Set(results.map(r => r.token)).size).toBe(1);
    for (let n = 0; n < 140; n++) await (h.gateway as any).newSession();
    expect((h.gateway as any).sessions.size).toBeLessThanOrEqual(128);
  } finally { await h.close(); }
});

it('uses cookies or headers, never general bearer tokens in URLs (#19)', async () => {
  const h = await stubGateway();
  try {
    const response = await fetch(`${h.base}/api/session`);
    const { token } = await response.json() as any;
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    const req = { headers: {} };
    expect(await (h.gateway as any).socketAuth(req, new URL(`http://localhost/ws?token=${token}`))).toBeUndefined();
    expect((await fetch(`${h.base}/api/attachments/missing?token=${token}`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/projects`, { headers: { cookie: cookie!.split(';')[0]! } })).status).toBe(200);
  } finally { await h.close(); }
});

it('marks policy cookies Secure on an HTTPS self-host (GW-10)', async () => {
  vi.stubEnv('KARMAX_PUBLIC_URL', 'https://self.example');
  const h = await stubGateway();
  try {
    const response = await fetch(`${h.base}/api/legal/preaccept`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: true, versions: policyVersions('signup') }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('; Secure');
  } finally { await h.close(); vi.unstubAllEnvs(); }
});
