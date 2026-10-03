import fs from 'node:fs';
import path from 'node:path';
import { restoreBackup, verifyBackup, verifyDeploymentBackup } from '../ops/backup.js';
import { hydrateSecretFiles } from '../config/deployment.js';

// npm run restore -- [--verify [--check-vault-key]] [--vault-key-file FILE] [--trust-key SHA256:…]… [--accept-unsigned-v1] BACKUP_DIR
// npm run restore -- --verify-deployment [--check-vault-key] [--trust-key …] [--accept-unsigned-v1] DEPLOY_BACKUP_DIR
//   (deploy/karmax: its signed SHA256SUMS, every file listed, and control-plane/)
// Backups do not carry the vault key (SS-2). A restore checks, before it
// changes anything, that the key the app will use opens the backup's vault:
// KARMAX_VAULT_KEY (or KARMAX_VAULT_KEY_FILE), else --vault-key-file (a copy of
// vault/vault.key, installed by the restore), else this home's vault.key.
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_VAULT_KEY']);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const trustKeys: string[] = [];
for (let i; (i = args.indexOf('--trust-key')) >= 0;) {
  const [, key] = args.splice(i, 2);
  if (!key || key.startsWith('--')) throw new Error('--trust-key needs the fingerprint of the key that signed the backup');
  trustKeys.push(key);
}
const acceptUnsignedV1 = flag('--accept-unsigned-v1');
const checkVaultKey = flag('--check-vault-key');
let vaultKeyFile: string | undefined;
const keyAt = args.indexOf('--vault-key-file');
if (keyAt >= 0) {
  vaultKeyFile = args.splice(keyAt, 2)[1];
  if (!vaultKeyFile || vaultKeyFile.startsWith('--')) throw new Error('--vault-key-file needs a copy of vault/vault.key');
}
const verifyOnly = flag('--verify');
const deployment = flag('--verify-deployment');
if (args.some((a) => a.startsWith('--')) || args.length !== 1)
  throw new Error('usage: npm run restore -- [--verify | --verify-deployment] [--check-vault-key] [--vault-key-file FILE] [--trust-key SHA256:…] [--accept-unsigned-v1] /path/to/backup');
const source = args[0]!;
if (deployment) {
  const { manifest, signedBy } = verifyDeploymentBackup(source, { trustKeys, acceptUnsignedV1, checkVaultKey, ...(vaultKeyFile ? { vaultKeyFile } : {}) });
  console.log(signedBy ? `backup signed by ${signedBy}: checksums, ${manifest.files.length} control-plane files verified`
    : 'WARNING: this backup is unsigned; it was accepted with --accept-unsigned-v1 and cannot be authenticated');
  process.exit(0);
}
const unsigned = !fs.existsSync(path.join(source, 'manifest.sig'));
const keyChoice = vaultKeyFile ? { vaultKeyFile } : {};
const manifest = verifyOnly ? verifyBackup(source, { trustKeys, acceptUnsignedV1, checkVaultKey, ...keyChoice })
  : await restoreBackup(source, { trustKeys, acceptUnsignedV1, ...keyChoice });
if (unsigned) console.log('WARNING: this backup is unsigned; it was accepted with --accept-unsigned-v1 and cannot be authenticated');
if (verifyOnly) {
  console.log(`backup verified: ${manifest.files.length} files`);
  process.exit(0);
}
console.log(`restore complete: snapshot from ${manifest.createdAt}`);
if (manifest.temporal === 'external') console.log('external Temporal history must be restored by its operator');
if (manifest.objectStore === 'external') console.log('external object storage was not part of this filesystem snapshot');
