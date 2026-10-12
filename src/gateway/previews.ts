import crypto from 'node:crypto';

function origin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try { return new URL(value.trim()).origin; } catch { return undefined; }
}

/** The preview origin new leases are issued under: the base of their
 * wildcard (for example usercontent.example), never the console's origin. */
export function configuredPreviewOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return origin(env.KARMAX_PREVIEW_ORIGIN);
}

/** Every origin previews are served on: the current one, then one previews
 * moved away from, whose leases keep their hostnames until they expire. */
export function previewOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const current = configuredPreviewOrigin(env);
  if (!current) return [];
  const legacy = origin(env.KARMAX_LEGACY_PREVIEW_ORIGIN);
  return legacy && legacy !== current ? [current, legacy] : [current];
}

/** The hostname a new lease gets: p-<digest>.<current preview base>. */
export function previewHostname(leaseId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = configuredPreviewOrigin(env);
  if (!configured) return undefined;
  return `p-${crypto.createHash('sha256').update(leaseId).digest('hex').slice(0, 24)}.${new URL(configured).hostname}`.toLowerCase();
}

type LeaseRef = string | { id: string; hostname?: string };

export function previewLeaseUrl(lease: LeaseRef, requestPath = '/', token?: string, env: NodeJS.ProcessEnv = process.env): string {
  const id = typeof lease === 'string' ? lease : lease.id;
  const base = `${previewLeaseOrigin(lease, env)}/preview/${encodeURIComponent(id)}`;
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  if (!token) return `${base}${suffix}`;
  return `${base}${suffix}${suffix.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Give each untrusted repository application its own browser origin. A lease
 * keeps the hostname it was issued (stored with it), so moving previews to a
 * new domain leaves the links already handed out working until they expire;
 * a lease without one gets its hostname under the current preview origin. */
export function previewLeaseOrigin(lease: LeaseRef, env: NodeJS.ProcessEnv = process.env): string {
  const origins = previewOrigins(env);
  if (!origins.length) return '';
  const id = typeof lease === 'string' ? lease : lease.id;
  const hostname = (typeof lease === 'string' ? undefined : lease.hostname) ?? previewHostname(id, env)!;
  const base = new URL(origins.find((candidate) => hostname.endsWith(`.${new URL(candidate).hostname}`)) ?? origins[0]!);
  base.hostname = hostname;
  return base.origin;
}

export function newPreviewToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashPreviewToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function previewTokenMatches(expectedHex: string | undefined, supplied: string): boolean {
  const actual = crypto.createHash('sha256').update(supplied).digest();
  const expected = Buffer.from(expectedHex ?? '', 'hex');
  return expected.length === actual.length && expected.length > 0 && crypto.timingSafeEqual(expected, actual);
}

export function previewCookieName(leaseId: string): string {
  return `kmx_preview_${crypto.createHash('sha256').update(leaseId).digest('hex').slice(0, 16)}`;
}

export function previewCookieValue(header: string | undefined, leaseId: string): string {
  const name = previewCookieName(leaseId);
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
}

export function previewCookieHeader(leaseId: string, token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const secure = configuredPreviewOrigin()?.startsWith('https:') ? '; Secure' : '';
  return `${previewCookieName(leaseId)}=${encodeURIComponent(token)}; Path=/preview/${encodeURIComponent(leaseId)}/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Lax`;
}
