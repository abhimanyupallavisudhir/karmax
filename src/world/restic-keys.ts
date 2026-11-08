import crypto from 'node:crypto';

/**
 * restic key files (restic's design doc, "Keys, Encryption and MAC"): the
 * repository's master key, encrypted with a key derived from the password by
 * scrypt. restic calibrates scrypt to ~0.5 s of CPU and ~60 MB when it creates
 * a key, which every restic command then pays to open the repository: a world
 * restoring hundreds of small resources spent minutes of CPU on nothing else.
 *
 * Stretching a password protects one a person chose. A resource repository's
 * password is an HMAC-SHA256 (256 random bits, resource-repository.ts
 * `repositoryPassword`), which no amount of guessing finds, so a key with
 * scrypt's smallest sensible cost protects the master key exactly as well. Such
 * a "fast key" is added beside the one `restic init` made (never instead of
 * it), and restic is pointed at it with `RESTIC_KEY_HINT`.
 */

/** scrypt's cost for fast keys: ~1 ms and 1 MiB instead of ~0.5 s and 32 MiB. */
export const FAST_KEY_PARAMS = { N: 1024, r: 8, p: 1 } as const;
const SALT_BYTES = 64;
const IV_BYTES = 16;
const MAC_BYTES = 16;

export interface ResticKeyFile {
  created: string; username: string; hostname: string;
  kdf: string; N: number; r: number; p: number; salt: string; data: string;
}

/** A key file whose scrypt costs no more than a fast key's. */
export function isFastKey(key: Pick<ResticKeyFile, 'kdf' | 'N' | 'r' | 'p'>): boolean {
  return key.kdf === 'scrypt' && key.N * key.r * key.p <= FAST_KEY_PARAMS.N * FAST_KEY_PARAMS.r * FAST_KEY_PARAMS.p;
}

/** The master key a key file holds (restic's JSON of it, as stored), or
 * undefined when `password` does not open it. */
export async function openKeyFile(key: ResticKeyFile, password: string): Promise<Buffer | undefined> {
  if (key.kdf !== 'scrypt') throw new Error(`unsupported restic key derivation ${key.kdf}`);
  const user = await derive(password, Buffer.from(key.salt, 'base64'), key);
  const data = Buffer.from(key.data, 'base64');
  if (data.length < IV_BYTES + MAC_BYTES) return undefined;
  const iv = data.subarray(0, IV_BYTES);
  const ciphertext = data.subarray(IV_BYTES, data.length - MAC_BYTES);
  if (!crypto.timingSafeEqual(mac(ciphertext, iv, user.macK, user.macR), data.subarray(data.length - MAC_BYTES))) return undefined;
  const decipher = crypto.createDecipheriv('aes-256-ctr', user.encryption, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** A new key file for `master` (as {@link openKeyFile} returns it), opened by
 * `password` at {@link FAST_KEY_PARAMS}: its bytes, and its name (their SHA-256). */
export async function fastKeyFile(master: Buffer, password: string, now = new Date()): Promise<{ name: string; body: Buffer }> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const user = await derive(password, salt, FAST_KEY_PARAMS);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-ctr', user.encryption, iv);
  const ciphertext = Buffer.concat([cipher.update(master), cipher.final()]);
  const file: ResticKeyFile = { created: now.toISOString(), username: 'tavya', hostname: 'tavya', kdf: 'scrypt', ...FAST_KEY_PARAMS,
    salt: salt.toString('base64'), data: Buffer.concat([iv, ciphertext, mac(ciphertext, iv, user.macK, user.macR)]).toString('base64') };
  const body = Buffer.from(JSON.stringify(file));
  return { name: crypto.createHash('sha256').update(body).digest('hex'), body };
}

/** restic's KDF: 64 bytes of scrypt, split into an AES-256 key and a Poly1305-AES key (k, r). */
async function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number })
  : Promise<{ encryption: Buffer; macK: Buffer; macR: Buffer }> {
  const bytes = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64,
    { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 16 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
  return { encryption: bytes.subarray(0, 32), macK: bytes.subarray(32, 48), macR: bytes.subarray(48, 64) };
}

const P1305 = (1n << 130n) - 5n;
const CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn;

/** restic's MAC: Poly1305-AES (Bernstein), r clamped, s = AES-128_k(iv). */
function mac(message: Buffer, iv: Buffer, k: Buffer, r: Buffer): Buffer {
  const aes = crypto.createCipheriv('aes-128-ecb', k, null);
  aes.setAutoPadding(false);
  const s = littleEndian(Buffer.concat([aes.update(iv), aes.final()]));
  const clamped = littleEndian(r) & CLAMP;
  let accumulator = 0n;
  for (let at = 0; at < message.length; at += 16) {
    const block = message.subarray(at, at + 16);
    accumulator = ((accumulator + littleEndian(block) + (1n << BigInt(8 * block.length))) * clamped) % P1305;
  }
  const tag = (accumulator + s) & ((1n << 128n) - 1n);
  const out = Buffer.alloc(16);
  for (let i = 0, value = tag; i < 16; i++, value >>= 8n) out[i] = Number(value & 0xffn);
  return out;
}

function littleEndian(bytes: Buffer): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}
