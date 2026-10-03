import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Key management for the vault's envelope encryption (SS-1, wiki
 * features/vault-encryption).
 *
 * Every secret is encrypted under a random 256-bit data key (DEK) of the
 * scope that owns it: an organization, a user, or the installation itself.
 * Each DEK is stored only wrapped under a key encryption key (KEK). The KEK is
 * the vault key operators already have (`KARMAX_VAULT_KEY`, else
 * `vault/vault.key`), and it comes from a `KekSource`, so a cloud KMS can
 * supply it later without changing any stored format.
 */

/** Who owns a secret, recorded on its entry and bound into its ciphertext. */
export type VaultScope = 'installation' | `organization:${string}` | `user:${string}`;
export const INSTALLATION_SCOPE = 'installation' as const;

const SCOPE_ID = /^[A-Za-z0-9._-]{1,200}$/;
export function organizationScope(organizationId: string): VaultScope {
  if (!SCOPE_ID.test(organizationId)) throw new Error(`invalid organization id for a vault scope: ${JSON.stringify(organizationId)}`);
  return `organization:${organizationId}`;
}
export function userScope(userId: string): VaultScope {
  if (!SCOPE_ID.test(userId)) throw new Error(`invalid user id for a vault scope: ${JSON.stringify(userId)}`);
  return `user:${userId}`;
}
export function isVaultScope(value: unknown): value is VaultScope {
  if (value === INSTALLATION_SCOPE) return true;
  if (typeof value !== 'string') return false;
  const match = /^(organization|user):(.*)$/.exec(value);
  return !!match && SCOPE_ID.test(match[2]!);
}

/**
 * A key encryption key. `wrap`/`unwrap` are AES-GCM-style authenticated
 * encryption of a small value (a DEK, the canary) with additional data; the id
 * names the key in every wrap made with it and must be a single file-name-safe
 * token. A KMS-backed implementation would call the KMS here.
 */
export interface KeyEncryptionKey {
  readonly id: string;
  wrap(plain: Buffer, aad: Buffer): string;
  unwrap(wrapped: string, aad: Buffer): Buffer;
}

/** The KEK new wraps use, and others that may still open older wraps. */
export interface KekSource {
  current: KeyEncryptionKey;
  others: KeyEncryptionKey[];
}

/** Names a key without revealing it (`KARMAX_VAULT_ACCEPT_KEY`, manifests, wraps). */
export function keyIdOf(material: Buffer): string {
  return `vk-${crypto.createHash('sha256').update('karmax-vault-key-id\0').update(material).digest('hex').slice(0, 16)}`;
}

/** A KEK held in this process: today's vault key. */
export class LocalKek implements KeyEncryptionKey {
  readonly id: string;
  constructor(readonly material: Buffer) {
    if (material.length !== 32) throw new Error('a vault key is 32 bytes');
    this.id = keyIdOf(material);
  }
  /**
   * `KARMAX_VAULT_KEY` text, hashed, NOT stretched. It is key *material*, not a
   * password: it must be high-entropy random (`openssl rand -base64 32`). A KDF
   * would only buy resistance to guessing a human-chosen phrase, and would
   * change the derived key, making every existing vault undecryptable.
   */
  static fromText(text: string): LocalKek {
    return new LocalKek(crypto.createHash('sha256').update(text).digest());
  }
  wrap(plain: Buffer, aad: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.material, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${body.toString('base64')}`;
  }
  unwrap(wrapped: string, aad: Buffer): Buffer {
    const parts = typeof wrapped === 'string' ? wrapped.split('.') : [];
    const iv = parts.length === 3 ? Buffer.from(parts[0]!, 'base64') : Buffer.alloc(0);
    const tag = parts.length === 3 ? Buffer.from(parts[1]!, 'base64') : Buffer.alloc(0);
    if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed wrap');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.material, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    return Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64')), decipher.final()]);
  }
}

/**
 * The vault key the app uses: `KARMAX_VAULT_KEY` (hosted: the Docker secret
 * `vault_key`, through `KARMAX_VAULT_KEY_FILE`), else `vault/vault.key`, which
 * is created on first use. `vault.key` beside a `KARMAX_VAULT_KEY` that differs
 * is kept as another known key: it can only ever open, never wrap.
 *
 * A short `KARMAX_VAULT_KEY` is warned about rather than refused: hosted
 * deployments already fail preflight on it (`config/deployment.ts`), and
 * refusing here would lock an existing self-hosted user out of a vault that
 * opens fine.
 */
export function kekFromEnvironment(vaultDir: string, options: { readOnly?: boolean; env?: NodeJS.ProcessEnv } = {}): KekSource {
  const env = options.env ?? process.env;
  const keyPath = path.join(vaultDir, 'vault.key');
  const supplied = env.KARMAX_VAULT_KEY;
  if (supplied) {
    if (supplied.length < 32)
      console.warn('[vault] KARMAX_VAULT_KEY is shorter than 32 characters. It is raw key material, '
        + 'not a password, and is not stretched — generate one with `openssl rand -base64 32`.');
    const current = LocalKek.fromText(supplied);
    let file: Buffer | undefined;
    try { file = fs.readFileSync(keyPath); } catch { /* none */ }
    return { current, others: file?.length === 32 && !file.equals(current.material) ? [new LocalKek(file)] : [] };
  }
  if (fs.existsSync(keyPath)) return { current: new LocalKek(fs.readFileSync(keyPath)), others: [] };
  if (options.readOnly) throw new Error('the vault has no key: set KARMAX_VAULT_KEY (or KARMAX_VAULT_KEY_FILE) or restore vault/vault.key');
  const key = crypto.randomBytes(32);
  // Publish only a complete key, without replacing a concurrently created one.
  const temporary = `${keyPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, key, { mode: 0o600, flag: 'wx' });
  try {
    try { fs.linkSync(temporary, keyPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return { current: new LocalKek(fs.readFileSync(keyPath)), others: [] };
  } finally { fs.unlinkSync(temporary); }
}

/** The id of the key the app would use for `vaultDir`, without creating one. */
export function environmentKekId(vaultDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.KARMAX_VAULT_KEY) return LocalKek.fromText(env.KARMAX_VAULT_KEY).id;
  try {
    const file = fs.readFileSync(path.join(vaultDir, 'vault.key'));
    return file.length === 32 ? keyIdOf(file) : undefined;
  } catch { return undefined; }
}
