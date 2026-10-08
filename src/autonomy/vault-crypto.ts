import crypto from 'node:crypto';
import { isVaultScope, type KeyEncryptionKey, type VaultScope } from './vault-keys.js';

/**
 * The vault's envelope formats (SS-1, wiki features/vault-encryption), shared
 * by the file vault (`vault.ts`) and the database vault (`vault-database.ts`),
 * so a secret moved from one to the other is the same string in both.
 *
 * - An entry's blob is `v3.<kid>.<iv>.<tag>.<ct>`: AES-256-GCM under its
 *   scope's data key, with additional data binding the format, the scope and
 *   the handle (AU-40), so ciphertext moved to another handle or scope does
 *   not open.
 * - A keyring holds a scope's data keys, each wrapped under one or more key
 *   encryption keys with additional data binding the scope and the kid.
 * - A KEK canary proves a key is the vault's before anything is written with it.
 */
export const CANARY = 'karmax-vault-canary';
export const KEYRING = 'karmax-vault-keyring:1';
export const KEK_CANARY = 'karmax-vault-kek-canary:1';
export const KEK_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** Secrets a write may not exceed, unless it shrinks one already stored. */
export const SECRET_LIMIT = 65_536;

export const scopedTo = (scope: string, handle: string) => Buffer.from(JSON.stringify(['karmax-vault:v3', scope, handle]), 'utf8');
export const wrappedFor = (scope: string, kid: string) => Buffer.from(JSON.stringify([KEYRING, scope, kid]), 'utf8');
export const kekCanaryFor = (kekId: string) => Buffer.from(JSON.stringify([KEK_CANARY, kekId]), 'utf8');
export const isScoped = (blob: unknown): blob is string => typeof blob === 'string' && blob.startsWith('v3.');
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface Keyring { format: string; scope: VaultScope; current: string; keys: Record<string, { created: number; wraps: Record<string, string> }> }

/** The vault's key state, for operators (`npm run vault-key -- status`). */
export interface VaultKeyStatus {
  kek: string;
  /** Every secret is under a data key (the epoch 4 migration has finished). */
  scoped: boolean;
  keyrings: number;
  scopes: VaultScope[];
  /** Data keys wrapped under each KEK id. */
  wraps: Record<string, number>;
  canaries: string[];
}

/** The vault key is not the vault's (as opposed to a vault that cannot be read). */
export class VaultKeyRefused extends Error {}

export function refusal(kekId: string, detail: string, overridable: boolean): VaultKeyRefused {
  return new VaultKeyRefused(`the vault key does not open this vault: ${detail}. Restore the key the vault was created with`
    + (overridable ? `. If you are certain this key is the vault's, start once with KARMAX_VAULT_ACCEPT_KEY=${kekId}; `
      + 'secrets it cannot open are then quarantined (deploy/README.md, "Rollback compatibility")' : ''));
}

export function sealEntry(plain: string, handle: string, scope: VaultScope, data: { kid: string; key: Buffer }): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', data.key, iv);
  cipher.setAAD(scopedTo(scope, handle));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v3.${data.kid}.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

/** The kid a `v3.` blob was sealed under. */
export const kidOf = (blob: string): string | undefined => isScoped(blob) ? blob.split('.')[1] : undefined;

/** Open a `v3.` blob; `dataKey` looks up its scope's data key by kid. */
export function openEntry(blob: string, handle: string, scope: VaultScope | undefined, dataKey: (kid: string) => Buffer): string {
  const parts = blob.split('.');
  if (!scope) throw new Error(`vault entry for ${handle} records no scope; restore it from a backup`);
  const iv = parts.length === 5 ? Buffer.from(parts[2]!, 'base64') : Buffer.alloc(0);
  const tag = parts.length === 5 ? Buffer.from(parts[3]!, 'base64') : Buffer.alloc(0);
  if (iv.length !== 12 || tag.length !== 16) throw new Error('vault entry is corrupt (malformed ciphertext)');
  let key: Buffer;
  try { key = dataKey(parts[1]!); }
  catch (error) { throw new Error(`vault entry for ${handle}: ${(error as Error).message}`); }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(scopedTo(scope, handle));
  try {
    return Buffer.concat([decipher.update(Buffer.from(parts[4]!, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`vault entry for ${handle} failed authentication (altered, or moved from another handle or scope)`);
  }
}

export function parseKeyring(scope: string, raw: string): Keyring {
  let ring: Keyring;
  try { ring = JSON.parse(raw); } catch { throw new Error(`the vault keyring for ${scope} is unreadable; restore it from a backup`); }
  if (ring?.format !== KEYRING || !ring.keys || typeof ring.keys !== 'object') throw new Error(`the vault keyring for ${scope} is corrupt`);
  if (ring.scope !== scope) throw new Error(`the vault keyring for ${scope} belongs to ${String(ring.scope)}; it was moved or altered`);
  return ring;
}

/** A keyring as stored, or undefined for one that is damaged (its reads fail). */
export function readableKeyring(raw: string): Keyring | undefined {
  try {
    const ring = JSON.parse(raw) as Keyring;
    return ring?.format === KEYRING && isVaultScope(ring.scope) && ring.keys && typeof ring.keys === 'object' ? ring : undefined;
  } catch { return undefined; }
}

/** Unwrap a data key with the first known KEK that wraps it. */
export function unwrapDataKey(ring: Keyring, kid: string, known: KeyEncryptionKey[], currentId: string): Buffer {
  const wraps = ring.keys[kid]?.wraps ?? {};
  for (const kek of known) {
    if (!wraps[kek.id]) continue;
    let key: Buffer;
    try { key = kek.unwrap(wraps[kek.id]!, wrappedFor(ring.scope, kid)); }
    catch { throw new Error(`the data key ${kid} of ${ring.scope} failed authentication under ${kek.id} (altered, or moved from another keyring)`); }
    if (key.length !== 32) throw new Error(`the data key ${kid} of ${ring.scope} is malformed`);
    return key;
  }
  throw new Error(`the data key ${kid} of ${ring.scope} is not wrapped under ${currentId}`);
}

/** Add a new data key to `ring`, wrapped under the current KEK and under every
 * other known KEK that already wraps this keyring (so a rotation in progress
 * keeps working). */
export function mintDataKey(ring: Pick<Keyring, 'scope' | 'keys'>, current: KeyEncryptionKey, known: KeyEncryptionKey[]): { kid: string; key: Buffer } {
  const kid = `dk-${crypto.randomBytes(8).toString('hex')}`;
  const key = crypto.randomBytes(32);
  const ids = new Set(Object.values(ring.keys).flatMap((entry) => Object.keys(entry.wraps ?? {})));
  const wraps: Record<string, string> = {};
  for (const kek of known) if (kek === current || ids.has(kek.id)) wraps[kek.id] = kek.wrap(key, wrappedFor(ring.scope, kid));
  ring.keys[kid] = { created: Date.now(), wraps };
  return { kid, key };
}

/** A KEK's canary record, as stored (`keys/<kek>.canary`, or a database row). */
export function kekCanaryRecord(kek: KeyEncryptionKey, legacy: boolean): string {
  const blob = kek.wrap(Buffer.from(JSON.stringify({ canary: CANARY, legacy })), kekCanaryFor(kek.id));
  return `${JSON.stringify({ format: KEK_CANARY, kek: kek.id, blob })}\n`;
}

/** A KEK's canary state from its stored record; undefined for a damaged record
 * (re-derived from the keyrings), a refusal for one that fails to authenticate. */
export function openKekCanary(kek: KeyEncryptionKey, raw: string, where: string): { legacy: boolean } | undefined {
  let record: { kek?: unknown; blob?: unknown };
  try { record = JSON.parse(raw); } catch { return undefined; }
  let state: { canary?: unknown; legacy?: unknown } | undefined;
  try { state = JSON.parse(kek.unwrap(String(record.blob), kekCanaryFor(kek.id)).toString('utf8')); } catch { state = undefined; }
  if (record.kek !== kek.id || state?.canary !== CANARY) throw refusal(kek.id, `${where} fails to authenticate`, false);
  return { legacy: state.legacy === true };
}

/** Data keys no known KEK opens, and how many lack a wrap under the current one. */
export function strandedKeys(rings: Keyring[], current: KeyEncryptionKey, known: KeyEncryptionKey[]): { stranded: string[]; lacking: number } {
  const knownIds = new Set(known.map((kek) => kek.id));
  const stranded: string[] = [];
  let lacking = 0;
  for (const ring of rings)
    for (const [kid, key] of Object.entries(ring.keys)) {
      const wraps = Object.keys(key?.wraps ?? {});
      if (wraps.includes(current.id)) continue;
      lacking++;
      if (!wraps.some((id) => knownIds.has(id))) stranded.push(`${ring.scope} (${kid}, wrapped under ${wraps.join(', ') || 'nothing'})`);
    }
  return { stranded, lacking };
}

export function strandedRefusal(kekId: string, stranded: string[]): VaultKeyRefused {
  return refusal(kekId, `${plural(stranded.length, 'data key')} ${stranded.length === 1 ? 'is' : 'are'} not wrapped under ${kekId}: `
    + `${stranded.slice(0, 5).join('; ')}${stranded.length > 5 ? '; …' : ''}. Finish the vault key rotation `
    + '(deploy/karmax rotate-vault-key, or npm run vault-key -- add with the vault running on the previous key), or start with that key', false);
}

export function validateSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') > SECRET_LIMIT) throw new Error('vault secret exceeds size limit (64 KiB)');
}
export function validateScope(scope: VaultScope): void {
  if (!isVaultScope(scope)) throw new Error(`invalid vault scope ${JSON.stringify(scope)}: expected installation, organization:<id> or user:<id>`);
}

/**
 * The secret vault the credential broker uses: the file vault (self-hosted
 * SQLite installs) or the database vault (PostgreSQL; wiki
 * planned/host-local-state). Every secret belongs to a scope; a write naming
 * a scope other than the one recorded on the entry is refused.
 */
export interface SecretVault {
  readonly kekId: string;
  /** `history: false` replaces the secret and forgets its earlier revisions,
   * for a value that must not survive in them (a card's CVC, AU-31). */
  put(handle: string, secret: string, scope: VaultScope, options?: { history?: boolean }): Promise<void>;
  putIfAbsent(handle: string, secret: string, scope: VaultScope): Promise<void>;
  move(handle: string, nextHandle: string, scope: VaultScope, replacement?: string): Promise<void>;
  has(handle: string): Promise<boolean>;
  /** The scope a secret belongs to; undefined for none, or one not yet migrated. */
  scopeOf(handle: string): Promise<VaultScope | undefined>;
  /** Internal: only the broker should call this. */
  reveal(handle: string, revision?: number): Promise<string | undefined>;
  list(): Promise<string[]>;
  delete(handle: string): Promise<void>;
  deleteIfEqual(handle: string, observed: string): Promise<boolean>;
  rotateDataKey(scope: VaultScope): Promise<{ reencrypted: number; retired: string[] }>;
  destroyScope(scope: VaultScope): Promise<{ entries: number; quarantined: number }>;
  wrapUnderCurrentKek(): Promise<{ wrapped: number }>;
  pruneKeks(): Promise<{ pruned: string[] }>;
  keyStatus(): Promise<VaultKeyStatus>;
}
