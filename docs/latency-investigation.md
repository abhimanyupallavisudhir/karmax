# tavya.io latency investigation — 2026-09-20 (in progress)

Direct production gateway / real E2B probe #306 (`task_mua3upg27b403bf12a`), just-do workflow, Codex gpt-6-astra, low effort, no optional MCP connections, empty selected wiki context. Normal project repositories/resources and native account path. The model was asked only for short markers, with no tools or external data actions. This is a four-turn diagnostic pilot, not a statistically representative benchmark or a model comparison.

The successful deployment log for run 35491580796, job 106027323017, records readiness and `Update complete at afe32b9e9315303998c75f074a3889d7b30d061b`. Server process/diagnostics APIs were also inspected. Direct Docker logs and runtime file hashes still require the pending VPS credential grant; deployment logs alone do not exclude later manual changes.

| Turn | Receipt to first text | Before activity | World open | Prompt preparation | Native model/protocol roundtrip |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh world | 53.95 s | 14.69 s | 0.02 s | 3.58 s | 3.73 s |
| Follow-up after parking | 16.81 s | 1.10 s | 0.37 s | 4.18 s | 3.45 s |
| Follow-up immediately after Review | 51.79 s | 9.84 s | 9.65 s | 7.24 s | 4.56 s |
| Follow-up after parking | 16.24 s | 0.67 s | 0.47 s | 4.41 s | 2.98 s |

Times derive from same-process monotonic observations. The roundtrip includes provider/network/protocol time, not pure inference; some columns overlap and must not be summed. Initial `world.prepare` took 13.39 s. The previous startup checkpoint detour did not occur. Account/host admission was milliseconds, not the principal bottleneck in these samples. Host snapshot: four cores, load 0.24/0.33/0.27, about 5.2 GiB available, 2/25 agent slots in use, zero waiting. This is a snapshot, not continuous resource monitoring.

After every Review publication the production event log recorded checkpoint/parking completion 11.7–15.5 s later. The immediate follow-up arrived during that interval and could not begin its next activity until publication finished. That explains its measured pre-activity delay. It does **not** yet explain the subsequent 9.65 s world-open or 19.03 s adapter-to-first-output interval. Those need separate traces; do not attribute the entire 51.79 s to parking.

During checkpoint work the authenticated server process endpoint showed `git clone -q --no-checkout ... /tmp/karmax-git-broker-.../repo`. Source inspection confirms the broker creates a disposable full clone for each publication, even on a marker-only turn. No controlled improvement has yet been measured. Source inspection also shows prompt preparation copies the remote wiki one file at a time and native-agent preparation includes runtime installation/config/session operations before the measured app-server spawn.

Local instrumentation under development splits wiki snapshot, runtime, home/config/session/MCP preparation, and lifecycle status/open/enrollment/publication/checkpoint/parking. These changes are not deployed yet. Further experiments must isolate those phases before claiming a fix or speedup. Preserve authentication projection, session integrity, durable checkpoints and race safety when optimizing.

Production timing was enabled only for the collection and restored to false. Probe #306 was cancelled and emitted `world.destroyed` at 1789926451339. Raw content-free observations are in `benchmarks/results/e2b-investigation-2026-09-20.json.gz`. No messages or external service data were sent/fetched; normal application Git checkpoints occurred. Actual billed cost is unavailable.

## Default browser tools pilot

A second real production E2B task, #307 (`task_mua42v939ac35c473f`), used the same low-effort Codex marker request with the normal `browser:chrome-devtools` selection. It produced first text at **82.13 s**, completed at 83.00 s, and spent 13.79 s before activity execution. World preparation was 12.44 s, prompt preparation 3.59 s, and browser/tool connection preparation **35.77 s**. The subsequent adapter-to-first-output interval was 22.90 s; its internal breakdown is still incomplete. The native roundtrip itself was 2.70 s. No browser action was requested. This is one successful cold pilot, not evidence that all browser starts take this long. Timing was restored to false and the task cancelled after exporting observations. Data: `benchmarks/results/e2b-browser-investigation-2026-09-20.json.gz`.

The instrumentation candidate passes TypeScript checking (1536 MiB heap; the default heap was insufficient in this 2 GiB world). No behavioral optimization or deployment has been performed yet, and there is no after-change production measurement.
