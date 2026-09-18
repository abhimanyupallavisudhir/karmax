import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { timingReport, type TimingRow } from '../timing/index.js';

// Offline only: accepts Timing-tab/API exports (or fixture benchmark exports).
// No credentials, network access or service actions are needed to compare runs.
const files = process.argv.slice(2);
if (!files.length) throw Error('Usage: npm run timing:report -- run-a.json run-b.json');
const rows = files.flatMap(file => {
  const data = JSON.parse((file.endsWith('.gz') ? gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file)).toString('utf8'));
  const observations = data.observations ?? data.report?.observations;
  if (!Array.isArray(observations)) throw Error(`${file}: expected a timing export`);
  return observations as TimingRow[];
});
console.log(JSON.stringify(timingReport(rows), null, 2));
