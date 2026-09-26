import crypto from 'node:crypto';
import type { CredentialBroker } from '../autonomy/broker.js';

/** New references use an installation key independent of provider credentials.
 * Keep the key id in the envelope so future rotation can retain old keys. */
export class WorldReferenceKeys {
  private cached?: { key: Buffer; id: string };
  private constructor(private broker: CredentialBroker) {}
  private material(): { key: Buffer; id: string } {
    if (!this.cached) {
      const handle = 'world-reference:key:v2';
      const key = Buffer.from(this.broker.resolve(handle, { caps: [`use-credential:${handle}`] }), 'base64');
      if (key.length !== 32) throw new Error('invalid world reference key');
      this.cached = { key, id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) };
    }
    return this.cached;
  }
  static async create(broker: CredentialBroker, initialize = true): Promise<WorldReferenceKeys> {
    if (initialize) await broker.ensureHandle('world-reference:key:v2', crypto.randomBytes(32).toString('base64'));
    const keys = new WorldReferenceKeys(broker);
    if (initialize || broker.hasHandle('world-reference:key:v2')) keys.material();
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
