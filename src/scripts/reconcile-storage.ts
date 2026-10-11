import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { paths } from '../config/paths.js';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { LocalObjectStore, S3ObjectStore, managedS3Options, type ObjectStore } from '../store/objects.js';
import { formatBytes, formatInventory, loadObjectReferences, ObjectInventory, RECONCILE_GRACE_MS } from '../store/object-reconciliation.js';
import { openReferenceDatabase } from '../ops/object-store-migrate.js';

// npm run reconcile-storage -- [--orphans N]
// deploy/karmax reconcile-storage runs it in a one-off app container. A dry
// run of the daily reconciliation (store/object-reconciliation.ts): lists the
// managed store (KARMAX_OBJECT_STORE) and classifies every object against the
// database, opened read-only: live, awaiting its delayed delete, written in
// the last day, or untracked; per organization, with the orphans the
// reconciliation would delete with KARMAX_STORAGE_RECONCILE=delete. Never
// writes or deletes anything. Wiki: features/managed-storage.
const { values: args } = parseArgs({ options: { orphans: { type: 'string', default: '20' } } });

hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'),
  ['KARMAX_S3_ACCESS_KEY_ID', 'KARMAX_S3_SECRET_ACCESS_KEY', 'KARMAX_S3_SESSION_TOKEN', 'KARMAX_DATABASE_URL']);
const objects: ObjectStore = process.env.KARMAX_OBJECT_STORE === 's3' ? new S3ObjectStore(managedS3Options()) : new LocalObjectStore(paths().objects);
const db = openReferenceDatabase(process.env.KARMAX_DATABASE_URL?.trim() || path.join(paths().state, 'karmax.db'));
try {
  const now = Date.now();
  const inventory = new ObjectInventory(await loadObjectReferences(db), { now, graceMs: RECONCILE_GRACE_MS, keep: Number.MAX_SAFE_INTEGER });
  for await (const object of objects.list!('')) inventory.add(object);
  const report = inventory.report();
  console.log(formatInventory(report));
  const byOrganization = new Map<string, { count: number; bytes: number }>();
  for (const orphan of report.orphans) {
    const entry = byOrganization.get(orphan.organization ?? '') ?? { count: 0, bytes: 0 };
    entry.count++; entry.bytes += orphan.bytes;
    byOrganization.set(orphan.organization ?? '', entry);
  }
  console.log(`Would delete (KARMAX_STORAGE_RECONCILE=delete, through the delayed delete): ${report.orphans.length} objects, `
    + `${formatBytes(report.unreferenced.bytes)}`);
  for (const [organization, entry] of [...byOrganization].sort(([, a], [, b]) => b.bytes - a.bytes))
    console.log(`  ${organization || '(unattributed)'}: ${entry.count} objects, ${formatBytes(entry.bytes)}`);
  for (const orphan of report.orphans.slice(0, Number(args.orphans))) console.log(`  ${orphan.key} ${formatBytes(orphan.bytes)}`);
} finally { await db.close(); }
