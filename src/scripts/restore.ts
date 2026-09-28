import { restoreBackup, verifyBackup, verifyChecksums } from '../ops/backup.js';

// npm run restore -- [--verify] [--trust-key SHA256:…]… [--accept-unsigned-v1] BACKUP_DIR
// npm run restore -- --verify-checksums [--trust-key …] [--accept-unsigned-v1] SHA256SUMS
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
const verifyOnly = flag('--verify');
const checksums = flag('--verify-checksums');
if (args.some((a) => a.startsWith('--')) || args.length !== 1)
  throw new Error('usage: npm run restore -- [--verify | --verify-checksums] [--trust-key SHA256:…] [--accept-unsigned-v1] /path/to/backup');
const source = args[0]!;
if (checksums) {
  const signer = verifyChecksums(source, { trustKeys, acceptUnsignedV1 });
  console.log(signer ? `checksums signed by ${signer}` : 'checksums are unsigned; accepted with --accept-unsigned-v1');
  process.exit(0);
}
const manifest = verifyOnly ? verifyBackup(source, { trustKeys, acceptUnsignedV1 }) : await restoreBackup(source, { trustKeys, acceptUnsignedV1 });
if (manifest.version === 1) console.log('WARNING: this backup is unsigned (version 1); it was accepted with --accept-unsigned-v1 and cannot be authenticated');
if (verifyOnly) {
  console.log(`backup verified: ${manifest.files.length} files`);
  process.exit(0);
}
console.log(`restore complete: snapshot from ${manifest.createdAt}`);
if (manifest.temporal === 'external') console.log('external Temporal history must be restored by its operator');
if (manifest.objectStore === 'external') console.log('external object storage was not part of this filesystem snapshot');
