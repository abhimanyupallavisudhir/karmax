import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { paths } from '../config/paths.js';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { S3ObjectStore, managedS3Options } from '../store/objects.js';
import {
  formatInventory, inventoryObjects, loadObjectReferences, localObjects, migrateObjects, migrationFailed, openReferenceDatabase,
  type LocalObject,
} from '../ops/object-store-migrate.js';

// npm run migrate-objects -- [--verify-only] [--from-s3] [--concurrency N] [--memory-mb N] [--prefix P]
//                            [--source DIR] [--no-inventory | --inventory-only]
// deploy/karmax migrate-objects runs it in a one-off app container. It copies
// the local object store ($KARMAX_HOME/objects) to the S3 store configured by
// KARMAX_S3_* (whatever KARMAX_OBJECT_STORE says), then lists the local
// objects the database no longer references. --from-s3 copies the bucket back
// into the local store, to roll back to it. It never deletes anything and
// opens the database read-only. Wiki: ops/object-store.
const { values: args } = parseArgs({ options: {
  'verify-only': { type: 'boolean', default: false },
  'from-s3': { type: 'boolean', default: false },
  concurrency: { type: 'string', default: '8' },
  'memory-mb': { type: 'string', default: '256' },
  prefix: { type: 'string', default: '' },
  source: { type: 'string' },
  'no-inventory': { type: 'boolean', default: false },
  'inventory-only': { type: 'boolean', default: false },
} });

hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'),
  ['KARMAX_S3_ACCESS_KEY_ID', 'KARMAX_S3_SECRET_ACCESS_KEY', 'KARMAX_S3_SESSION_TOKEN', 'KARMAX_DATABASE_URL']);
const root = path.resolve(args.source ?? paths().objects);
if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no local object store at ${root}`);

const scan = async () => {
  const objects: LocalObject[] = [];
  for await (const object of localObjects(root)) objects.push(object);
  return objects;
};
let objects = await scan();
let failed = false;
if (!args['inventory-only']) {
  const report = await migrateObjects({ root, objects, target: new S3ObjectStore(managedS3Options()), prefix: args.prefix,
    verifyOnly: args['verify-only'], fromS3: args['from-s3'], concurrency: Number(args.concurrency),
    memoryBytes: Number(args['memory-mb']) * 1024 * 1024 });
  failed = migrationFailed(report);
  if (args['from-s3'] && !args['verify-only']) objects = await scan();
}
if (!args['no-inventory']) {
  const database = process.env.KARMAX_DATABASE_URL?.trim() || path.join(paths().state, 'karmax.db');
  const db = openReferenceDatabase(database);
  try { console.log(formatInventory(inventoryObjects(objects, await loadObjectReferences(db)))); }
  finally { await db.close(); }
}
process.exit(failed ? 1 : 0);
