import { createBackup } from '../ops/backup.js';

const result = await createBackup({
  destination: process.argv[2],
  externalTemporal: Boolean(process.env.KARMAX_TEMPORAL_ADDRESS),
  externalObjectStore: process.env.KARMAX_OBJECT_STORE === 's3',
});
console.log(`backup complete: ${result.directory}`);
console.log(`${result.manifest.files.length} files verified; task worlds excluded (Git/checkpoints are durable)`);
