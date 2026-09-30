import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultGateway, resolveTrustedProxy } from '../src/gateway/client-address.js';
import { stubGateway } from './helpers/stub-gateway.js';

// /proc/net/route inside a container on a Compose bridge (gateway 172.18.0.1),
// little-endian hex, with a second, more specific route that is not the default.
const ROUTES = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  '',
].join('\n');

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

it('reads the default gateway from the kernel route table (CI-8)', () => {
  expect(defaultGateway(ROUTES)).toBe('172.18.0.1');
  // The lowest metric wins when several default routes exist.
  expect(defaultGateway(`${ROUTES}eth1\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n`)).toBe('172.18.0.1');
  expect(defaultGateway(ROUTES.replace('\t0\t00000000\t0\t0\t0\neth0\t000012AC', '\t200\t00000000\t0\t0\t0\neth0\t000012AC')
    + 'eth1\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n')).toBe('192.168.0.1');
  // A default route without RTF_GATEWAY (0x2), or no default route, has no gateway.
  expect(defaultGateway(ROUTES.replace('\t0003\t', '\t0001\t'))).toBeUndefined();
  expect(defaultGateway(ROUTES.split('\n').filter((line) => !line.includes('\t00000000\t010012AC')).join('\n'))).toBeUndefined();
  expect(defaultGateway('')).toBeUndefined();
});

it('trusts the container\'s own gateway when told to, and nothing when it cannot find one (CI-8)', () => {
  expect(resolveTrustedProxy('gateway', () => ROUTES)).toBe('172.18.0.1');
  expect(resolveTrustedProxy('gateway', () => { throw new Error('no /proc'); })).toBeUndefined();
  expect(resolveTrustedProxy('172.30.0.1', () => { throw new Error('unused'); })).toBe('172.30.0.1');
  expect(resolveTrustedProxy('::ffff:172.30.0.1', () => '')).toBe('172.30.0.1');
  expect(resolveTrustedProxy('', () => ROUTES)).toBeUndefined();
  expect(resolveTrustedProxy('not-an-address', () => ROUTES)).toBeUndefined();
});

it.skipIf(!fs.existsSync('/proc/net/route'))('uses this machine\'s gateway as the trusted proxy under KARMAX_TRUSTED_PROXY_IP=gateway (CI-8)', async () => {
  const gateway = defaultGateway(fs.readFileSync('/proc/net/route', 'utf8'));
  vi.stubEnv('KARMAX_TRUSTED_PROXY_IP', 'gateway');
  const h = await stubGateway({ hosted: true });
  try {
    const address = (peer: string, header: string) => (h.gateway as any).clientAddress({
      socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': header },
    });
    expect(address('198.51.100.5', '203.0.113.2')).toBe('198.51.100.5');
    if (gateway) expect(address(gateway, '203.0.113.2')).toBe('203.0.113.2');
  } finally { await h.close(); }
});
