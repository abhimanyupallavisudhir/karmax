import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { formatSmokeReport, runSmoke, smokeSummaryMarkdown } from '../ops/smoke.js';

// `npm run smoke -- --url https://tavya.io` (wiki ops/release-and-deploy,
// "Smoke test"). The token comes from TAVYA_SMOKE_TOKEN, never a flag, so it
// stays out of process lists. Exit 0: passed; 1: failed; 3: inconclusive (no
// computer was free in time); 2: usage.

const { values } = parseArgs({ options: {
  url: { type: 'string' }, via: { type: 'string' }, project: { type: 'string' },
  'timeout-minutes': { type: 'string' }, 'expiring-within-days': { type: 'string' }, 'require-token': { type: 'boolean' },
  help: { type: 'boolean' },
} });
const usage = 'usage: npm run smoke -- --url <public origin> [--via <http://host:port>] [--project <id>] [--timeout-minutes N] [--expiring-within-days N] [--require-token]\n'
  + 'TAVYA_SMOKE_TOKEN: a personal token limited to the smoke project; without it only the visitor checks run.';
const url = values.url ?? process.env.TAVYA_SMOKE_URL;
if (values.help || !url) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}
const number = (name: string, raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) { console.error(`--${name} must be a positive number`); process.exit(2); }
  return parsed;
};
const timeout = number('timeout-minutes', values['timeout-minutes']);
const token = process.env.TAVYA_SMOKE_TOKEN?.trim() || undefined;
// A caller that holds a token says so, so a token lost on its way here fails
// instead of quietly skipping the signed-in journey.
if (values['require-token'] && !token) {
  console.error('smoke: --require-token, but TAVYA_SMOKE_TOKEN is not set');
  process.exit(2);
}
const report = await runSmoke({
  url, via: values.via, token,
  projectId: values.project ?? (process.env.TAVYA_SMOKE_PROJECT?.trim() || undefined),
  expiringWithinDays: number('expiring-within-days', values['expiring-within-days']),
  ...(timeout ? { journeyTimeoutMs: timeout * 60_000 } : {}),
});
console.log(formatSmokeReport(report));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, smokeSummaryMarkdown(report));
process.exit(report.outcome === 'ok' ? 0 : report.outcome === 'inconclusive' ? 3 : 1);
