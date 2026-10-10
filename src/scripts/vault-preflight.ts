import fs from 'node:fs';
import { paths } from '../config/paths.js';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { inspectVault } from '../autonomy/vault.js';
import { DatabaseVault } from '../autonomy/vault-database.js';
import { databaseKek, vaultMoved } from '../autonomy/vault-backend.js';
import { VaultKeyRefused } from '../autonomy/vault-crypto.js';
import { isPostgresTarget, openSqlDatabase } from '../store/sql.js';

// npm run vault-preflight -- [VAULT_DIR]
// What this release's first boot would do to the vault, found read-only.
// deploy/karmax update runs it with the candidate image before switching:
// exit 3 (a secret the boot would quarantine) keeps the previous app serving
// unless the operator passes --accept-vault-findings; exit 4 (a refused key, a
// file it cannot read, a vault it cannot open: the boot would fail) always does.
// Moving secrets under per-owner data keys (data epoch 4) is reported, not a
// finding: the boot reads the owners from the database, which this cannot.
// The first boot on PostgreSQL moves the vault into the application database
// (data epoch 5); once it has, the key is checked against the database's copy.
// The key the app will use: $KARMAX_HOME/karmax.env, then KARMAX_VAULT_KEY_FILE
// (all the turnkey app has), exactly as main.ts reads it. The database URL only
// if it exists already: this runs before the release has started, and on the
// first deployment of PostgreSQL support it does not.
hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_VAULT_KEY']);
try { hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_DATABASE_URL']); } catch { /* not there yet */ }
const dir = process.argv[2] ?? paths().vault;
const databaseUrl = process.env.KARMAX_DATABASE_URL && isPostgresTarget(process.env.KARMAX_DATABASE_URL) ? process.env.KARMAX_DATABASE_URL : undefined;
let report: ReturnType<typeof inspectVault>;
try { report = inspectVault(dir); }
catch (error) {
  // Whatever stops the inspection would stop the boot too: fatal, not a stack trace.
  console.log(`cannot inspect the vault: ${(error as Error).message}`);
  process.exit(4);
}
if (report.movedToDatabase) {
  if (!databaseUrl) {
    console.log('the vault is in the application database; without its URL here, the boot checks the key');
    process.exit(0);
  }
  const db = openSqlDatabase(databaseUrl);
  let status = 0;
  try {
    if (!await vaultMoved(db)) throw new Error('the vault directory is retired, but the database does not hold the vault: restore the pre-update backup');
    await DatabaseVault.open(db, { kek: databaseKek(dir, { readOnly: true }), readOnly: true });
    console.log('vault key accepted; the vault is in the application database');
  } catch (error) {
    console.log(error instanceof VaultKeyRefused ? `vault key REFUSED: ${error.message}` : `cannot open the vault: ${(error as Error).message}`);
    status = 4;
  }
  await db.close();
  process.exit(status);
}
const lines: string[] = [];
if (report.key === 'refused') lines.push(`vault key REFUSED: ${report.refusal}`);
else if (report.fatal) lines.push(`cannot open the vault: ${report.fatal}`);
else {
  lines.push(`vault key accepted; ${report.bound ? 'already bound' : `${report.rebind} entr${report.rebind === 1 ? 'y' : 'ies'} to bind`}`);
  if (report.toScopes) lines.push(`${report.toScopes} entr${report.toScopes === 1 ? 'y' : 'ies'} to move under per-owner data keys (data epoch 4)`);
  if (databaseUrl) lines.push('the first boot moves the vault into the application database (data epoch 5)');
  for (const entry of report.unreadable) lines.push(`cannot read ${entry.file} (${entry.error}): the first boot would stop`);
  for (const entry of report.quarantine) lines.push(`would quarantine ${entry.file}${entry.handle ? ` (${entry.handle})` : ''}: ${entry.reason}`);
  if (report.oversized?.length) lines.push(`note: ${report.oversized.length} secret(s) over 64 KiB (${report.oversized.join(', ')}) are kept; `
    + 'they can be rewritten only smaller (the CVC split does)');
}
console.log(lines.join('\n'));
process.exit(report.key !== 'accepted' || report.fatal || report.unreadable.length ? 4 : report.quarantine.length ? 3 : 0);
