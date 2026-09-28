import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Backup signatures (DB-10). A manifest's hashes prove a payload matches the
 * manifest, but anyone who can write the backup can rewrite both; a signature
 * proves this installation wrote them.
 *
 * The key is an Ed25519 key of its own, at the root of the data home, outside
 * every component a backup copies, so no backup carries it and no restore
 * replaces it. It is not the vault key: an HMAC under the vault key (c7bbd52b)
 * meant a fresh host could verify a backup only with that key kept off-host
 * as well. Trust here is a public-key fingerprint, which is not secret: keep
 * it in the recovery runbook, and pass it with `--trust-key` to restore onto a
 * host that does not hold the key.
 */
export const SIGNING_KEY_FILE = 'backup-signing.key';

export interface BackupSignature {
  algorithm: 'ed25519';
  /** SPKI DER, base64. */
  publicKey: string;
  signature: string;
}

const keyPath = (home: string) => path.join(home, SIGNING_KEY_FILE);

/** `SHA256:<base64>` of a public key's SPKI DER, like an OpenSSH fingerprint. */
export function keyFingerprint(spki: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(spki).digest('base64').replace(/=+$/, '')}`;
}

function readKey(home: string): crypto.KeyObject | undefined {
  try { return crypto.createPrivateKey(fs.readFileSync(keyPath(home), 'utf8')); }
  catch (e: any) { if (e?.code === 'ENOENT') return undefined; throw new Error(`backup signing key is unreadable: ${e?.message ?? e}`); }
}

function signingKey(home: string): crypto.KeyObject {
  const existing = readKey(home);
  if (existing) return existing;
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = keyPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  try { fs.linkSync(temporary, file); } catch (e: any) { if (e?.code !== 'EEXIST') throw e; } // a concurrent first backup won
  finally { fs.rmSync(temporary, { force: true }); }
  return readKey(home)!;
}

const publicDer = (key: crypto.KeyObject) => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
const message = (domain: string, bytes: Buffer | string) => Buffer.concat([Buffer.from(`${domain}\0`), Buffer.from(bytes)]);

/** The fingerprint of this installation's signing key, if it has one. */
export function localSigningFingerprint(home: string): string | undefined {
  const key = readKey(home);
  return key && keyFingerprint(publicDer(key));
}

/** Sign `bytes` for `domain`, creating the installation's key on first use. */
export function signBackupBytes(home: string, domain: string, bytes: Buffer | string): { signature: BackupSignature; fingerprint: string } {
  const key = signingKey(home);
  const spki = publicDer(key);
  return { fingerprint: keyFingerprint(spki), signature: { algorithm: 'ed25519', publicKey: spki.toString('base64'),
    signature: crypto.sign(null, message(domain, bytes), key).toString('base64') } };
}

/** Check a signature, and that its key is this installation's or one the operator named. Returns its fingerprint. */
export function verifyBackupBytes(home: string, domain: string, bytes: Buffer | string, signatureText: string, trustKeys: string[] = []): string {
  let parsed: BackupSignature;
  try { parsed = JSON.parse(signatureText); } catch { throw new Error('backup signature is unreadable'); }
  if (parsed?.algorithm !== 'ed25519' || typeof parsed.publicKey !== 'string' || typeof parsed.signature !== 'string')
    throw new Error('backup signature is unreadable');
  const spki = Buffer.from(parsed.publicKey, 'base64');
  const fingerprint = keyFingerprint(spki);
  let valid = false;
  try { valid = crypto.verify(null, message(domain, bytes), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(parsed.signature, 'base64')); }
  catch { valid = false; }
  if (!valid) throw new Error('backup signature does not match its contents; the backup was altered');
  // A damaged local key must not block a restore the operator vouches for by fingerprint.
  let local: string | undefined;
  try { local = localSigningFingerprint(home); }
  catch (error) { console.warn(`[backup] ${(error as Error).message}; trusting only the keys named for this restore`); }
  const trusted = new Set([...trustKeys, ...(process.env.KARMAX_BACKUP_TRUSTED_KEYS ?? '').split(/[\s,]+/), local].filter(Boolean));
  if (!trusted.has(fingerprint))
    throw new Error(`backup was signed by ${fingerprint}, which this installation does not trust. `
      + 'If that is the fingerprint you recorded for the installation that took it, restore with `--trust-key ' + fingerprint + '`');
  return fingerprint;
}
