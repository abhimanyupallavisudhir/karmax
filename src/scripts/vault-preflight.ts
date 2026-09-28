import fs from 'node:fs';
import { paths } from '../config/paths.js';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { inspectVault } from '../autonomy/vault.js';

// npm run vault-preflight -- [VAULT_DIR]
// What this release's first boot would do to the vault, found read-only.
// deploy/karmax update runs it with the candidate image before switching:
// exit 3 (a secret the boot would quarantine) keeps the previous app serving
// unless the operator passes --accept-vault-findings; exit 4 (a refused key, a
// file it cannot read, a vault it cannot open: the boot would fail) always does.
// The key the app will use: $KARMAX_HOME/karmax.env, then NAME_FILE secrets
// (the turnkey app has only KARMAX_VAULT_KEY_FILE), exactly as main.ts reads them.
hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
const dir = process.argv[2] ?? paths().vault;
const report = inspectVault(dir);
const lines: string[] = [];
if (report.key === 'refused') lines.push(`vault key REFUSED: ${report.refusal}`);
else if (report.fatal) lines.push(`cannot open the vault: ${report.fatal}`);
else {
  lines.push(`vault key accepted; ${report.bound ? 'already bound' : `${report.rebind} entr${report.rebind === 1 ? 'y' : 'ies'} to bind`}`);
  for (const entry of report.unreadable) lines.push(`cannot read ${entry.file} (${entry.error}): the first boot would stop`);
  for (const entry of report.quarantine) lines.push(`would quarantine ${entry.file}${entry.handle ? ` (${entry.handle})` : ''}: ${entry.reason}`);
  if (report.oversized?.length) lines.push(`note: ${report.oversized.length} secret(s) over 64 KiB (${report.oversized.join(', ')}) are kept; `
    + 'they can be rewritten only smaller (the CVC split does)');
}
console.log(lines.join('\n'));
process.exit(report.key !== 'accepted' || report.unreadable.length ? 4 : report.quarantine.length ? 3 : 0);
