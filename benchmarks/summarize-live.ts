import fs from 'node:fs';
import { benchmarkOutcome } from './latency-validation.js';
import zlib from 'node:zlib';
import { timingReport, distribution, type TimingRow } from '../src/timing/index.js';
const input=process.argv[2]!;
const bytes=fs.readFileSync(input);
const run=JSON.parse((input.endsWith('.gz')?zlib.gunzipSync(bytes):bytes).toString());
const rows:TimingRow[]=run.report.observations;
const byId=new Map(rows.map(row=>[row.id,row]));
for (const sample of run.samples) {
 Object.assign(sample, benchmarkOutcome(sample.scenario, sample.observationIds.map((id:string)=>byId.get(id)).filter(Boolean)));
}
const valid=run.samples.filter((s:any)=>s.valid);
const invalid=run.samples.filter((s:any)=>!s.valid);
const validIds=new Set(valid.flatMap((s:any)=>s.observationIds));
const validReport=timingReport(rows.filter(row=>validIds.has(row.id)));

const fmt=(v:number|null|undefined)=>v==null?'unknown':v.toFixed(1);
const pair=(d:any)=>`${fmt(d.medianMs)} / ${fmt(d.p95Ms)}`;
const lines=[`# Live model latency with fixture services: 2026-09-18`,
'', '**Local-world baseline:** these are local git worlds inside the collector’s E2B environment. For actual deployed tavya.io E2B task provisioning and follow-ups, see [the SaaS E2B collection](latency-e2b-results.md).', '',`Measured ${run.samples.length} successfully completed turns (${valid.length} valid workloads; ${invalid.length} workload mismatches) through an isolated Karmax gateway, real Temporal worker, SQLite, local git worlds, runtime, production direct API adapters, and managed-service gateway. **Real OpenAI/Anthropic models; simulated read-only services.** This is not tavya.io deployment latency, fully live external-service latency, or a Grok comparison.`,
'',`The run used the task #286 candidate based on master 8fbdb43c, in its E2B sandbox: Linux x64, Node ${run.environment.node}, ${run.environment.cpus} available CPUs, approximately 2 GB RAM, Temporal CLI 1.7.2. One turn at a time; provider order alternates by repetition and scenario order rotates. No other tests or builds ran during collection. Local worlds are fresh or reused; worker/gateway remain running. Host memory/load admission gates were disabled only in the isolated harness. Production installation settings were untouched. The workflow uses the harness fixture profile for credential/admission bookkeeping, then dispatches through the real provider adapter. No CLI/SDK startup, cloud-world provisioning, deployment queue contention, or browser paint is measured.`,
'',`Models are the repository defaults, not an installation-wide profile inventory: OpenAI gpt-5.5 (Responses API, reasoning low) and Anthropic claude-sonnet-4-6 (Messages API, output effort low, no explicit extended-thinking configuration). Low effort is not proof of equivalent reasoning behavior. Prompts are compact deterministic fixture instructions; only search_connection_tools and execute_connection_tool are exposed. Output is capped at 512 tokens per request.`,
'',`Fresh means a new world and provider conversation. Follow-up reuses the world: OpenAI resumes its response chain; Anthropic's API reconstructs a stateless request. The session conditions have different provider context semantics and do not establish warm caches. Provider-reported token/cache counters below describe actual usage. No browser was attached.`,
'',`## Request latency`,
'',`All values are milliseconds: gateway receipt → first published assistant text / successful activity completion. These adapters consume non-streamed responses; first text is **not provider first-token latency**. Same-process monotonic clocks cover gateway/worker request durations. Temporal service-to-worker schedule-to-start values remain separate wall-clock estimates.`];

lines.push('', `The tables below exclude ${invalid.length} workload mismatches: the observed number of successful service reads differed from the requested count. All raw observations and their billed usage remain in the export. The prompt in this collection repeated the same instruction on a resumed conversation and said not to repeat completed actions. Some OpenAI follow-ups therefore answered from previous work without rereading. This is a benchmark prompt flaw, not evidence of faster service execution. The reusable harness now explicitly requests a new independent run and checks action counts. Valid follow-up sample counts are shown, including zero; small-cohort p95 is often the maximum.`);
lines.push('', '| Provider | Scenario | World | n | First text median / p95 | Completion median / p95 |', '|---|---|---|---:|---:|---:|');
for(const provider of ['codex','claude']) for(const scenario of ['conversation','one-action','sequential-actions','parallel-actions']) for(const mode of ['fresh-world','reused-world-followup']) {
 const samples=valid.filter((s:any)=>s.provider===provider&&s.scenario===scenario&&s.mode===mode);
 const ids=new Set(samples.flatMap((s:any)=>s.observationIds));
 const report=timingReport(rows.filter(r=>ids.has(r.id)));
 lines.push(`| ${provider==='codex'?'OpenAI':'Anthropic'} | ${scenario} | ${mode==='fresh-world'?'fresh':'follow-up'} | ${samples.length} | ${pair(report.requestFirstResponse)} | ${pair(report.requestCompletion)} |`);
}
lines.push('', '## Stage accounting', '', 'The next table pools fresh and follow-up only to describe stages, not to claim equivalent sessions. Intervals overlap: provider time includes network, provider queuing, inference and response buffering. It also includes the benchmark guard’s local response decoding and usage-checkpoint overhead. It is not pure inference. Work sums can exceed elapsed time; coverage uses interval unions and keeps unattributed time visible.', '', '| Provider | Scenario | Turns | Provider calls per turn | Provider work median ms | Service work median ms | Before activity median ms | Request unattributed median ms |', '|---|---|---:|---:|---:|---:|---:|---:|');
for(const provider of ['codex','claude']) for(const scenario of ['conversation','one-action','sequential-actions','parallel-actions']) {
 const samples=valid.filter((s:any)=>s.provider===provider&&s.scenario===scenario);
 const ids=new Set(samples.flatMap((s:any)=>s.observationIds)); const report=timingReport(rows.filter(r=>ids.has(r.id)));
 const metric=(name:string,key:'sumMs'|'count')=>distribution(report.attempts.map(a=>a.spans.find(s=>s.name===name)?.[key]??0)).medianMs;
 lines.push(`| ${provider==='codex'?'OpenAI':'Anthropic'} | ${scenario} | ${report.attempts.length} | ${fmt(metric('provider.roundtrip','count'))} | ${fmt(metric('provider.roundtrip','sumMs'))} | ${fmt(metric('service.execution','sumMs'))} | ${fmt(distribution(report.requests.map(r=>r.preActivityMs)).medianMs)} | ${fmt(distribution(report.requests.map(r=>r.completionBreakdown?.unattributedMs??null)).medianMs)} |`);
}
lines.push('', '| Measured interval (valid cohorts) | n | Median / p95 ms |', '|---|---:|---:|');
for (const interval of validReport.intervals) if (['world.prepare','world.open','prompt.prepare','admission.host','provider.roundtrip','service.discovery','service.execution','service.lock.wait','service.action.remote'].includes(interval.name)) lines.push(`| ${interval.name} | ${interval.count} | ${pair(interval)} |`);
lines.push('', '| Provider | System prompt characters | Initial message characters | Resolved model identifiers |', '|---|---:|---:|---|');
for (const provider of ['codex','claude']) {
 const attempts=run.report.attempts.filter((a:any)=>a.metadata.provider===provider);
 const range=(key:string)=>{const values=attempts.map((a:any)=>a.metadata[key]).filter((n:unknown)=>typeof n==='number');return `${Math.min(...values)}–${Math.max(...values)}`;};
 const resolved=[...new Set(run.requests.filter((r:any)=>r.provider===provider).map((r:any)=>r.resolvedModel))];
 lines.push(`| ${provider==='codex'?'OpenAI':'Anthropic'} | ${range('systemPromptChars')} | ${range('transcriptChars')} | ${resolved.join(', ')} |`);
}
lines.push('', 'Character counts describe the compact initial snapshot, not serialized tool schemas or server-held response history. Per-request input tokens include the provider context actually billed.');
const providerFractions=validReport.attempts.map(a=>a.totalMs ? (a.spans.find(s=>s.name==='provider.roundtrip')?.sumMs??0)/a.totalMs*100 : null);
const prep=distribution(validReport.requests.map(r=>r.preActivityMs));
const parallelIds=new Set(valid.filter((s:any)=>s.scenario==='parallel-actions').flatMap((s:any)=>s.observationIds));
const parallel=timingReport(rows.filter(r=>parallelIds.has(r.id)));
const overlap=parallel.attempts.map(a=>{const span=a.spans.find(s=>s.name==='service.execution');return span?span.sumMs-span.unionMs:0;});
lines.push('', '## Evidence-backed bottlenecks', '',
 `- Opaque provider round trips occupy a median ${fmt(distribution(providerFractions).medianMs)}% of valid activity time. Model-facing latency dominates this small read-only fixture; that includes network and provider queuing/buffering, not just inference.`,
 `- Request receipt to activity start has median / p95 ${pair(prep)} ms. This remains a measurable orchestration gap, but the trace does not identify all of it as queue residence. Request coverage/unattributed values keep that uncertainty explicit.`,
 `- Batched tool calls are not concurrent service calls on these API rails. Across ${parallel.attempts.length} valid requested-parallel turns, maximum observed service overlap is ${fmt(Math.max(0,...overlap))} ms. Both production direct API adapters await each returned tool call in a loop. Batching can save model continuations without providing service concurrency.`,
 '- First assistant text is delayed until a non-streamed provider response is consumed. Streaming may improve perceived responsiveness, but these measurements cannot quantify that improvement. CLI/SDK paths and browser paint need separate measurements.',
 '- Skipping requested reads makes a resumed turn look artificially fast. Those workload mismatches are excluded rather than counted as a latency improvement. The raw export retains them and their usage for audit.');
lines.push('', '## Usage and collection limits', '', 'Provider-reported usage, summed per real request. Costs are estimates from published standard API prices, not invoices. OpenAI input includes cached tokens; Anthropic input excludes cache reads/writes.', '', '| Provider | Requests | Input tokens | Output tokens | Cache read tokens | Cache write tokens | Estimated USD | Request bytes min–max |', '|---|---:|---:|---:|---:|---:|---:|---:|');
for(const provider of ['codex','claude']) {
 const requests=run.requests.filter((r:any)=>r.provider===provider);
 const cache=(key:string)=>{const vals=requests.map((r:any)=>key==='openai'?r.usage.input_tokens_details?.cached_tokens:r.usage[key]); return vals.every((v:unknown)=>typeof v==='number')?vals.reduce((a:number,b:number)=>a+b,0):'not reported';};
 const sum=(fn:(r:any)=>number)=>requests.reduce((n:number,r:any)=>n+fn(r),0);
 lines.push(`| ${provider==='codex'?'OpenAI':'Anthropic'} | ${requests.length} | ${sum(r=>r.usage.input_tokens)} | ${sum(r=>r.usage.output_tokens)} | ${cache(provider==='codex'?'openai':'cache_read_input_tokens')} | ${provider==='codex'?'not reported':cache('cache_creation_input_tokens')} | ${sum(r=>r.estimatedDollars).toFixed(6)} | ${Math.min(...requests.map((r:any)=>r.requestBytes))}–${Math.max(...requests.map((r:any)=>r.requestBytes))} |`);
}
lines.push('', 'Pricing checked September 18, 2026: [OpenAI GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) ($5 input / $0.50 cached input / $30 output per million tokens); [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) Sonnet 4.6 ($3 input / $0.30 cache read / $3.75 five-minute cache write / $15 output per million tokens). No cache-control directive was added.', '', 'Limits announced before execution: $20 estimated total, 2,000 requests, six model calls per turn, 512 output tokens per request, 32,000 request bytes, and a 60-second request timeout. The first harness start stopped on a normal waiting state before any API call; after correcting that benchmark-only guard, collection restarted. It incurred no model usage.', '', 'Raw content-free observations, cohort membership, environment and per-request usage are in [the compressed export](latency-live-2026-09-18.json.gz). Recompute this table with `npx tsx benchmarks/summarize-live.ts benchmarks/results/latency-live-2026-09-18.json.gz`. See [response timing](../../docs/response-timing.md) for scope and measurement semantics.');
console.log(lines.join('\n'));
