/**
 * One process of `tests/model-login-race.test.ts`: opens its own Store, vault
 * and broker on the shared database (as the gateway and the activity worker
 * each do on tavya.io), waits for the start line, refreshes the Claude login,
 * and prints the access token it ends with.
 *
 *   node --import tsx tests/helpers/model-login-racer.ts '{"target":…,"vault":…,"root":…,"home":…,"go":…,"managed":true}'
 */
import fs from 'node:fs';
import { Store } from '../../src/store/db.js';
import { CredentialBroker } from '../../src/autonomy/broker.js';
import { Vault } from '../../src/autonomy/vault.js';
import { DatabaseVault } from '../../src/autonomy/vault-database.js';
import { databaseKek } from '../../src/autonomy/vault-backend.js';
import { ModelLogins } from '../../src/autonomy/model-logins.js';
import { RefreshLeases } from '../../src/autonomy/refresh-lease.js';
import { refreshClaudeAccessToken } from '../../src/agent/usage.js';

const config = JSON.parse(process.argv[2]!) as { target: string; vault: string; root: string; home: string; go: string; managed: boolean };
const store = await Store.create(config.target);
const vault = store.db.dialect === 'postgres' ? await DatabaseVault.open(store.db, { kek: databaseKek(config.vault) }) : new Vault(config.vault);
const logins = config.managed ? new ModelLogins(config.root, new CredentialBroker(vault), new RefreshLeases(store.db, { pollMs: 20 })) : undefined;
process.stdout.write('ready\n');
while (!fs.existsSync(config.go)) await new Promise((resolve) => setTimeout(resolve, 2));
let outcome: { token?: string; error?: string };
try { outcome = { token: await refreshClaudeAccessToken({ configHome: config.home, ...(logins ? { logins } : {}) }) }; }
catch (error) { outcome = { error: String((error as Error).message ?? error) }; }
process.stdout.write(`${JSON.stringify(outcome)}\n`);
await store.close();
