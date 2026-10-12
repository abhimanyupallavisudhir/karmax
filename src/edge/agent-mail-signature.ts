/**
 * How the agent-mail Worker (src/edge/agent-mail-worker.ts) signs what it posts
 * to tavya's ingest webhook, and how tavya checks it. One implementation for
 * both sides, Web Crypto only, so it runs in workerd and in Node.
 *
 * The request body is the message's raw MIME, unchanged; the envelope travels
 * in headers. The signature covers the time, the envelope and every body byte,
 * so none of them can be altered or replayed later than SIGNATURE_MAX_AGE_S.
 */

export const MAIL_TO_HEADER = 'x-tavya-mail-to';
export const MAIL_FROM_HEADER = 'x-tavya-mail-from';
/** `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const MAIL_SIGNATURE_HEADER = 'x-tavya-mail-signature';
/** A signed delivery older (or newer) than this is refused. */
export const SIGNATURE_MAX_AGE_S = 300;
/** Agent mail carries sign-up codes and links: anything larger is refused,
 * by the Worker before it reads the message and by tavya before it parses it. */
export const AGENT_MAIL_MAX_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();

async function mac(secret: string, timestamp: string, to: string, from: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const head = encoder.encode(`v1\n${timestamp}\n${to}\n${from}\n`);
  const message = new Uint8Array(head.length + body.length);
  message.set(head);
  message.set(body, head.length);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signMail(secret: string, to: string, from: string, body: Uint8Array, now = Date.now()): Promise<string> {
  const timestamp = String(Math.floor(now / 1000));
  return `t=${timestamp},v1=${await mac(secret, timestamp, to, from, body)}`;
}

/** Whether `header` is a fresh signature of this delivery under `secret`. */
export async function verifyMail(secret: string, header: string | undefined, to: string, from: string, body: Uint8Array,
  now = Date.now()): Promise<boolean> {
  const parts = Object.fromEntries((header ?? '').split(',').map((part) => part.trim().split('=', 2) as [string, string]));
  const timestamp = parts.t ?? '';
  if (!secret || !/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_S) return false;
  const expected = await mac(secret, timestamp, to, from, body);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ parts.v1!.charCodeAt(i);
  return difference === 0;
}
