# GitHub Actions evidence for agents

Karmax uses the calling task's existing GitHub connection. Every read requires
`github:actions:read`, an attached repository in that task's project, and a
GitHub installation with the corresponding upstream permission. No new vault
credential or separate connector is needed. `github:actions:write` does not grant
read access, and reads do not require write access.

## Tools and API

`list_github_actions_workflows` discovers workflow IDs, paths and enabled states.
`list_github_actions_runs` filters runs by workflow, branch, event and status.
Specify `repository` as an attached repository ID, unique name, or `owner/name`;
it can be omitted only when the project has one eligible repository.

`inspect_github_actions_run` takes `run_id` and these views:

| View | Purpose | Selection |
| --- | --- | --- |
| `failure` (default) | Compatible failure diagnostics, failed job logs, jobs and artifact metadata | Run; use another view for targeted selection |
| `jobs` | Job IDs, run/attempt identity, runner, step numbers/names/status/timestamps | `attempt`, `page`, `per_page` |
| `log` | A job's bounded log tail, for any conclusion, including success/cancelled | `job_id`, `attempt`, `tail_lines`, `offset_lines`, `max_chars` |
| `artifacts` | IDs, names, sizes, expiry, digest and originating run metadata when supplied by GitHub | `page`, `per_page`; artifacts belong to the run, not a selected attempt |
| `annotations` | A selected job's check status, summary and annotations | `job_id`, `attempt`, `page`, `per_page` |
| `pending-deployments` | Current environments waiting on protection rules, wait timers and reviewer metadata | Current run state, not historical attempt state |

The gateway equivalents are:

```text
GET /api/agent/github/actions/workflows?repository=OWNER/REPO&page=1&perPage=30
GET /api/agent/github/actions/runs?repository=OWNER/REPO&workflow=deploy.yml
GET /api/agent/github/actions/runs/RUN_ID?repository=OWNER/REPO&view=jobs&attempt=1
GET /api/agent/github/actions/runs/RUN_ID?repository=OWNER/REPO&view=log&attempt=1&jobId=JOB_ID&tailLines=100&maxChars=16000
```

The HTTP API and platform MCP use camelCase (`runId`, `jobId`, `perPage`,
`tailLines`, `offsetLines`, `maxChars`); provider-native agent tools use snake_case.
This lets already-running agents use `platform_request` even before their tool
schemas refresh after a release.

Pin `attempt` when collecting historical evidence. If omitted, the run's current
attempt is read once, then used for job selection. A selected job must match both
run and attempt before any log or check request. Reusable workflow references are
reported separately from run `headSha`; neither implies deployed code.

Jobs, artifacts, workflows and annotations return `total`, `page`, `perPage`,
`hasMore` and `nextPage`. Pages default to 30 entries, at most 100; page numbers
are 1–1000; `pageLimitReached` identifies a result extending beyond that limit. Legacy failure inspection retains its 1,000-job / 100-artifact limits
but reports notices when capped. Its failure classification contract is unchanged.

## Bounded logs and diagnostics

A targeted log request scans at most 64 MiB, retaining the final 1 MiB in host
memory. It returns at most 500 lines and 32,000 characters (defaults: 100 lines,
16,000 characters). No full log is persisted in an audit event or returned to an
agent. Read audit events contain only repository and selection metadata.

- `tailComplete` means the scan reached EOF; it is **false** when the scan cap was
  reached. Never use an incomplete tail to claim that no rollback occurred.
- `downloadTruncated` identifies the scan cap; `omittedPrefix` identifies data
  discarded before the retained window. `truncated` covers any omitted output.
- `nextOffsetLines` pages backward from the tail using `offset_lines`.
  `retainedLines` describes the available window. `null` means the window is
  exhausted, not necessarily that the entire log was retrieved.
- `outputTruncated` means the character cap clipped the selected lines. Reduce
  `tail_lines` or raise `max_chars` to recover more of that window. A single line
  longer than 32,000 characters remains clipped.

Each request downloads again; offsets are stable for immutable completed job
logs, but can move for live logs. GitHub may not expose a log until the job ends.
Skipped jobs and expired logs may have no download; provider errors (for example
403, 404, 410 or 429) are reported, never converted into empty successful evidence.
Step metadata provides boundaries for interpreting job output. GitHub's REST job
log API does not provide an exact per-step log endpoint; Karmax does not invent
step boundaries by matching repository-controlled names or timestamps.

Annotations share a 24,000-character text budget with a 2,000-character per-field
limit. `textTruncated`, `textLimit` and `fieldTextLimit` disclose clipping. Use a
smaller page to reduce aggregate clipping. Check permissions may be unavailable
on an older installation; that error does not require Karmax write authority.

Authenticated API requests never follow redirects. Log downloads follow at most
four storage requests, without Authorization, only over HTTPS on port 443 to
GitHub's `*.blob.core.windows.net` or `*.githubusercontent.com` storage domains.
Unknown storage hosts fail closed; a future GitHub storage migration requires an
allowlist update. Signed locations and raw provider error bodies are never
returned. Known installation tokens, recognizable GitHub tokens, Authorization
values and URL query strings in log output are redacted as defense in depth;
GitHub's own secret masking remains necessary for arbitrary workflow secrets.

## Deployment verification

Historical acceptance request (use a current accessible run if it has expired):

```json
{
  "repository": "abhimanyupallavisudhir/karmax",
  "run_id": 34641025269,
  "view": "log",
  "job_id": 103400397039,
  "attempt": 1,
  "tail_lines": 200,
  "max_chars": 24000
}
```

For Karmax's Deploy workflow, read `.github/workflows/deploy.yml` at the relevant
revision: `DEPLOY_SHA` comes from `github.event.workflow_run.head_sha` or the
manual dispatch input. The Actions run's `head_sha` is GitHub run metadata and may
refer to a different revision. The REST run object does not contain the complete
trigger event or manual dispatch inputs. Do not infer those inputs by selecting
an adjacent CI run, or relabel a reusable workflow SHA as the trigger SHA.

Correlate the explicit updater target with readiness output and the subsequent
`Update complete at <sha>` line. Review later output for rollback/failure. A
superseded or skipped update can exit successfully without deploying its target;
therefore run success alone is insufficient. Completion is historical evidence,
not a guarantee that production has not changed since then. Check later deploys
and use the runtime's authoritative readiness/revision evidence where available.

## Audit scope and exclusions

The existing list, inspect, rerun-failed, rerun, cancel and dispatch surface was
reviewed against CI diagnosis and production release verification. This change
adds the missing targeted reads and workflow discovery while preserving mutation
capabilities and GitHub environment protections.

Artifact archive download is intentionally deferred: returning a signed URL
would violate credential isolation, while safe archive delivery needs a bounded
binary-to-world transfer contract with expiry, archive/path handling and storage
ownership rules. Metadata is sufficient to identify reports without putting ZIP
content in model prompts. No generic GitHub request proxy is exposed.

No approval, protection bypass, forced cancellation, job rerun or workflow
activation mutation is added. Existing rerun/failed-rerun, cancel and dispatch
cover the repair workflow and require `github:actions:write`. Pending approval
inspection does not approve anything, even when `currentUserCanApprove` is true.
Historical deployment approvals/statuses and direct live production attestation
are separate from Actions job evidence and are not synthesized here.

After normal review, merge, CI and Deploy of this change, verify the deployed API
with a read-only task grant and record the release SHA, run/job/attempt and bounded
readiness/completion evidence. Only then notify S3 continuation
`task_mtwtcrwtc718ee8166` (#219) with the API example and actual deployment evidence.
This implementation task does not complete the S3 work or execute its integration
phases.

GitHub references: [workflow runs and attempts](https://docs.github.com/en/rest/actions/workflow-runs),
[jobs and logs](https://docs.github.com/en/rest/actions/workflow-jobs),
[checks and annotations](https://docs.github.com/en/rest/checks/runs),
[artifacts](https://docs.github.com/en/rest/actions/artifacts).
