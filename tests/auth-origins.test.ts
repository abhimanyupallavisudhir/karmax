import { expect, it } from 'vitest';
import { authHosts } from '../src/auth/origins.js';

it('trusts the configured tailnet host, never all tailnets by default (GW-7)', () => {
  expect(authHosts({})).not.toContain('*.ts.net');
  const hosts = authHosts({ KARMAX_PUBLIC_URL: 'https://mine.tailnet.ts.net' });
  expect(hosts).toContain('mine.tailnet.ts.net');
  expect(hosts.some(host => host.includes('*.ts.net'))).toBe(false);
  expect(authHosts({ KARMAX_AUTH_HOSTS: 'private.example' })).toContain('https://private.example:*');
});
