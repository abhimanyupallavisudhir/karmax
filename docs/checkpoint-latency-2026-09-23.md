# Avoiding repeated Git publication during waiting-world checkpoints

Every waiting-world checkpoint used to clone each origin repository, import the
task branch from its E2B world, and push it—even when its commits had not changed.
This work blocks the workflow from starting a follow-up until maintenance reaches
the next supersession check.

The broker now verifies an unchanged branch without transferring it again. The
sandbox tip must equal the previously recorded publication SHA, and an
authenticated `ls-remote` against the authoritative origin must return exactly
that SHA and branch. Credentials remain on the trusted host. Missing, changed,
deleted, or remotely advanced branches take the existing transport and lease /
fast-forward reconciliation path. Authentication failures cannot count as a
successful publication. Filesystem checkpointing still runs for dirty files.

## Production validation

The single changed broker module was installed into the running tavya.io app
container after verifying that its original hash matched the checkout's base.
The previous module was saved at `/tmp/task320-git-broker.before.ts` inside the
container. The app restarted and passed readiness. This is a live validation
override; a container replacement will restore the release version until the
pull request lands and deploys. The installed candidate's SHA256 is
`0a3914fe5a56a42c53166968796762c796641ffe50242a06ea3f5e5b9a9397ee`.

Task 328 (`task_mudkb53941d48aed4b`) used the production gateway, isolated worker,
Codex gpt-6-astra low, browser MCP, and a real prebuilt E2B world. Its first reply
was `CHECKPOINT_READY`, followed by `UNCHANGED_READY` on a second turn without
repository changes.

| Phase, three repositories | First publication | Unchanged follow-up |
| --- | ---: | ---: |
| Branch publication | 12.32 s | 2.64 s |
| Entire waiting-world maintenance | 15.81 s | 5.70 s |

The follow-up used three verification calls of 0.76–0.94 seconds and performed
no additional broker clone/import/operation spans. This removes about 9.7 seconds
of publication work in this sample. It does not eliminate first publication,
dirty-file checkpointing, or world parking. This is a within-task phase
comparison, not a claim of a 9.7-second reduction in every end-to-end response.

The first reply took 90.11 seconds; the unchanged follow-up took 17.71 seconds
to first text and 18.93 seconds to completion. These are cross-process wall-clock
estimates, not monotonic durations. Initial world preparation took 29.00 seconds
and the first Node install-or-check span took 29.70 seconds. E2B metadata
confirmed template `uj125w982t7wflqad4ig`; a sandbox inspection confirmed Node
22.16.0 and the expected link to `/opt/karmax/node-22.16.0/node_modules/node`.
Subsequent checks took approximately 0.25 seconds. The slow span alone does not
distinguish provider transport delay, sandbox cold execution, or worker delay;
it must not be presented as a proved runtime download or a model-inference cost.

A fresh-world repeat, task 331 (`task_mudkfsqq8046cc9c4f`), returned `COLD_READY`
after 41.06 seconds and completed after 41.92 seconds. World preparation took
12.24 seconds and the initial Node check took 1.21 seconds. It overlapped the
browser follow-up below; this is a repeat observation, not an isolated benchmark.
The 29.70-second runtime check did not recur. Its exact cause remains unresolved.

Task 328's third turn opened and inspected a local data page with real browser
tools and returned `BROWSER_READY`. First text took 20.19 seconds, completion
34.72 seconds. Its unchanged branch publication again took **2.64 seconds**,
confirming that the shortcut also applies after actual tool use. Both probe
worlds were explicitly destroyed after validation, and timing was restored off.
Content-free exports are `benchmarks/results/checkpoint-328-2026-09-23.json.gz`
and `benchmarks/results/cold-repeat-331-2026-09-23.json.gz`.

Repeated native-home file transfers and MCP process setup remain separate
startup costs. This patch does not change their caching, credential freshness,
or process ownership semantics. It also does not detach checkpointing from the
workflow; a follow-up still waits for a maintenance operation already in progress.

## Regression checks

The real-Git broker suite passes all nine tests, including added assertions that
unchanged publication avoids exporting a bundle, preserves dirty files, recreates
a deleted origin branch, and adopts a remote child merge despite a stale
publication record. Existing rebase and stale-lease rejection tests still pass.
Typecheck passes. The full repository suite was not run.
