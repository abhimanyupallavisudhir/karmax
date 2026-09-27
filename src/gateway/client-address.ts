import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

function canonical(address: string): string | undefined {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6 || address.includes('%')) return undefined;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [left, right] = normalized.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const parts = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  if (parts.slice(0, 5).every(part => part === '0') && parts[5] === 'ffff') {
    const bytes = parts.slice(6).flatMap(part => [parseInt(part, 16) >> 8, parseInt(part, 16) & 255]);
    return bytes.join('.');
  }
  return parts.map(part => part.padStart(4, '0')).join(':');
}

/** Caddy overwrites XFF with one peer address; no implicit trust of a subnet or hosted mode. */
export function clientAddress(req: IncomingMessage): string {
  const peer = canonical(req.socket.remoteAddress ?? '');
  const trusted = canonical(process.env.KARMAX_TRUSTED_PROXY_IP ?? '');
  const forwarded = req.headers['x-forwarded-for'];
  const address = peer && trusted === peer && typeof forwarded === 'string'
    ? canonical(forwarded.trim()) ?? peer : peer;
  return address?.includes(':') ? `${address.split(':').slice(0, 4).join(':')}::/64` : address ?? 'unknown';
}

/** A second bound groups IPv6 privacy addresses which the edge meters individually. */
export class ClientRequestLimits {
  private buckets = new Map<string, { count: number; until: number }>();
  private sweepAt = 0;

  allow(address: string, pathname: string, now = Date.now()): boolean {
    if (now >= this.sweepAt) {
      for (const [key, value] of this.buckets) if (value.until <= now) this.buckets.delete(key);
      this.sweepAt = now + 60_000;
    }
    const zones: Array<[string, number, number]> = [['api', 600, 60_000]];
    if (pathname === '/api/signup' || pathname === '/api/setup') zones.push(['signup', 10, 3_600_000]);
    if (pathname === '/api/login' || pathname.startsWith('/api/auth/') || pathname === '/api/invitations/accept')
      zones.push(['auth', 30, 60_000]);
    for (const [zone, max, window] of zones) {
      const key = `${zone}:${address}`;
      let bucket = this.buckets.get(key);
      if (!bucket || bucket.until <= now) {
        if (!bucket && this.buckets.size >= 100_000) return false;
        bucket = { count: 0, until: now + window };
        this.buckets.set(key, bucket);
      }
      if (++bucket.count > max) return false;
    }
    return true;
  }
}
