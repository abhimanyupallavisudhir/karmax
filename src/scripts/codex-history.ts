import path from 'node:path';
import { codexHistoryMetadata, prepareCodexHistory } from '../agent/codex-history.js';
import { installLocalCodexSnapshot, localCodexFiles, readLocalCodexHistory } from '../agent/codex-history-files.js';
import fs from 'node:fs';

// Explicit operator utility. Audit is read-only; --repair publishes fresh
// identities and provenance manifests while retaining every original byte.
const args = process.argv.slice(2);
const homeIndex = args.indexOf('--home');
if (homeIndex < 0 || !args[homeIndex + 1]) throw new Error('usage: tsx src/scripts/codex-history.ts --home CODEX_HOME [--repair]');
const home = path.resolve(args[homeIndex + 1]!);
const repair = args.includes('--repair');
const identities = new Set<string>();
const failures: Array<{ file?: string; session?: string; error: string }> = [];
for (const file of localCodexFiles(home)) {
  try { const meta = codexHistoryMetadata(fs.readFileSync(file)); identities.add(meta.id ?? meta.session_id); }
  catch (error) { failures.push({ file, error: String(error) }); }
}
const mappings: Array<{ original: string; session: string; repaired: boolean; records: number }> = [];
for (const session of identities) {
  try {
    const snapshot = await prepareCodexHistory(session, async (id) => readLocalCodexHistory(home, id));
    if (!snapshot) continue;
    if (repair) installLocalCodexSnapshot(home, session, snapshot);
    mappings.push({ original: session, session: snapshot.session, repaired: snapshot.repaired,
      records: snapshot.content.toString().trimEnd().split('\n').length });
  } catch (error) { failures.push({ session, error: String(error) }); }
}
console.log(JSON.stringify({ mode: repair ? 'repair' : 'audit', sessions: identities.size, mappings, failures }, null, 2));
if (failures.length) process.exitCode = 1;
