import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A local, file-backed secret vault (SPEC §8.4). This is the pluggable backend
 * behind the credential broker — in production it would be HashiCorp Vault, a
 * cloud secret manager, or 1Password. Secrets are encrypted at rest with
 * AES-256-GCM under a key kept in the vault dir (chmod 600).
 *
 * Stored values are SECRETS resolved only by the broker; everything else in the
 * system holds opaque handles (pointers), never raw keys.
 */
export class Vault {
  private keyPath: string;
  private dbPath: string;
  private key: Buffer;

  constructor(dir: string) {
    // The vault holds encrypted secrets and its key; keep the directory private
    // (0700) so the 0600 files inside aren't reachable via a traversable dir.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.keyPath = path.join(dir, 'vault.key');
    this.dbPath = path.join(dir, 'secrets.json');
    this.key = this.loadOrCreateKey();
  }

  private loadOrCreateKey(): Buffer {
    if (process.env.KARMAX_VAULT_KEY) {
      return crypto.createHash('sha256').update(process.env.KARMAX_VAULT_KEY).digest();
    }
    if (fs.existsSync(this.keyPath)) return fs.readFileSync(this.keyPath);
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    return key;
  }

  private readDb(): Record<string, string> {
    if (!fs.existsSync(this.dbPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
    } catch {
      return {};
    }
  }
  private writeDb(db: Record<string, string>) {
    fs.writeFileSync(this.dbPath, JSON.stringify(db), { mode: 0o600 });
  }

  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }
  private decrypt(blob: string): string {
    const [ivB, tagB, encB] = blob.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB!, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB!, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encB!, 'base64')), decipher.final()]).toString('utf8');
  }

  put(handle: string, secret: string) {
    const db = this.readDb();
    db[handle] = this.encrypt(secret);
    this.writeDb(db);
  }
  has(handle: string): boolean {
    return handle in this.readDb();
  }
  /** Internal: only the broker should call this. */
  reveal(handle: string): string | undefined {
    const db = this.readDb();
    return db[handle] ? this.decrypt(db[handle]!) : undefined;
  }
  list(): string[] {
    return Object.keys(this.readDb());
  }
  delete(handle: string) {
    const db = this.readDb();
    delete db[handle];
    this.writeDb(db);
  }
}
