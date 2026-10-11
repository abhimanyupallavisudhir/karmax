import crypto from 'node:crypto';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';

/** New references use an installation key independent of provider credentials.
 * Keep the key id in the envelope so future rotation can retain old keys. */
export class WorldReferenceKeys {
  private cached?: { key: Buffer; id: string };
  private constructor(private broker: CredentialBroker) {}
  /** The key, loaded once by `create` (references are sealed and opened synchronously). */
  private material(): { key: Buffer; id: string } {
    if (!this.cached) throw new Error('world reference key unavailable');
    return this.cached;
  }
  private async load(): Promise<void> {
    const handle = 'world-reference:key:v2';
    const key = Buffer.from(await this.broker.resolve(handle, { caps: [`use-credential:${handle}`] }), 'base64');
    if (key.length !== 32) throw new Error('invalid world reference key');
    this.cached = { key, id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) };
  }
  static async create(broker: CredentialBroker, initialize = true): Promise<WorldReferenceKeys> {
    if (initialize) await broker.ensureHandle('world-reference:key:v2', crypto.randomBytes(32).toString('base64'), INSTALLATION_SCOPE);
    const keys = new WorldReferenceKeys(broker);
    if (initialize || await broker.hasHandle('world-reference:key:v2')) await keys.load();
    return keys;
  }
  seal(value: Record<string, string>): string {
    const { key, id } = this.material();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return `KWR2.${id}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }
  open(value: string): Record<string, string> {
    const material = this.material();
    const [version, id, encoded] = value.split('.');
    if (version !== 'KWR2' || id !== material.id || !encoded) throw new Error('world reference key unavailable');
    const blob = Buffer.from(encoded, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', material.key, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(blob.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8'));
  }
}

/** Boot warning for sealed references the current keys cannot open, naming the
 * key each kind needs: KWR2 references use the vault's key, older ones the
 * environment key (or provider API key) they were sealed under. */
export function unreadableReferenceWarning(refs: readonly (string | undefined)[]): string | undefined {
  if (!refs.length) return undefined;
  const current = refs.filter(ref => ref?.startsWith('KWR2.')).length;
  const unsealed = refs.filter(ref => !ref).length;
  const legacy = refs.length - current - unsealed;
  return [
    `${refs.length} world reference(s) cannot be opened; their sandboxes will be preserved.`,
    current ? `${current} sealed under the vault's world-reference:key:v2: restore the vault with the KARMAX_VAULT_KEY it was written under.` : '',
    legacy ? `${legacy} legacy reference(s) sealed under KARMAX_WORLD_REF_KEY (or the provider API key when it was unset): restore the original value.` : '',
    unsealed ? `${unsealed} carry no sealed reference and cannot be reopened.` : '',
  ].filter(Boolean).join(' ');
}
