/**
 * Refresh the snapshots the model picker's Compare models chart uses when no
 * key is configured:
 *  - src/agent/model-benchmarks.json — Artificial Analysis (needs a key);
 *  - src/agent/model-task-tokens.json — LiveBench's measured output tokens per
 *    question (public, no key).
 *
 *   ARTIFICIAL_ANALYSIS_API_KEY=… npx tsx scripts/refresh-model-benchmarks.ts
 *
 * Without a key only the LiveBench measurements are refreshed. Keeps only the
 * fields the chart reads, for models released in the year before.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARTIFICIAL_ANALYSIS_URL, LIVEBENCH_URL, trimModels } from '../src/agent/model-benchmarks.js';

// One model per line: small, and a refresh diffs model by model.
const write = (name: string, source: string, fetchedAt: string, data: unknown[]) => {
  const file = fileURLToPath(new URL(`../src/agent/${name}`, import.meta.url));
  fs.writeFileSync(file, `{"source": ${JSON.stringify(source)}, "fetchedAt": ${JSON.stringify(fetchedAt)}, "data": [\n${data.map((row) => JSON.stringify(row)).join(',\n')}\n]}\n`);
  console.log(`${data.length} models → ${file}`);
};

// LiveBench publishes its leaderboard from github.com/LiveBench/new-livebench;
// public/cost_<release>.csv has each model's average output tokens per question.
const listing = await fetch('https://api.github.com/repos/LiveBench/new-livebench/contents/public');
if (!listing.ok) throw new Error(`GitHub returned ${listing.status} listing LiveBench's tables`);
const latest = ((await listing.json()) as Array<{ name: string; download_url: string }>)
  .filter((file) => /^cost_\d{4}_\d{2}_\d{2}\.csv$/.test(file.name)).sort((a, b) => a.name.localeCompare(b.name)).pop();
if (!latest) throw new Error('LiveBench publishes no cost table');
const table = await fetch(latest.download_url);
if (!table.ok) throw new Error(`LiveBench returned ${table.status} for ${latest.name}`);
const [header, ...lines] = (await table.text()).trim().split(/\r?\n/).map((line) => line.split(','));
const column = (name: string) => { const index = header!.indexOf(name); if (index < 0) throw new Error(`${latest.name} has no ${name} column`); return index; };
const model = column('model'), outputTokens = column('avg_output_tokens');
write('model-task-tokens.json', LIVEBENCH_URL, new Date().toISOString(), lines.flatMap((cells) => {
  const tokens = Number(cells[outputTokens]);
  return cells[model] && tokens > 0 ? [{ model: cells[model], outputTokens: Math.round(tokens) }] : [];
}));

const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY || process.env.AA_API_KEY;
if (!key) {
  console.log('No ARTIFICIAL_ANALYSIS_API_KEY: kept the Artificial Analysis snapshot');
} else {
  const response = await fetch(ARTIFICIAL_ANALYSIS_URL, { headers: { 'x-api-key': key } });
  if (!response.ok) throw new Error(`Artificial Analysis returned ${response.status}`);
  const body = await response.json() as { data?: unknown };
  const fetchedAt = new Date().toISOString();
  write('model-benchmarks.json', 'https://artificialanalysis.ai/', fetchedAt, trimModels(body.data, Date.parse(fetchedAt)));
}
