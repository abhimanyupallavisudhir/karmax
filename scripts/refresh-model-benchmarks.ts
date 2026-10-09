/**
 * Refresh the bundled Artificial Analysis snapshot (src/agent/model-benchmarks.json)
 * that the model picker's Compare models chart uses when no key is configured.
 *
 *   ARTIFICIAL_ANALYSIS_API_KEY=… npx tsx scripts/refresh-model-benchmarks.ts
 *
 * Keeps only the fields the chart reads, for models released in the year before.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARTIFICIAL_ANALYSIS_URL, trimModels } from '../src/agent/model-benchmarks.js';

const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY || process.env.AA_API_KEY;
if (!key) throw new Error('set ARTIFICIAL_ANALYSIS_API_KEY');
const response = await fetch(ARTIFICIAL_ANALYSIS_URL, { headers: { 'x-api-key': key } });
if (!response.ok) throw new Error(`Artificial Analysis returned ${response.status}`);
const body = await response.json() as { data?: unknown };
const fetchedAt = new Date().toISOString();
const data = trimModels(body.data, Date.parse(fetchedAt));
const file = fileURLToPath(new URL('../src/agent/model-benchmarks.json', import.meta.url));
// One model per line: small, and a refresh diffs model by model.
fs.writeFileSync(file, `{"source": "https://artificialanalysis.ai/", "fetchedAt": ${JSON.stringify(fetchedAt)}, "data": [\n${data.map((row) => JSON.stringify(row)).join(',\n')}\n]}\n`);
console.log(`${data.length} models → ${file}`);
