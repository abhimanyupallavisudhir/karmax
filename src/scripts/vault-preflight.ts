import { paths } from '../config/paths.js';
import { inspectVault } from '../autonomy/vault.js';

// npm run vault-preflight -- [VAULT_DIR]
// What this release's first boot would do to the vault, found read-only.
// deploy/karmax update runs it with the candidate image before switching:
// exit 3 (a refused key, an unreadable entry, an entry to quarantine) keeps
// the previous app serving unless the operator passes --accept-vault-findings.
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
