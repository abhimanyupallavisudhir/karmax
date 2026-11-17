import crypto from 'node:crypto';

/**
 * Standards Web Push from node:crypto alone (wiki features/push-and-voice):
 * message encryption (RFC 8291, the aes128gcm content coding of RFC 8188),
 * application-server identification (VAPID, RFC 8292) and the push request
 * itself (RFC 8030). About 150 lines, so no `web-push` dependency (and its
 * own dependency tree) for what the platform's crypto already does.
 */

/** A browser's subscription keys, as `PushSubscription.toJSON().keys` gives them (base64url). */
export interface PushKeys { p256dh: string; auth: string }

/** The installation's VAPID key pair: an uncompressed P-256 point (65 bytes) and
 * its private scalar (32 bytes), base64url. */
export interface VapidKeyPair { publicKey: string; privateKey: string }

/** What push services guarantee to carry (RFC 8030 §7.2: at least 4096 octets). */
export const MAX_PUSH_BODY = 4096;

const ECDH_CURVE = 'prime256v1';

export function generateVapidKeys(): VapidKeyPair {
  const ecdh = crypto.createECDH(ECDH_CURVE);
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: scalar(ecdh.getPrivateKey()).toString('base64url') };
}

/** The public key of a stored private scalar. */
export function vapidKeyPair(privateKey: string): VapidKeyPair {
  const ecdh = crypto.createECDH(ECDH_CURVE);
  ecdh.setPrivateKey(scalar(Buffer.from(privateKey, 'base64url')));
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey };
}

/** A P-256 scalar is 32 bytes; a leading zero byte may have been dropped. */
function scalar(value: Buffer): Buffer {
  if (value.length > 32) throw new Error('not a P-256 private key');
  return value.length === 32 ? value : Buffer.concat([Buffer.alloc(32 - value.length), value]);
}

/** Validate a subscription's keys, returning them as bytes. */
export function pushKeyBytes(keys: PushKeys): { uaPublic: Buffer; auth: Buffer } {
  const uaPublic = Buffer.from(String(keys?.p256dh ?? ''), 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 public key');
  // convertKey throws for a point that is not on the curve.
  try { crypto.ECDH.convertKey(uaPublic, ECDH_CURVE); } catch { throw new Error('p256dh is not a point on P-256'); }
  const auth = Buffer.from(String(keys?.auth ?? ''), 'base64url');
  if (auth.length !== 16) throw new Error('auth must be a 16-byte secret');
  return { uaPublic, auth };
}

/**
 * Encrypt one push message for one subscription (RFC 8291 §3.4): a fresh
 * sender key pair and salt per message, a single aes128gcm record. `salt` and
 * `senderPrivateKey` exist for the RFC's test vectors only.
 */
export function encryptPushPayload(plaintext: string | Buffer, keys: PushKeys,
  options: { salt?: Buffer; senderPrivateKey?: Buffer; recordSize?: number } = {}): Buffer {
  const { uaPublic, auth } = pushKeyBytes(keys);
  const sender = crypto.createECDH(ECDH_CURVE);
  if (options.senderPrivateKey) sender.setPrivateKey(options.senderPrivateKey); else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  // IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = "WebPush: info" 0x00 ua_public as_public, 32)
  const ikm = hkdf(ecdhSecret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const salt = options.salt ?? crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const recordSize = options.recordSize ?? 4096;
  // One record: the plaintext, then the last-record delimiter 0x02 (no padding).
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (data.length + 16 > recordSize) throw new Error('push payload is larger than one record');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header[20] = asPublic.length;
  const body = Buffer.concat([header, asPublic, ciphertext]);
  if (body.length > MAX_PUSH_BODY) throw new Error(`push payload is ${body.length} bytes; push services take ${MAX_PUSH_BODY}`);
  return body;
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * The `Authorization` header that identifies this installation to a push
 * service (RFC 8292 §3): an ES256 JWT for the endpoint's origin, valid for
 * `ttlSeconds` (at most 24 hours), and the public key the subscription was made with.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeyPair, subject: string,
  now = Date.now(), ttlSeconds = 12 * 3600): string {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({ aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + Math.min(ttlSeconds, 24 * 3600), sub: subject })}`;
  const point = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url'),
    d: scalar(Buffer.from(keys.privateKey, 'base64url')).toString('base64url') } });
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/**
 * The push services browsers subscribe with. The server POSTs wherever a
 * subscription points, so an endpoint anywhere else (a metadata address, an
 * internal service) is refused: Chrome/Edge-on-Android (FCM), Firefox
 * (Mozilla autopush), Safari (Apple), Edge on Windows (WNS). A new browser
 * vendor's service needs a line here.
 */
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'jmt17.google.com'];
const PUSH_SERVICE_DOMAINS = ['push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function pushEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.includes(host)
    || PUSH_SERVICE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** RFC 8030 §5.3 urgency of a delivery (the inbox's critical is the protocol's high). */
export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

/** Send one encrypted message; resolves to the push service's HTTP status. */
export async function sendPush(subscription: { endpoint: string; keys: PushKeys }, payload: string, options: {
  vapid: VapidKeyPair; subject: string; urgency: PushUrgency; ttlSeconds: number; topic?: string;
  fetcher?: typeof fetch; timeoutMs?: number;
}): Promise<number> {
  if (!pushEndpointAllowed(subscription.endpoint)) throw new Error('not a browser push service endpoint');
  const body = encryptPushPayload(payload, subscription.keys);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await (options.fetcher ?? fetch)(subscription.endpoint, {
      method: 'POST', signal: abort.signal, redirect: 'error', body,
      headers: {
        authorization: vapidAuthorization(subscription.endpoint, options.vapid, options.subject),
        'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
        ttl: String(options.ttlSeconds), urgency: options.urgency,
        ...(options.topic ? { topic: options.topic } : {}),
      },
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`push service timed out after ${options.timeoutMs ?? 15_000}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
