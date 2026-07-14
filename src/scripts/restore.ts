import { restoreBackup } from '../ops/backup.js';

const source = process.argv[2];
if (!source) throw new Error('usage: npm run restore -- /path/to/backup');
const manifest = await restoreBackup(source);
console.log(`restore complete: snapshot from ${manifest.createdAt}`);
if (manifest.temporal === 'external') console.log('external Temporal history must be restored by its operator');
if (manifest.objectStore === 'external') console.log('external object storage was not part of this filesystem snapshot');
