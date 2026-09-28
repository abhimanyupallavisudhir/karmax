import fs from 'node:fs';
import { paths } from '../config/paths.js';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { inspectVault } from '../autonomy/vault.js';

// npm run vault-preflight -- [VAULT_DIR]
// What this release's first boot would do to the vault, found read-only.
// deploy/karmax update runs it with the candidate image before switching:
// exit 3 (a refused key, an unreadable entry, an entry to quarantine) keeps
// the previous app serving unless the operator passes --accept-vault-findings.
// The key the app will use: $KARMAX_HOME/karmax.env, then NAME_FILE secrets
// (the turnkey app has only KARMAX_VAULT_KEY_FILE), exactly as main.ts reads them.
hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
const dir = process.argv[2] ?? paths().vault;
const report = inspectVault(dir);
const lines: string[] = [];
if (report.key === 'refused') lines.push(`vault key REFUSED: ${report.refusal}`);
else {
  lines.push(`vault key accepted; ${report.bound ? 'already bound' : `${report.rebind} entr${report.rebind === 1 ? 'y' : 'ies'} to bind`}`);
  for (const entry of report.unreadable) lines.push(`cannot read ${entry.file} (${entry.error}): the first boot would stop`);
  for (const entry of report.quarantine) lines.push(`would quarantine ${entry.file}${entry.handle ? ` (${entry.handle})` : ''}: ${entry.reason}`);
}
console.log(lines.join('\n'));
process.exit(report.key === 'refused' || report.unreadable.length || report.quarantine.length ? 3 : 0);
