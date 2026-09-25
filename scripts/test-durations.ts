/** Refreshes tests/durations.json, which balances CI's test shards, from the
 *  Vitest output of a CI run. Feed it every shard's log, for example:
 *
 *    gh run view <run-id> --log | npm run test:durations
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DURATIONS_FILE, mergeDurations, parseReporterDurations, readDurations,
} from '../tests/helpers/duration-sequencer.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const measured = parseReporterDurations(fs.readFileSync(0, 'utf8'));
const count = Object.keys(measured).length;
if (!count) {
  console.error('No Vitest file results on stdin; pass the log of a CI run.');
  process.exit(1);
}
const durations = mergeDurations(readDurations(root), measured, (file) => fs.existsSync(path.join(root, file)));
fs.writeFileSync(path.join(root, DURATIONS_FILE), `${JSON.stringify(durations, null, 2)}\n`);
console.log(`Updated ${count} of ${Object.keys(durations).length} test files in ${DURATIONS_FILE}.`);
