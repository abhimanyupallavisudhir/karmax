/**
 * The credential in an artifact edge URL (src/edge/artifact-worker.ts): which
 * saved object to serve, how to serve it, and until when, signed by tavya with
 * a key the Worker holds as a secret. The Worker decides nothing itself: tavya
 * checked who may open the file when it minted the URL, and chose the headers.
 * Web-standard (WebCrypto), for the gateway and the Worker alike.
 */

export interface ArtifactEdgeClaims {
  /** Object key in the bucket. */
  key: string;
  /** Size and SHA-256 recorded when it was saved. */
  bytes: number;
  sha256: string;
  /** `content-type`, `inline`/`attachment` and `content-security-policy` to serve it with. */
  type: string;
  disposition: 'inline' | 'attachment';
  csp: string;
  name: string;
  expiresAt: number;
}

type Wire = { k: string; b: number; h: string; t: string; d: 'i' | 'a'; c: string; n: string; e: number };

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch { return undefined; }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): ReturnType<typeof crypto.subtle.importKey> {
  const raw = unbase64url(secret);
  if (!raw || raw.length < 32) throw new Error('the artifact edge key is missing or too short');
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

const signed = (body: string) => encoder.encode(`review-artifact-edge\0${body}`);

export async function signArtifactEdgeToken(claims: ArtifactEdgeClaims, secret: string): Promise<string> {
  const wire: Wire = { k: claims.key, b: claims.bytes, h: claims.sha256, t: claims.type,
    d: claims.disposition === 'attachment' ? 'a' : 'i', c: claims.csp, n: claims.name, e: claims.expiresAt };
  const body = base64url(encoder.encode(JSON.stringify(wire)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), signed(body)));
  return `${body}.${base64url(signature)}`;
}

export async function verifyArtifactEdgeToken(token: string, secret: string, now = Date.now()): Promise<ArtifactEdgeClaims | undefined> {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return undefined;
  const mac = unbase64url(signature);
  if (!mac || !await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), mac, signed(body))) return undefined;
  let wire: Partial<Wire>;
  try { wire = JSON.parse(new TextDecoder().decode(unbase64url(body))); } catch { return undefined; }
  if (typeof wire.k !== 'string' || typeof wire.b !== 'number' || typeof wire.h !== 'string' || typeof wire.t !== 'string'
    || (wire.d !== 'i' && wire.d !== 'a') || typeof wire.c !== 'string' || typeof wire.n !== 'string'
    || typeof wire.e !== 'number' || wire.e <= now) return undefined;
  return { key: wire.k, bytes: wire.b, sha256: wire.h, type: wire.t, disposition: wire.d === 'a' ? 'attachment' : 'inline',
    csp: wire.c, name: wire.n, expiresAt: wire.e };
}
