# GitHub pull-request required-check boundary

Karmax validates a required check by the canonical tuple **repository, pull
request, exact PR head SHA, and workflow/check identity**. A GitHub Actions run
id and attempt are changing observations of that validation, not its identity.
The current run/attempt observation is recorded durably, so webhook delivery,
polling, reconciliation, process restart, and a Karmax-requested rerun converge
on the same validation.

Before Karmax reruns a cancelled or otherwise transient run, it lists the
workflow's runs and retains only executions of the exact PR head: the run's
`head_sha`, which for `pull_request` runs is the PR head (the synthetic
`refs/pull/<n>/merge` commit is only the job's `GITHUB_SHA`). A run's
`pull_requests[].head.sha` is never evidence: GitHub reports the PR's *current*
head there, so an earlier head's green run would otherwise satisfy a newer head
whose own run was cancelled (PR #540, 2026-10-08). An
equivalent queued, waiting, pending, or in-progress run becomes current and is
followed without starting a competing rerun. An equivalent successful run
satisfies the validation even while GitHub's aggregate PR rollup still contains
an older cancelled duplicate.

Cancellation of a non-current run is informational. A current cancellation
with no visible replacement receives a bounded number of exact-head
reconciliations before normal failure classification and bounded retry. Human
routing requires direct GitHub evidence such as `action_required`, check output
or annotations, disabled Actions, repository permissions, environment approval,
or billing/configuration diagnostics. Billing, quota, permission, or approval
phrases that merely occur in a cancelled job log—commonly output by passing
negative-path tests—do not establish a provider/account failure.

This boundary means same-head concurrency supersession alone never returns an
unchanged proposal to Do, releases its landing position, or asks a human to
repair GitHub/Karmax scheduling. Deterministic code failures still return to Do;
direct provider/configuration failures still route to the responsible human;
and genuine transient runner failures retain the existing bounded rerun budget.
