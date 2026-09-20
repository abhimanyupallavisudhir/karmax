import fs from 'node:fs';
import zlib from 'node:zlib';
import { distribution } from '../src/timing/index.js';
const file = process.argv[2]!;
const bytes = fs.readFileSync(file);
const run = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString());
const fmt = (n: number | null | undefined) => n == null ? 'unknown' : (n / 1000).toFixed(2);
const stat = (values: Array<number | null>) => {
  const d = distribution(values); return `${fmt(d.medianMs)} / ${fmt(d.p95Ms)}`;
};
console.log('| Cohort | n | Receipt → first text median / p95 s | Receipt → completion median / p95 s | Before activity median / p95 s |');
console.log('|---|---:|---:|---:|---:|');
for (const mode of ['parked', 'immediate-review']) {
  const samples = run.samples.filter((s: any) => s.mode === mode);
  const requests = samples.map((s: any) => run.report.requests.find((q: any) => q.requestId === s.requestId));
  console.log(`| ${mode} | ${samples.length} | ${stat(requests.map((q: any) => q.firstTextMs))} | ${stat(requests.map((q: any) => q.completionMs))} | ${stat(requests.map((q: any) => q.preActivityMs))} |`);
}
console.log('\nIntervals below overlap and must not be added. Values are seconds.');
console.log('\n| Cohort | World open median | Prompt preparation median | Adapter → process-start boundary median | CLI roundtrip median |');
console.log('|---|---:|---:|---:|---:|');
for (const mode of ['parked', 'immediate-review']) {
  const ids = new Set(run.samples.filter((s: any) => s.mode === mode).map((s: any) => s.requestId));
  const attempts = run.report.attempts.filter((a: any) => a.requestIds?.some((id: string) => ids.has(id)));
  const median = (name: string) => fmt(distribution(attempts.map((a: any) => a.spans.find((s: any) => s.name === name)?.sumMs ?? null)).medianMs);
  const bootstrap = distribution(attempts.map((a: any) => {
    const rows = run.report.observations.filter((r: any) => r.traceId === a.traceId);
    const begin = rows.find((r: any) => r.name === 'adapter.invoked');
    const spawn = rows.find((r: any) => r.name === 'process.startup' && r.phase === 'start');
    return begin && spawn && begin.clockId === spawn.clockId ? spawn.monoMs - begin.monoMs : null;
  })).medianMs;
  console.log(`| ${mode} | ${median('world.open')} | ${median('prompt.prepare')} | ${fmt(bootstrap)} | ${median('provider.cli-roundtrip.opaque')} |`);
}

console.log('\n| Cohort | Review published → receipt median s (wall estimate) | Receipt → prior park completion median s (wall estimate) |');
console.log('|---|---:|---:|');
for (const mode of ['parked', 'immediate-review']) {
  const samples = run.samples.filter((s: any) => s.mode === mode);
  console.log(`| ${mode} | ${fmt(distribution(samples.map((s: any) => s.reviewToReceiptWallMs ?? null)).medianMs)} | ${fmt(distribution(samples.map((s: any) => s.pendingParkWallMs ?? null)).medianMs)} |`);
}
