import crypto from 'node:crypto';

export function configuredPreviewOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.KARMAX_PREVIEW_ORIGIN?.trim();
  if (!value) return undefined;
  try { return new URL(value).origin; } catch { return undefined; }
}

export function previewLeaseUrl(leaseId: string, requestPath = '/', token?: string): string {
  const base = `${previewLeaseOrigin(leaseId)}/preview/${encodeURIComponent(leaseId)}`;
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  if (!token) return `${base}${suffix}`;
  return `${base}${suffix}${suffix.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Give each untrusted repository application its own browser origin. The
 * configured origin is the wildcard's base (for example preview.example.com),
 * while the browser receives p-<digest>.preview.example.com. */
export function previewLeaseOrigin(leaseId: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = configuredPreviewOrigin(env);
  if (!configured) return '';
  const base = new URL(configured);
  base.hostname = `p-${crypto.createHash('sha256').update(leaseId).digest('hex').slice(0, 24)}.${base.hostname}`;
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
