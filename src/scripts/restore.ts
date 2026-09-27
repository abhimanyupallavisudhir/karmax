import { restoreBackup, verifyBackup } from '../ops/backup.js';

const verifyOnly = process.argv[2] === '--verify';
const source = process.argv[verifyOnly ? 3 : 2];
if (!source) throw new Error('usage: npm run restore -- /path/to/backup');
const manifest = verifyOnly ? verifyBackup(source) : await restoreBackup(source);
if (verifyOnly) {
  console.log(`backup verified: ${manifest.files.length} files`);
  process.exit(0);
}
console.log(`restore complete: snapshot from ${manifest.createdAt}`);
if (manifest.temporal === 'external') console.log('external Temporal history must be restored by its operator');
if (manifest.objectStore === 'external') console.log('external object storage was not part of this filesystem snapshot');
