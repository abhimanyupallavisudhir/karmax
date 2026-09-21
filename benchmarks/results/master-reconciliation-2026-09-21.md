# Master reconciliation and additional release validation

Merged master c1633c88c4768842717b439ffaaafdd5ed58ec48 into the task branch
in merge commit 7432d7f1381a078e9343a1366fde1f72f6c0f459. Master's remote
bootstrap batching, matching prebuilt Node/npm reuse, browser probe fix and timing
instrumentation are retained. New synchronous Store/timing calls were adapted to
this branch's asynchronous interfaces, including the E2B diagnostic script.

Accepted follow-ups now suppress idle parking in both inline and separate
lifecycle activity paths. The opaque publication fence carries the event cursor,
so retries use the same boundary; historical fences preserve their original
behavior. Existing ownership, generation, access, lease and workflow fences are
retained. Tests cover follow-up arrival during status and checkpoint work in both
paths and verify that later waits can still park.

## Validation

- Focused bootstrap, draft timing, lifecycle and replay checks: 76 passed. One
  initial Temporal connection timeout passed on isolated rerun.
- Provider contract, provisioning, hibernation, backup, deployment recovery and
  timing checks: 97 passed.
- Cross-process event relay: 4 passed.
- PostgreSQL migration and full split-process startup/restart/worker-failure
  checks against the local PostgreSQL test database: 17 passed.
- UI/browser suite: 98 passed, zero skipped.
- TypeScript compilation passed after reconciliation and live fixture updates.
- Responses API completion and native session-lineage regressions: 16 passed.
- Real-agent Temporal/Git workflow: passed, including Review, Merge, execution
  of committed code and absence of failed agent turns.
- Real Claude Messages and Codex Responses API turns: both returned expected
  output. The Codex live check now fails on quota errors instead of counting
  them as successful model execution.

The live end-to-end fixture required two updates: create real project/task records
for usage attribution, and execute committed target-branch bytes rather than an
unchanged canonical checkout. Neither required weakening application checks. Its prompt now explicitly requests
the named CommonJS export that its assertion requires.

Live testing also exposed an actual Responses API adapter defect: returning after
`signal_completion` left tool outputs unsubmitted, making the next resumed turn
fail with a missing-tool-output error. The adapter now acknowledges all outputs
with tools disabled before returning the resumable session. This acknowledgement
is allowed at the iteration cap; unexpected additional tool calls fail explicitly.
A deterministic regression verifies acknowledgement and the next resume.

## Outstanding external validation

Production backup restore has not been rehearsed. It requires a production backup
location and an isolated destination with the matching PostgreSQL/Temporal data,
object files and encryption material. Do not boot a second app against the live
home or let a restored clone execute production workflows/external side effects.

E2B/Daytona disposable-sandbox checks require provider credentials made available
to this task. Connected organization providers alone do not expose credentials
to the local test runner. Subscription-login permutations remain unverified.

CI for 7432d7f passed both image builds, Caddy/Compose validation, operator shell
parsing and typechecking; the full test job was still running when this report
was prepared. The subsequent adapter fix and test updates require their own exact-candidate CI result.
Nothing in this report establishes production deployment or a zero-regression
guarantee.
