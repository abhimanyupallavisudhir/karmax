# Benchmark results

Content-free timing exports (monotonic spans, request ids; no prompts, service
contents or credentials) and the reports generated from them. The measurement
contract is [docs/response-timing.md](../../docs/response-timing.md); what these
runs found, what shipped and what remains is summarised in the project wiki page
`ops/performance-history`. They are small diagnostic samples on tavya.io, not
statistical benchmarks.

## Generated reports

- [latency-fixture-results.md](latency-fixture-results.md) — offline fixture run (`latency-fixture-2026-09-17.json.gz`).
- [latency-live-results.md](latency-live-results.md) — isolated gateway with real models (`latency-live-2026-09-18.json.gz`, `benchmarks/summarize-live.ts`).
- [latency-e2b-results.md](latency-e2b-results.md) — deployed tavya.io into real E2B worlds (`e2b-*-2026-09-19.*`, `benchmarks/summarize-e2b.ts`).

## Raw exports without a generated report

Start-up investigation, 2026-09-20 (tasks #306–#311, stock image, Codex low effort):

- `e2b-investigation-2026-09-20.json.gz` — #306 baseline turns.
- `e2b-browser-investigation-2026-09-20.json.gz` — #307 baseline with the browser MCP.
- `e2b-followup-optimized-2026-09-20.json.gz` — #308 follow-ups with batched wiki reads.
- `e2b-prebuilt-failed-2026-09-20.json.gz` — #309 failed browser setup (high effort by mistake; setup traces only).
- `e2b-prebuilt-serial-2026-09-20.json.gz` — #310 prebuilt-template setup, serial transfers (setup traces only).
- `e2b-prebuilt-batched-2026-09-20.json.gz` — #311 prebuilt template with batched transfers; its browser follow-up is censored.
- `e2b-runtime-trace-2026-09-20.json.gz` — 712 lower-level runtime observations.
- `e2b-candidate-runtime-2026-09-20.json.gz` — isolated native browser and checkpoint check (`benchmarks/e2b-runtime.mjs`).

Template rollout and defaults, 2026-09-22/23:

- `startup-stock-2026-09-22.json.gz` / `startup-prebuilt-2026-09-22.json.gz` / `startup-repeat-2026-09-22.json.gz` — paired stock vs prebuilt template (#321, #322 incl. browser follow-up) and a repeat (#323).
- `startup-inherited-worker-2026-09-23.json.gz` — #325, inherited template default with the process worker.
- `checkpoint-328-2026-09-23.json.gz` — unchanged-branch publication shortcut; `cold-repeat-331-2026-09-23.json.gz` — fresh-world repeat.

Resource-heavy setup (LegiBench3 probes, 12 revisions, 708 MB in 498 files), 2026-09-23:

- `resource-bounded-2026-09-23.json.gz` — task 12, bounded transfer without compression.
- `resource-compressed-2026-09-23.json.gz` — task 13, gzip transfer.
- `resource-setup-cancel-2026-09-23.json.gz` — task 14, cancel during restore.
- `resource-checkpoint-cancel-2026-09-23.json.gz` — task 15, cancel during checkpoint.
- `resource-worker-queue-2026-09-23.json.gz` — task 16, continuously busy file workers.
- `resource-bulk-upload-2026-09-23.jsonl` — bulk multipart vs concurrent single-file upload experiment.
- `resource-deployment-2026-09-23.json` — hashes of the live validation overrides (not a release image).
- `resource-integrity-2026-09-23.json` — binary/text transfer integrity probe (`benchmarks/e2b-resource-integrity.ts`).

Remote start-up in a directory sandbox (`benchmarks/remote-bootstrap.ts`: fake Codex, no sandbox, model or credit), 2026-09-28:

- `remote-bootstrap-2026-09-28.json` — LT-1, AD-12, AD-13: one bootstrap command, history moved by its new part only.
- `remote-bootstrap-lt22-2026-09-28.json` — LT-22: browser readiness folded into that bootstrap, first-turn smoke test beside prompt preparation.
