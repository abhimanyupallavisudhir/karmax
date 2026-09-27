import { afterEach, expect, it, vi } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';

afterEach(() => vi.unstubAllEnvs());

it('trusts only the configured proxy peer, rejects chains, and groups IPv6 by /64 (CI-8)', async () => {
  vi.stubEnv('KARMAX_TRUSTED_PROXY_IP', '172.30.0.1');
  const h = await stubGateway({ hosted: true });
  try {
    const address = (peer: string, header: string) => (h.gateway as any).clientAddress({
      socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': header },
    });
    expect(address('198.51.100.5', '203.0.113.2')).toBe('198.51.100.5');
    expect(address('::ffff:172.30.0.1', '203.0.113.2')).toBe('203.0.113.2');
    expect(address('172.30.0.1', '203.0.113.2, 192.0.2.4')).toBe('172.30.0.1');
    expect(address('172.30.0.1', 'garbage')).toBe('172.30.0.1');
    expect(address('172.30.0.1', '2001:db8:1234:abcd::1')).toBe(address('172.30.0.1', '2001:0db8:1234:abcd:ffff::2'));
    expect(address('172.30.0.1', '2001:db8:1234:abce::1')).not.toBe(address('172.30.0.1', '2001:db8:1234:abcd::1'));
    vi.stubEnv('KARMAX_TRUSTED_PROXY_IP', '');
    expect(address('172.30.0.1', '203.0.113.2')).toBe('172.30.0.1');
  } finally { await h.close(); }
});

it('shares login lockout and request budgets within a /64 but isolates other clients (CI-8)', async () => {
  vi.stubEnv('KARMAX_TRUSTED_PROXY_IP', '127.0.0.1');
  const h = await stubGateway({ hosted: true });
  (h.gateway as any).deps.identity = { signIn: async () => new Response('', { status: 401 }) };
  try {
    const login = (ip: string) => fetch(`${h.base}/api/login`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{"password":"wrong"}' });
    for (let n = 0; n < 12; n++) await login(`2001:db8:1::${n}`);
    expect((await login('2001:db8:1::ff')).status).toBe(429);
    expect((await login('2001:db8:2::1')).status).toBe(401);
    const probe = (ip: string) => fetch(`${h.base}/api/signup`, { headers: { 'x-forwarded-for': ip } });
    for (let n = 0; n < 10; n++) await probe(`2001:db8:3::${n}`);
    expect((await probe('2001:db8:3::ff')).status).toBe(429);
    expect((await probe('2001:db8:4::1')).status).not.toBe(429);
  } finally { await h.close(); }
});
