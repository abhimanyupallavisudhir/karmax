import fs from 'node:fs';
import { paths } from '../config/paths.js';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { Vault, movedToDatabase } from '../autonomy/vault.js';
import { DatabaseVault } from '../autonomy/vault-database.js';
import { databaseKek } from '../autonomy/vault-backend.js';
import type { SecretVault } from '../autonomy/vault-crypto.js';
import { LocalKek, isVaultScope, type KekSource } from '../autonomy/vault-keys.js';
import { openSqlDatabase, type SqlDatabase } from '../store/sql.js';

// Vault key operations (SS-1, wiki features/vault-encryption). The key is the
// one the app reads: $KARMAX_HOME/karmax.env, then KARMAX_VAULT_KEY_FILE, else
// vault/vault.key.
//
//   npm run vault-key -- [--vault DIR] status
//   npm run vault-key -- [--vault DIR] add NEW_KEY_FILE    KEK rotation 1: wrap every data key under the new key
//   npm run vault-key -- [--vault DIR] prune               KEK rotation 3, run with the new key: drop other keys' wraps
//   npm run vault-key -- [--vault DIR] rotate-data-key SCOPE | --all
//
// Step 2 is the switch: the app restarts with the new key (deploy/karmax
// rotate-vault-key runs all three). Every step is repeatable after a crash, and
// the old key opens everything until prune. Once the vault has moved into the
// application database (data epoch 5), the same commands work on it there.
hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_VAULT_KEY']);
try { hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_DATABASE_URL']); } catch { /* not needed for a file vault */ }
const args = process.argv.slice(2);
let dir = paths().vault;
const at = args.indexOf('--vault');
if (at >= 0) { dir = args[at + 1] ?? ''; args.splice(at, 2); }
let db: SqlDatabase | undefined;
/** The live vault: the file vault, or the database vault once the directory is retired. */
async function open(options: { kek?: KekSource; readOnly?: boolean } = {}): Promise<SecretVault> {
  if (!movedToDatabase(dir)) return new Vault(dir, options);
  const url = process.env.KARMAX_DATABASE_URL;
  if (!url) throw new Error('the vault is in the application database: set KARMAX_DATABASE_URL or KARMAX_DATABASE_URL_FILE');
  db ??= openSqlDatabase(url);
  return DatabaseVault.open(db, { kek: options.kek ?? databaseKek(dir, { readOnly: options.readOnly }), readOnly: options.readOnly });
}
const usage = 'usage: npm run vault-key -- [--vault DIR] status | add NEW_KEY_FILE | prune | rotate-data-key SCOPE|--all';
const [command, argument] = args;
try {
  if (!dir || !command) throw new Error(usage);
  if (command === 'status') {
    const status = await (await open({ readOnly: true })).keyStatus();
    console.log(`vault key ${status.kek}; ${status.scoped ? 'every secret is under a data key' : 'the data epoch 4 migration has not finished'}`);
    console.log(`${status.keyrings} keyrings; data keys wrapped under: ${Object.entries(status.wraps).map(([id, n]) => `${id} (${n})`).join(', ') || 'none'}`);
    console.log(`canaries: ${status.canaries.join(', ') || 'none'}`);
  } else if (command === 'add') {
    if (!argument) throw new Error(usage);
    const next = LocalKek.fromText(fs.readFileSync(argument, 'utf8').trimEnd());
    const live = databaseKek(dir, { readOnly: true });
    const vault = await open({ kek: { current: next, others: [live.current, ...live.others].filter((kek) => kek.id !== next.id) } });
    const { wrapped } = await vault.wrapUnderCurrentKek();
    console.log(`${wrapped} data keys wrapped under ${next.id}; ${live.current.id} still opens them until prune`);
  } else if (command === 'prune') {
    const { pruned } = await (await open()).pruneKeks();
    console.log(pruned.length ? `removed the wraps and canaries of ${pruned.join(', ')}` : 'no other vault key wraps remain');
  } else if (command === 'rotate-data-key') {
    const vault = await open();
    const scopes = argument === '--all' ? (await vault.keyStatus()).scopes : [argument];
    for (const scope of scopes) {
      if (!isVaultScope(scope)) throw new Error(`not a vault scope: ${scope} (installation, organization:<id> or user:<id>)`);
      const { reencrypted, retired } = await vault.rotateDataKey(scope);
      console.log(`${scope}: ${reencrypted} entries re-encrypted; retired ${retired.join(', ') || 'nothing'}`);
    }
  } else throw new Error(usage);
} catch (error) {
  console.error(`vault-key: ${(error as Error).message}`);
  await db?.close();
  process.exit(1);
}
await db?.close();
