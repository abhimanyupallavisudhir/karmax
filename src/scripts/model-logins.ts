import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { Vault, movedToDatabase } from '../autonomy/vault.js';
import { DatabaseVault } from '../autonomy/vault-database.js';
import { databaseKek } from '../autonomy/vault-backend.js';
import { CredentialBroker } from '../autonomy/broker.js';
import { LOGIN_SYNC_FILE, MODEL_LOGIN_PREFIX, ModelLogins, readLoginBundle } from '../autonomy/model-logins.js';
import { openSqlDatabase } from '../store/sql.js';

// Model logins in the vault (data epoch 6; wiki planned/host-local-state),
// read-only: which logins the vault holds, and whether this host's cache of
// each (its config home) agrees. Never prints a credential.
//
//   npm run model-logins -- status
hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_VAULT_KEY']);
try { hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_DATABASE_URL']); } catch { /* SQLite */ }
const p = paths();
const db = openSqlDatabase(process.env.KARMAX_DATABASE_URL ?? path.join(p.state, 'karmax.db'), { readOnly: !process.env.KARMAX_DATABASE_URL });
try {
  if (process.argv[2] !== 'status') throw new Error('usage: npm run model-logins -- status');
  const vault = movedToDatabase(p.vault)
    ? await DatabaseVault.open(db, { kek: databaseKek(p.vault, { readOnly: true }), readOnly: true })
    : new Vault(p.vault, { readOnly: true });
  const broker = new CredentialBroker(vault);
  const logins = new ModelLogins(p.configHomes, broker, db);
  const handles = (await broker.listHandles()).filter((handle) => handle.startsWith(MODEL_LOGIN_PREFIX));
  console.log(`${handles.length} model login${handles.length === 1 ? '' : 's'} in the vault; `
    + `the data epoch 6 import ${await ModelLogins.moved(db) ? 'is done' : 'has not run'}`);
  for (const handle of handles) {
    const login = logins.homeOf(handle);
    if (!login) { console.log(`${handle} (no config home for it)`); continue; }
    const stored = await logins.stored(login);
    const cached = readLoginBundle(login.home, login.provider);
    const cache = cached === undefined ? 'not cached here' : cached === stored ? 'cache in sync' : 'cache differs';
    const files = stored ? Object.keys(JSON.parse(stored).files ?? {}).join(', ') : 'none';
    console.log(`${handle} ${cache}${fs.existsSync(path.join(login.home, LOGIN_SYNC_FILE)) ? '' : ' (never synchronized)'}; files: ${files}`);
  }
} catch (error) {
  console.error(`model-logins: ${(error as Error).message}`);
  await db.close();
  process.exit(1);
}
await db.close();
