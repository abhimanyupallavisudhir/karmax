import { restoreBackup, verifyBackup } from '../ops/backup.js';

const args = process.argv.slice(2);
const keyIndex = args.indexOf('--key-file');
const keyFile = keyIndex < 0 ? undefined : args.splice(keyIndex, 2)[1];
if (keyIndex >= 0 && !keyFile) throw new Error('--key-file requires the original vault key file');
const verifyOnly = args[0] === '--verify';
const source = args[verifyOnly ? 1 : 0];
if (!source) throw new Error('usage: npm run restore -- /path/to/backup');
const manifest = verifyOnly ? verifyBackup(source, { keyFile }) : await restoreBackup(source, { keyFile });
if (verifyOnly) {
  console.log(`backup verified: ${manifest.files.length} files`);
  process.exit(0);
}
console.log(`restore complete: snapshot from ${manifest.createdAt}`);
if (manifest.temporal === 'external') console.log('external Temporal history must be restored by its operator');
if (manifest.objectStore === 'external') console.log('external object storage was not part of this filesystem snapshot');
