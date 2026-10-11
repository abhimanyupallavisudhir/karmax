import fs from 'node:fs';
import path from 'node:path';
import type { SqlDatabase } from '../store/sql.js';
import { RETIRED_VAULT, Vault, movedToDatabase, recordQuarantine, recordScopeMigration, type QuarantinedEntry, type ScopeMigration } from './vault.js';
import { DatabaseVault, upsertVaultRows } from './vault-database.js';
import { isVaultScope, kekFromEnvironment, type KekSource, type VaultScope } from './vault-keys.js';
import type { SecretVault } from './vault-crypto.js';

/**
 * Which vault an installation uses (wiki planned/host-local-state, step 1):
 * the database vault whenever the application database is PostgreSQL (hosted,
 * or a self-host on PostgreSQL), so every process and host shares one vault
 * without a host-local lock; the file vault on SQLite, where one host is the
 * supported shape.
 */
export const VAULT_MOVED_MARKER = 'migration:vault-to-database:v1';

export interface VaultBoot {
  /** Owners of handles from before data epoch 4 (`resolveVaultScopes`). */
  resolveScopes: (handles: string[]) => Promise<Map<string, VaultScope>>;
  audit: (action: 'vault.scopes.migrated' | 'vault.entry.quarantined' | 'vault.moved-to-database', detail: Record<string, unknown>) => Promise<unknown>;
  log?: (line: string) => void;
}

export interface VaultMove { entries: number; keyrings: number; quarantined: number }

/** Is the vault still to be moved into this database (or has it been)? */
export async function vaultMoved(db: SqlDatabase): Promise<boolean> {
  return !!await db.prepare('SELECT v FROM kv WHERE k = ?').get(VAULT_MOVED_MARKER);
}

/**
 * The installation's vault. `boot` (the primary process only) runs the
 * one-way migrations first: the file vault's epoch 3 and 4 steps, and on
 * PostgreSQL the epoch 5 move into the database. A secondary process (the
 * activity worker) only attaches, and refuses a vault the primary has not moved.
 */
export async function openSecretVault(dir: string, db: SqlDatabase, boot?: VaultBoot): Promise<SecretVault> {
  if (db.dialect !== 'postgres') {
    const vault = new Vault(dir);
    if (boot) await prepareFileVault(vault, boot);
    return vault;
  }
  const kek = databaseKek(dir);
  if (boot) {
    const moved = await moveVaultToDatabase(dir, db, kek, boot);
    if (moved?.entries) boot.log?.(`Vault: moved ${moved.entries} secret${moved.entries === 1 ? '' : 's'} into the database (data epoch 5)`);
  } else if (!await vaultMoved(db)) {
    throw new Error('the vault has not moved into the database yet: the primary process moves it on its first boot of data epoch 5');
  }
  const retired = path.join(dir, RETIRED_VAULT);
  const vault = await DatabaseVault.open(db, { kek, retired });
  if (boot) {
    await vault.sweepQuarantine();
    await sweepRetired(db, retired);
  }
  return vault;
}

/** Scopes shredded in the database whose retired files a crash left behind. */
async function sweepRetired(db: SqlDatabase, retired: string): Promise<void> {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(retired, 'keys')).filter((name) => name.endsWith('.json')); } catch { return; }
  for (const name of names) {
    let scope: unknown;
    try { scope = JSON.parse(fs.readFileSync(path.join(retired, 'keys', name), 'utf8')).scope; } catch { continue; }
    if (isVaultScope(scope) && !await db.prepare('SELECT 1 AS present FROM vault_keyrings WHERE scope = ?').get(scope))
      Vault.shredRetired(retired, scope);
  }
}

/** The KEK as the app reads it: `KARMAX_VAULT_KEY`, else `vault/vault.key`
 * (created on first use; a self-host's only copy of its key). */
export function databaseKek(dir: string, options: { readOnly?: boolean } = {}): KekSource {
  if (!process.env.KARMAX_VAULT_KEY && !options.readOnly) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return kekFromEnvironment(dir, options);
}

/** The file vault's own one-way migrations (data epochs 3 and 4), each
 * reported to the audit log before it is acknowledged. */
async function prepareFileVault(vault: Vault, boot: VaultBoot): Promise<void> {
  const scoped = await recordScopeMigration(vault, boot.resolveScopes, (report: ScopeMigration) => boot.audit('vault.scopes.migrated', {
    migrated: report.migrated, byScope: report.byScope, unresolved: report.unresolved.length, unresolvedHandles: report.unresolved.slice(0, 500) }));
  if (scoped?.migrated) boot.log?.(`Vault: ${scoped.migrated} secrets moved under per-owner data keys`
    + (scoped.unresolved.length ? `; ${scoped.unresolved.length} with no owner found stay under the installation key (audit log: vault.scopes.migrated)` : ''));
  // Binds ciphertext written before AU-27 to its handle; what will not open is quarantined, loudly.
  await recordQuarantine(vault, (entry: QuarantinedEntry) => boot.audit('vault.entry.quarantined', { ...entry }));
}

/** Does the directory hold a vault to move (rather than nothing, or only a key)? */
function holdsVault(dir: string): boolean {
  const has = (sub: string, test: (name: string) => boolean) => { try { return fs.readdirSync(`${dir}/${sub}`).some(test); } catch { return false; } };
  return has('entries', (name) => name.endsWith('.json')) || has('keys', (name) => name.endsWith('.json') || name.endsWith('.canary'))
    || (fs.existsSync(`${dir}/secrets.json`) && !movedToDatabase(dir));
}

/**
 * Data epoch 5: move the file vault into the database, resumably.
 *
 * 1. The file vault finishes its own migrations, so every secret is `v3.`
 *    ciphertext under its scope's data key.
 * 2. Every row is upserted verbatim: nothing is decrypted to copy it.
 * 3. Every secret and revision is read back through the database vault and
 *    compared, in memory, with the file vault's.
 * 4. The marker row commits: from here the database is the vault.
 * 5. The directory is retired (`Vault.retire`).
 *
 * A crash before 4 leaves the files authoritative and the next boot repeats
 * 2–3 (the upsert overwrites); after 4 it only finishes 5. `step` lets tests
 * interrupt it.
 */
export async function moveVaultToDatabase(dir: string, db: SqlDatabase, kek: KekSource, boot: VaultBoot,
  step: (name: 'copied' | 'verified' | 'marked') => void = () => {}): Promise<VaultMove | undefined> {
  if (await vaultMoved(db)) { Vault.retire(dir); return undefined; }
  if (!holdsVault(dir)) {
    await mark(db, { entries: 0, keyrings: 0, quarantined: 0 });
    if (fs.existsSync(dir)) Vault.retire(dir);
    return { entries: 0, keyrings: 0, quarantined: 0 };
  }
  const file = new Vault(dir, { kek });
  await prepareFileVault(file, boot);
  const rows = await file.exportRows();
  // Entries the export had to quarantine reach the audit log too.
  await recordQuarantine(file, (entry: QuarantinedEntry) => boot.audit('vault.entry.quarantined', { ...entry }));
  await upsertVaultRows(db, rows);
  step('copied');
  const database = await DatabaseVault.open(db, { kek });
  // The same outcome for every secret and revision: the same value, or (for one
  // the file vault cannot open either) no value. A copy keeps what it copies.
  const outcome = (read: Promise<string | undefined>) => read.then((value) => ({ value }), () => ({ unreadable: true }));
  for (const entry of rows.entries)
    for (let revision = 0; revision <= entry.previous.length; revision++) {
      const before = await outcome(file.reveal(entry.handle, revision));
      const after = await outcome(database.reveal(entry.handle, revision));
      if (JSON.stringify(before) !== JSON.stringify(after) || await database.scopeOf(entry.handle) !== entry.scope)
        throw new Error(`the vault entry for ${entry.handle} does not read back the same from the database; `
          + 'the file vault is unchanged and still the vault. Nothing was lost; report this before restarting');
    }
  step('verified');
  const report = { entries: rows.entries.length, keyrings: rows.keyrings.length, quarantined: rows.quarantine.length };
  // Audited first: a crash before the marker repeats the move, and at worst this row.
  await boot.audit('vault.moved-to-database', { ...report });
  await mark(db, report);
  step('marked');
  Vault.retire(dir);
  return report;
}

async function mark(db: SqlDatabase, report: VaultMove): Promise<void> {
  await db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING')
    .run(VAULT_MOVED_MARKER, JSON.stringify({ at: new Date().toISOString(), ...report }));
}
