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

  /**
   * `KARMAX_VAULT_KEY` overrides the on-disk key so a redeployed instance can
   * reopen an existing vault (a container with no persistent vault dir, a
   * restore onto a new host).
   *
   * INTENDED: the value is hashed, NOT stretched. It is key *material*, not a
   * password — it must be high-entropy random (`openssl rand -base64 32`). A
   * KDF here would only buy resistance to guessing a human-chosen phrase, and
   * would silently change the derived key, making every existing vault
   * undecryptable — so the hash stays. A short value is warned about rather than
   * refused: hosted deployments already fail preflight on it
   * (`config/deployment.ts`), and hard-failing here would lock an existing
   * self-hosted user out of a vault that opens fine.
   */
  private loadOrCreateKey(): Buffer {
    const supplied = process.env.KARMAX_VAULT_KEY;
    if (supplied) {
      if (supplied.length < 32) {
        console.warn(
          '[vault] KARMAX_VAULT_KEY is shorter than 32 characters. It is raw key material, '
          + 'not a password, and is not stretched — generate one with `openssl rand -base64 32`.',
        );
      }
      return crypto.createHash('sha256').update(supplied).digest();
    }
    if (fs.existsSync(this.keyPath)) return fs.readFileSync(this.keyPath);
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    return key;
  }

  private readDb(): Record<string, string> {
    if (!fs.existsSync(this.dbPath)) return {};
    // A corrupt or truncated file must surface, not read as an empty vault: the
    // next `put` would rewrite the file with one secret and lose all the others.
    const raw = fs.readFileSync(this.dbPath, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw new Error(`vault ${this.dbPath} is unreadable (${(error as Error).message}); restore it from a backup`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`vault ${this.dbPath} is not a secret map; restore it from a backup`);
    return parsed as Record<string, string>;
  }
  /** Write-to-temp + rename so a crash mid-write can never leave a truncated
   *  vault behind; the mode is applied explicitly because `writeFileSync`'s
   *  `mode` only affects a file it creates. */
  private writeDb(db: Record<string, string>) {
    const tmp = `${this.dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.dbPath);
  }

  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }
  private decrypt(blob: string): string {
    const parts = typeof blob === 'string' ? blob.split('.') : [];
    const iv = parts.length === 3 ? Buffer.from(parts[0]!, 'base64') : Buffer.alloc(0);
    const tag = parts.length === 3 ? Buffer.from(parts[1]!, 'base64') : Buffer.alloc(0);
    if (iv.length !== 12 || tag.length !== 16) throw new Error('vault entry is corrupt (malformed ciphertext)');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64')), decipher.final()]).toString('utf8');
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
