# GitHub deployment recovery boundary

Karmax treats deployment as a separate post-merge concern. It never reopens or
changes the task whose pull request already merged. Operational failures create a
new recovery task in every project attached to the affected repository.

The boundary covers both ways a post-merge deployment can disappear:

1. **A run exists and fails.** Default-branch `workflow_run` failures (with
   `check_run` as a compatibility signal) immediately enter the GitHub recovery
   task path. The run id, revision, conclusion, URL, attempt, and originating task
   correlation are retained as evidence.
2. **No run is ever created.** A successful default-branch `CI` run creates a
   durable expectation for the same revision's repository-owned `Deploy`
   workflow from `.github/workflows/deploy.yml`. Repositories are auto-discovered
   when that file or a Deploy run is first observed, so an unrelated repository
   that merely calls its validation workflow `CI` is not assumed to deploy; once
   discovered, deleting the workflow file is itself an incident. After a
   five-minute grace period, Karmax polls
   GitHub directly. Any matching run—including queued, waiting, or protected-
   environment approval states—satisfies the expectation even if its webhook was
   delayed or lost. If the file exists but no run is exposed, or if permissions
   prevent the file/API checks, Karmax sends a missing-run incident through the
   same recovery task path.

The missing-run evidence records the successful prerequisite run, exact SHA,
grace/deadline timestamps, workflow-file presence or read failure, and both the
workflow-specific and repository-wide Actions API results. This lets recovery
distinguish an invalid/unregistered workflow from delayed webhook delivery,
GitHub/App permissions, environment approval, and other trigger/configuration
problems before changing code.

Expectations live in the durable store and are reconciled once at process start
and every minute thereafter. The first observation fixes the deadline, so
duplicate webhooks cannot extend it. Seeing a deployment run clears the
expectation. Recovery creation uses a stable repository/revision/workflow incident
key; duplicate webhooks, repeated polls, and a restart between task creation and
acknowledgement therefore converge on one recovery task per attached project.

CI separately runs a checksum-pinned `actionlint` against every file in
`.github/workflows`. Its negative regression check injects the unsupported
`concurrency.queue` key and proves the schema gate rejects it. This prevents the
known invalid-workflow case before merge while the runtime monitor remains the
backstop for provider-side rejection and configuration drift.

For successful deployment verification and targeted job logs, see [GitHub Actions agent inspection](github-actions-inspection.md).
