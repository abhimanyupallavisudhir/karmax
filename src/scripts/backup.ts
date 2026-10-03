import fs from 'node:fs';
import { createBackup, signChecksums } from '../ops/backup.js';
import { hydrateSecretFiles } from '../config/deployment.js';

// The manifest records the vault key's id (SS-2), read as the app reads it.
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_VAULT_KEY']);

// Flags before the positional destination, so `npm run backup -- --allow-running`
// works and `npm run backup -- /path/to/dir` still does. The live-install guard
// used to tell the operator to "pass allowRunning" while this script accepted no
// way to pass it — an instruction with no corresponding control is a dead end.
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const allowRunning = flag('--allow-running');
const excludeSecrets = flag('--exclude-secrets');
const includeVaultKey = flag('--include-vault-key');
// deploy/karmax: sign a deployment backup's SHA256SUMS (stdin) with this
// installation's backup key, printing the signature (DB-10).
if (flag('--sign-checksums')) {
  process.stdout.write(signChecksums(fs.readFileSync(0)));
  process.exit(0);
}
if (argv.some((a) => a.startsWith('--'))) {
  throw new Error(`unknown option ${argv.find((a) => a.startsWith('--'))}\n`
    + 'usage: npm run backup -- [--allow-running] [--exclude-secrets] [--include-vault-key] [destination] | --sign-checksums < SHA256SUMS');
}

const result = await createBackup({
  destination: argv[0],
  allowRunning,
  excludeSecrets,
  includeVaultKey,
  externalTemporal: Boolean(process.env.KARMAX_TEMPORAL_ADDRESS),
  externalObjectStore: process.env.KARMAX_OBJECT_STORE === 's3',
});
console.log(`backup complete: ${result.directory}`);
console.log(`${result.manifest.files.length} files verified; task worlds excluded (Git/checkpoints are durable)`);
console.log(`signed by ${result.signedBy}; keep this fingerprint off-host to restore onto another host (--trust-key)`);
if (allowRunning) {
  console.log('taken while karmax was running: components are snapshotted at different instants, '
    + 'so this backup is not point-in-time consistent');
}
if (result.manifest.vaultKeyIncluded) {
  console.log('includes vault/vault.key (--include-vault-key): this backup alone decrypts every secret in it');
} else if (result.manifest.vaultKeyIds?.length) {
  console.log(`the vault key is not in this backup: restoring it needs ${result.manifest.vaultKeyIds.join(' or ')}; keep that key off-host`);
}
if (!result.manifest.secretsIncluded) {
  console.log('secrets excluded: the auth secret and plaintext provider logins are not in this backup either');
}
