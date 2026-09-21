# tavya.io latency investigation — 2026-09-20

The largest measured delays were outside inference: remote file round trips,
first-use runtime/browser installation, native MCP initialization, and synchronous
repository publication after showing Review. This investigation includes real
production gateway tasks, real E2B worlds, scoped runtime experiments, and a
separate candidate-process integration check. These are small diagnostic samples,
not a statistically representative benchmark or a comparison with Grok.

## Production baseline

Deployment run 35491580796 / job 106027323017 completed with readiness at
`afe32b9e9315303998c75f074a3889d7b30d061b`. SSH inspection confirmed the checkout
and runtime source hashes before experimentation. The running image was
`sha256:278cbd97b928ed61fad07853a8776d0d4cedb1fa62b978230261058aa4f14a54`.

Task #306 used Codex gpt-6-astra, low effort, normal project repositories,
empty selected wiki context, and no optional browser MCP. Each prompt requested
only a short marker. All intervals below are seconds.

| Turn | Receipt → first text | Before activity | World open | Prompt preparation | Native roundtrip |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh world | 53.95 | 14.69 | 0.02 | 3.58 | 3.73 |
| Parked follow-up | 16.81 | 1.10 | 0.37 | 4.18 | 3.45 |
| Immediate Review follow-up | 51.79 | 9.84 | 9.65 | 7.24 | 4.56 |
| Parked follow-up | 16.24 | 0.67 | 0.47 | 4.41 | 2.98 |

World preparation took 13.39 s. The native roundtrip includes provider/network
and protocol time, not pure inference. Columns overlap: do not add them.
Admission was milliseconds. A host snapshot showed load 0.24, 5.2 GiB available,
2/25 agent slots used, and no waiting agents; it does not prove absence of
contention at every instant.

Task #307 repeated the cold marker request with `browser:chrome-devtools`:
first text **82.13 s**, completion 83.00 s, world preparation 12.44 s,
browser/tool preparation **35.77 s**, prompt preparation 3.59 s,
adapter → first text 22.90 s, native roundtrip 2.70 s. No browser action was
requested in this baseline.

## Findings and implemented changes

### Remote file transfers are serialized network round trips

Task #308 read 19 wiki files serially in 3.30 s. Bounded batches of eight reduced
that to 1.05 s; prompt preparation fell from 4.51 to 2.32 s and receipt → first
text from 16.50 to 13.83 s in one paired follow-up experiment. The snapshot still
reads the live checkout, including uncommitted changes.

Native home preparation also uploaded dozens of distinct skill/config files
serially. A prebuilt-world trace measured 75 writes taking 13.46 s in total;
the later batched experiment measured nine seed batches in 2.82 s. Those counts
and intervals are not identical workloads, but establish repeated network
latency as a substantial cost. Ordinary files now use bounded batches; Codex
rollout publication stays serialized because files share session identity.
Failures settle all active writes before cleanup, and later batches do not start.
Wiki reads are written to the temporary snapshot as they finish, so the entire
wiki does not accumulate in memory.

### Cold installation should be paid at template build time

A real E2B template was built successfully: alias
`tavya-latency-prebuilt-20260920`, template `1psdfvst93rkzfn632jl`, build
`43df8302-cd87-4de8-898a-8e2ed7ac9e3a`, 69.68 s build time, 2 CPUs / 2048 MiB.
It contains the pinned Node/npm pair, native agents, browser and MCP packages.
It is **not selected as the production default**.

The candidate links a verified, exact Node/npm pair from the template into the
task runtime; absent/mismatched templates retain the existing install path.
Copying that runtime had cost 9.97 s in an abandoned experiment. Links avoid the
copy. An actual failed probe also exposed the baked-browser readiness command
using `/opt/karmax/browser` as its working directory, which E2B's task path guard
rejects. The command now uses its existing NODE_PATH with the task directory.
The guard itself is unchanged.

A reproducible builder is in `environments/browser/e2b-prebuilt.ts`, including a
render/screenshot smoke test. The exact checked-in builder subsequently passed
on the production VPS: alias `tavya-latency-verified-20260920`, template
`uj125w982t7wflqad4ig`, build `e4bc3d17-ac69-479e-b041-2eec8fa71c02`,
68.6 s SDK elapsed. The native browser check below used the earlier experimental
artifact with equivalent installation commands. Neither template was selected
as the production default. Select a baked template only after the runtime support
has deployed; compare its resource cost with the current plan first.

Task #311 used the correct low-effort profile with the template, batched wiki and
home operations, and corrected browser probe. Tool preparation was **6.83 s**,
prompt preparation 0.91 s, adapter → first text 9.16 s, and native roundtrip
3.87 s. First text arrived 42.85 s after **world.prepare began**. This is not a
receipt-to-first-text measurement: queueing a draft lacked a receipt event.
The candidate adds that event and dispatch spans without changing default-off
recording. Do not present 82.13 → 42.85 as an exact end-to-end speedup.

Tasks #309 and #310 accidentally inherited high effort through an incorrect
probe parameter path; their model timings are excluded from low-effort
comparisons. #309 failed during browser setup; #310 is useful only for setup
traces. #311's initial marker turn succeeded.

### Review publication keeps the workflow busy after Review is visible

After baseline Review, checkpoint/parking finished 11.7–15.5 s later. An immediate
follow-up waited for the current activity to finish. In #308, three disposable
host Git clones took 3.72 + 0.77 + 1.05 = 5.54 s of an 11.81 s publication.
In #311, publication took 14.44 s, including 5.29 s cloning and 4.85 s pushing.
This occurs even for marker-only turns. The entire 51.79 s immediate follow-up
latency cannot be attributed to parking; it also included slow world open and
adapter setup.

The candidate checks for durably accepted follow-ups at settled boundaries of
Review publication and defers remaining idle parking when one exists. In-flight
Git/checkpoint work is allowed to finish. Tests cover arrivals during status and
checkpoint operations. This avoids unnecessary park/resume work, but does not
eliminate a clone already underway, nor the final narrow check-to-park race.

A larger design change is still needed to remove repeated full broker clones or
separate durable idle maintenance from interactive dispatch. That must retain
publication integrity, task permissions and checkpoint portability; this change
does not introduce an unreviewed persistent shared Git cache or asynchronous
checkpointing.

### Remaining native and world startup costs are now visible

New spans cover wiki snapshot, bootstrap runtime/config/home/session/browser,
account health, authoritative MCP readiness, E2B connect/pause, Git broker clone
and imports, and lifecycle publication/checkpoint/parking. They inherit the
installation timing toggle and contain operation metadata, not credentials or
conversation text.

In the isolated real-browser candidate check, MCP readiness alone took 5.20 s,
MCP config preparation 3.29 s, account health 0.86 s and app-server startup
0.94 s. Production world preparation remained about 12–14 s with project
repositories; E2B creation itself was 0.61 s in #311, so creation alone does not
explain that interval. Per-turn native process/config/MCP startup and repository
materialization remain targets for subsequent controlled experiments. No
persistent native-process/session pool is introduced here.

## Real candidate runtime validation

A **separate process on the production VPS**, loading the candidate source,
created a real E2B world using the tested template. It used an isolated in-memory
store and temporary home, a fresh access-token projection of the existing native
Codex account without its real refresh token, gpt-5.5 low effort, 64 synthetic
skill files, and actual Chrome DevTools MCP. It did not attach to the application
process or modify its source/store. This validates runtime integration, not
production gateway/Temporal dispatch of the complete candidate.

The native agent opened a local data URL and returned `BROWSER_READY`; an
independent DevTools page-list check verified its title. A real portable
checkpoint was made while injecting a follow-up at the settled boundary.
All seven checks passed: browser reply, browser title, checkpoint saved, world
retained ready, parking deferred, subsequent idle wait parked, and file bytes
survived resume. Provider listing confirmed **zero remaining probe sandboxes**.
World preparation was 3.06 s without project repositories, tool preparation
5.86 s, home preparation 5.85 s, native agent attempt 33.05 s including the actual
browser action. This fixture's subsecond Review durations are not representative
of repository-backed publication.

`benchmarks/e2b-runtime.mjs` makes this isolated runtime check repeatable with
explicit E2B key/template/auth-home inputs. It uses a billable sandbox, rejects
stale login projections, disables platform mutations, records content-free
spans, and destroys the sandbox and temporary home. Use `npx tsx` as documented
in its header. It requires a native ChatGPT login; an initial API-key-only
experiment failed the native account path and was cleaned up. This does not
establish API-key native-login support or test the Anthropic path. A later run
of the reusable script stopped at its preflight check because the native login
projection had expired; it created no sandbox. The successful runtime evidence
comes from the preceding isolated driver from which this script was extracted.

Relevant automated validation: 119 tests across 12 files covering remote
bootstrap, runtime pairing/fallback, wiki reads, follow-up parking, draft timing,
Codex protocol, MCP selection, E2B and checkpoints; TypeScript checking passed.
The full repository suite and a production deployment of this patch have not
been performed.

## Experiment incident and cleanup

An attempted deeper live-process inspector query for Store instances stalled the
production app. The exact cause is unproven; interaction with synchronous
PostgreSQL access during debugger evaluation is suspected. This was an
**investigation-induced outage**, not ordinary task-latency evidence. Attempts
to terminate the evaluation did not recover it. The app container was restarted
and came back at `2026-09-20T20:25:55.585040078Z`; authenticated APIs recovered.
All temporary in-memory wrappers disappeared with the restart. No application
source files were replaced. Do not repeat this inspector technique; use isolated
processes and ordinary diagnostic spans.

#311's later browser follow-up was interrupted by that incident and is censored,
not counted as a successful browser turn. The successful browser evidence is
the isolated check above. Probe tasks #306–311 were cancelled/ended and their
worlds destroyed; failed-world leftovers were explicitly removed after checking
probe metadata. Temporary API-key transfer files were removed. Timing recording
was restored to **false**. Production still runs the original release; the fixes
and template selection have not been rolled out. Actual billed cost is unknown.

## Evidence files

Content-free JSON (gzip) lives in `benchmarks/results/`:

- `e2b-investigation-2026-09-20.json.gz`: #306 baseline turns.
- `e2b-browser-investigation-2026-09-20.json.gz`: #307 browser baseline.
- `e2b-followup-optimized-2026-09-20.json.gz`: #308 follow-up experiments.
- `e2b-prebuilt-failed-2026-09-20.json.gz`: #309 failed setup.
- `e2b-prebuilt-serial-2026-09-20.json.gz`: #310 prebuilt serial setup.
- `e2b-prebuilt-batched-2026-09-20.json.gz`: #311, including censored follow-up.
- `e2b-runtime-trace-2026-09-20.json.gz`: 712 scoped lower-level observations.
- `e2b-candidate-runtime-2026-09-20.json.gz`: isolated native browser/checkpoint check.

Use only same-clock monotonic intervals for precise differences. Wall-clock
cross-process estimates, changed models/effort, missing receipt markers,
repository-free fixtures and interrupted turns must remain separately labelled.
