# Production startup follow-through — 2026-09-22

The earlier runtime fixes had deployed, but the organization E2B connection still
had an empty template configuration. New worlds therefore used the stock
`codex` image and continued installing Node/npm, browser packages and browser
runtime dependencies during interactive startup. Building a template had not
activated it. This was a rollout gap in the earlier investigation.

Deployment run 35694923742, job 106639588512, records the app healthy and
`Update complete at 09bc148a2108985d8120059bac8d0243ffbecae7` at 06:29:57 UTC.
That revision contains the earlier bootstrap fixes. The organization connection
read before the experiment returned `config: {}`.

## Recent real tasks

Event timestamps, measured from the initial setup view (not user receipt):

| Task | Setup → first agent message | Setup → adapter started |
| --- | ---: | ---: |
| #316 | 103.87 s | 73.22 s |
| #317 | 91.76 s | 67.26 s |
| #319 | 91.13 s | 69.31 s |
| #320 (this investigation) | 108.38 s | 72.36 s |

These four observations corroborate a substantial delay; they do not establish
that every recent task took three minutes. The interval from the `running` view
to the adapter's “Agent started working” event was 44–54 s. That view precedes
browser/tool preparation, so it does not mean model inference has started.
The live host snapshot showed load/core 0.06, 5382 MiB free, 1/25 agent slots
occupied and zero waiting. Capacity was not tight at that observation.

## Controlled production comparison

Tasks #321 and #322 use the same project/repositories, `just-do`, Codex
gpt-6-astra, low effort, Chrome DevTools MCP, empty selected wiki context, and an
identical marker-only prompt. Both run through the production gateway and
Temporal worker in real E2B worlds. They are a diagnostic pair, not a statistical
benchmark. The baseline world was provisioned before changing the selector.

After the granted `organization:edit` capability, the E2B connection was changed
from no explicit template to `uj125w982t7wflqad4ig`. This template was built and
render/screenshot-tested during the earlier investigation; it has 2 CPUs and
2048 MiB RAM. Existing worlds retain their original filesystem; the selection
applies to new headless worlds. Desktop configuration and credentials were not
changed. Provider credential validation succeeded.

| Measured phase | Stock #321 | Prebuilt #322 |
| --- | ---: | ---: |
| Request receipt → first text | 80.05 s | 47.18 s |
| Request receipt → completed reply | 81.07 s | 48.34 s |
| World preparation | 12.70 s | 14.15 s |
| Prompt preparation | 1.29 s | 0.97 s |
| Browser/tool preparation | 42.39 s | 7.94 s |
| Agent home preparation | 5.35 s | 5.81 s |
| MCP configuration | 7.44 s | 4.45 s |
| MCP readiness | 2.41 s | 6.66 s |
| Native roundtrip (includes provider/network) | 3.99 s | 3.58 s |

Intervals overlap and must not be summed indiscriminately. End-to-end first text
improved by 32.87 s (41%) in this pair. The browser/tool phase accounts for the
largest change. The remaining 47 seconds is still substantial: repository/world
preparation and repeated native/MCP setup remain visible costs. This rollout
does not introduce pooled agent processes, cached repository clones, or a
lighter conversational workflow. It also does not accelerate existing worlds
by replacing their filesystem.

The stock probe spent 8.24 s on its initial Node/npm install and 17.57 s inside
the browser package/download span. The broader 42.39 s tool span also includes
readiness/dependency checks and remote calls. Host admission was under 17 ms in
both runs. The deployment has not been restarted for this configuration change.

## Repeat, browser validation and cleanup

A second fresh prebuilt-world probe, #323, produced first text in **40.42 s**
and completed in **41.41 s**. It used the same model, effort and prompt as the
pair. Its startup overlapped the browser validation follow-up, so it is not a
strictly isolated repeat.

The parked-world follow-up on #322 emitted first text after **18.15 s** and
completed after **32.44 s**. Its recorded Chrome DevTools `navigate_page` and
`evaluate_script` calls both completed; the latter inspected `document.title`,
`main.textContent`, and `location.href` on the local diagnostic data URL. The
agent then returned `BROWSER_READY`. No external service data was accessed.
This was a production workflow check, not an isolated-process simulation.

The prebuilt selector remains active. Timing was restored to **false** after
exporting observations. All three probe tasks were intentionally cancelled for
cleanup and each emitted `world.destroyed`; their cancelled state is not a test
failure. No runtime code, credentials, or deployment processes were modified.
The only persistent operational change is the organization headless E2B template.

Content-free timing exports are committed as:

- `benchmarks/results/startup-stock-2026-09-22.json.gz`
- `benchmarks/results/startup-prebuilt-2026-09-22.json.gz` (includes browser follow-up)
- `benchmarks/results/startup-repeat-2026-09-22.json.gz`

These files record monotonic spans and request IDs, without prompts, service
contents or credentials. The full repository test suite was not rerun for this
configuration/documentation-only task; validation was the three real production
workflow runs, successful native browser tools, provider credential check and
world cleanup. The existing code revision was unchanged.

Rollback, if the template later proves incompatible: clear the E2B **Headless
template** field in organization settings. The equivalent authorized API update
is `PUT /api/organizations/org_personal/world-providers/e2b` with
`{"config":{"template":""}}`; omission would preserve the current selector.
This restores the previous default for new worlds without rotating the key or
changing existing worlds. Rebuild and revalidate the template when pinned
runtime/browser versions change.
