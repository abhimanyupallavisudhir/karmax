import crypto from 'node:crypto';
import type { CredentialBroker } from '../autonomy/broker.js';

/** New references use an installation key independent of provider credentials.
 * Keep the key id in the envelope so future rotation can retain old keys. */
export class WorldReferenceKeys {
  private readonly id: string;
  private constructor(private key: Buffer) {
    this.id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  }
  static async create(broker: CredentialBroker): Promise<WorldReferenceKeys> {
    const handle = 'world-reference:key:v2';
    await broker.ensureHandle(handle, crypto.randomBytes(32).toString('base64'));
    return new WorldReferenceKeys(Buffer.from(broker.resolve(handle, { caps: [`use-credential:${handle}`] }), 'base64'));
  }
  seal(value: Record<string, string>): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.id));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return `KWR2.${this.id}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }
  open(value: string): Record<string, string> {
    const [version, id, encoded] = value.split('.');
    if (version !== 'KWR2' || id !== this.id || !encoded) throw new Error('world reference key unavailable');
    const blob = Buffer.from(encoded, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(blob.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8'));
  }
}
