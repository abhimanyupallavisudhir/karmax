# Recovered review: functionality costs and alternatives

Updated 2026-09-10 following cancellation. **This is a recovered proposal, not approval to land.**

The changes remain intact at karmax `18b5b29fdc2f0ec826f117a02ebfbe2032d36c6f` (PR #216) and wiki `1155e3c859ef4b7f9425053feba422c2c6a9f66d` (PR #4). Both PRs are closed and unmerged according to the task record. No recovery reset or cherry-pick was necessary. This follow-up changes documentation only.

Read this alongside the [full original findings and backlog](review-2026-09-08.md). Its S/C/U identifiers are retained below, including low-severity changes. Recommendations below are **not implemented** unless the “candidate behavior” column says otherwise. The original review was too confident about completeness and compatibility; a static audit and limited mock-agent smoke test do not establish that every feature works correctly.

## The two specific questions

### Cloud sandbox copy-back

Project write-back is necessary and remains available through Git publication and project-resource publication. S3 changes a different channel: `syncRemoteAgentHome` copies provider session files from the sandbox into the control plane's private login/config home.

The vulnerability was trusting a file listing produced by a sandbox-controlled shell. A listed session path such as `projects/../../outside.jsonl` could pass the session filename filter and escape the intended destination when joined on the host. This was not permission to edit the task's project: it was a control-plane write under the host process's privileges. Copying `karmax-oauth.json` back also let a sandbox replace credentials used by later turns sharing that login.

The candidate rejects empty, `.` and `..` path components, checks the destination prefix, and excludes the captured OAuth token. The merged upstream credential design also excludes canonical Claude/Codex auth files from copy-back: the sandbox receives a credential projection and the host retains refresh authority. Allowed session JSONL files still copy back. My previous claim that “refreshable auth still comes back” was wrong for this candidate.

Cost: arbitrary provider config changes and canonical credential updates made in the sandbox are not imported through this channel. Project files are unaffected by S3. If sandbox-side login/refresh is required, implement a dedicated, audited credential broker operation with account identity checks and stale-write protection, rather than accepting arbitrary replacement auth files. For sessions, use typed export manifests, size limits, symlink-safe host destinations and per-task staging before promotion; a lexical prefix check alone is not a complete hostile-filesystem defense. These additional protections are recommendations, not claims about current implementation.

### Agents approving or routing reviews

The appropriate boundary is explicit authority, not a blanket prohibition on agents. Developer tasks should ordinarily lack approval authority; a project-manager/maintainer task can receive it when its grant and workflow policy permit that responsibility.

S7/S8 implement API checks for `review:approve`. However, inspection of the recovered code found that the promise in my earlier report is **not fully implemented**:

* The maintainer profile declares the capability, but `PROJECT_GRANT_CEILING` and `ORGANIZATION_GRANT_CEILING` omit it, so scoped grants attenuate it away.
* The administrator profile is built from the organization ceiling and therefore also lacks it. A global god profile's wildcard covers it.
* Passing a capability directly in an API test does not demonstrate that a real task receives it after grant and role attenuation.

Repair the complete grant-to-token path, including role profiles, before relying on this feature. Test actual developer, maintainer, administrator and custom task grants, not just synthetic API tokens. Prefer distinct `review:approve` and `review:route` capabilities so the right to approve need not imply the right to remove reviewers. Record an agent approval as an agent's delegated decision with its scope and exact candidate, and explicitly enforce whether the author may approve its own task. Do not silently turn every human-only gate into an agent gate. Those policy distinctions are proposed design, not implemented here.

## Every security change

| ID | Candidate behavior and functionality cost | Secure implementation that preserves the intended capability |
|---|---|---|
| S1 | Scrubs ambient control-plane secrets from agent environments. Scripts depending on undeclared environment variables can stop working, including on self-hosted installs. | Inject task-authorized credentials and declared non-secret environment explicitly. Add actionable missing-variable diagnostics; do not restore wholesale inheritance. |
| S2 | Applies environment scrubbing to ACP agents and their terminals. Same compatibility cost as S1; this is not filesystem isolation. | Use the same explicit environment contract on every provider rail and run untrusted terminals inside the task world. |
| S3 | Session copy-back remains; traversal paths and canonical auth replacement are refused. Sandbox credential refresh cannot persist by replacing host auth files. | Separate project outputs, session import and credential refresh as described above. |
| S4 | Git profile names must match an ASCII alphanumeric first character followed by alphanumerics, dot, underscore or hyphen. This excludes some harmless display names as well as dangerous paths. | Store profiles under opaque internal IDs; allow richer display names independently. Constrain filesystem paths without making display labels path components. |
| S5 | Shared branch validation rejects dangerous arguments but also imposes a 250-character limit and forbids revision-expression syntax. It is not exactly equivalent to Git's validator. | Distinguish branch names from revision selectors; validate names with Git where possible, resolve selectors to object IDs, and use command-specific option termination/ref arguments. Keep Unicode branch support. |
| S6 | Clones retain the tenant's isolated SSH command instead of falling back to host identities. Repositories accidentally accessible only through host keys may fail. | Grant the repository an explicit scoped SSH identity and report which identity was selected. |
| S7 | Ordinary agent `task:signal` no longer authorizes Review confirmation. Higher-authority delegation is incomplete because of the missing ceilings described above. | Repair effective task grants, retain audience and exact-candidate checks, and audit delegated agent approvals. |
| S8 | In-flight reviewer/responder edits require the same approval capability; resume-source edits require source access. Legitimate routing by developer agents is blocked; delegation has S7's wiring defect. | Separate routing from approving, explicitly grant each, and apply consistent checks to draft/armed/live editing paths. |
| S9 | Queueing, spawning or cloning a stored grant requires the caller to be authorized to grant its capabilities. Shared privileged templates become less convenient. | Allow an owner to delegate execution of a fixed template, with immutable grant, bounded inputs and scope; do not make `task:create` imply arbitrary privilege delegation. |
| S10 | Workflow-edit requests validate required fields and repository eligibility. The current upstream API already refuses hosted workflow editing. | Self-hosted operators can keep trusted extensions; hosted support would require an isolated extension execution design. Repository enrollment is not permission to run code on a shared host. |
| S11 | Newly saved skills are organization-scoped. Automatic installation-wide distribution is lost; old global skills remain globally readable. | Provide an explicit global-publish permission/review path and migration UI. Existing global skills are not known to have been reviewed, contrary to the earlier report. |
| S12 | Upstream now requires JSON manifests and global installation authority, and disables hosted package installation/restoration. JS/TS computed manifests are lost, including self-hosted. This is upstream behavior retained by the merge. | Generate JSON before installation; preserve trusted self-hosted extension code under explicit installation authority. Dynamic hosted extensions need isolation, not an unchecked host import. |
| S13 | Activity feed is scoped; a caller without resolvable scope gets no events. Global dashboards lose implicit cross-organization visibility. Filtering after a bounded fetch may also hide relevant events. | Query authorized scopes before pagination and offer a distinct global-audit capability. |
| S14 | Review-action status/stop requires that the process belongs to the task named in the route. Cross-task process control through a mismatched URL is refused. | Provide an explicitly authorized operator process-management route when cross-task administration is needed. |
| S15 | HTML/SVG retain scripts in sandboxed rendering, with an opaque origin. Console-origin storage/DOM access is lost; some interactive artifacts need a backend or permissions that this sandbox does not supply. File-extension MIME inference can misclassify custom formats. | Host rich previews on a separate origin and use a narrow authenticated message bridge where needed. Add MIME handling for legitimate formats. Opaque origin does not by itself prohibit network traffic or all credentialed requests; verify CSRF and cookie behavior separately. |
| S16 | SCIM operations require membership in the IdP organization. Foreign-user revocation is prevented, but removing membership during deactivation can interfere with later reactivation. | Keep a stable organization-scoped provisioning identity/tombstone so legitimate deactivate/reactivate cycles work. |
| S17 | New webhook secrets deliver only to their organization. Old global secrets still work, preserving forwarders but also preserving their cross-tenant risk. | Migrate each forwarder, revoke the legacy secret after migration, and validate exact mailbox ownership. The candidate does not eliminate legacy risk. |
| S18 | Login is throttled after 10 failures per address or account in 15 minutes. Shared NAT users can block one another; a targeted account can be throttled. | Use bounded/shared rate-limit storage, trustworthy client-IP derivation, progressive backoff and a recovery mechanism. Thresholds should be configurable. |
| S19 | A one-shot pass no longer overrides a `never` reveal policy. Emergency plaintext access through that loophole is lost. | Let an authorized owner explicitly change reveal policy with audit; retain use-without-reveal for normal work. |
| S20 | Corrupt vaults raise errors rather than appearing empty. Writes use temp-and-rename and private modes. Operations now stop until recovery instead of continuing with a misleading empty vault. | Provide backup validation and recovery tooling; use fsync and writer coordination if stronger crash/concurrency guarantees are required. |
| S21 | Bitwarden edits send secrets through stdin. Pass-git allows HTTPS/SSH, plus file transport only under its local-repository option; other transports/helpers stop working. | Verify stdin compatibility against the supported Bitwarden CLI. Permit additional trusted transports through explicit configuration, isolated credentials and process boundaries. |
| S22 | Secret-excluding backups also omit config homes and materialized keys. Such backups cannot restore working logins/key material by themselves. | Document the two backup modes and separately export encrypted credentials when full recovery is intended. This filter is not proof that every remaining backup field is non-secret. |
| S23 | Tag colors accept only hex-looking values; named colors, rgb/hsl and CSS variables are refused. The regex also accidentally accepts invalid 5/7-digit lengths. | Parse and normalize valid CSS colors, or explicitly support only 3/4/6/8-digit hex with UI validation. Assign style properties without interpolating declarations. |
| S24 | Link schemes are allowlisted and review server open-URLs are HTTP(S)-only. Custom application protocol links can stop opening. | Add explicit trusted protocol handlers with clear user activation; validate every link surface consistently. |
| S25 | Preview token hashes are hidden; explanation requests need write authority; project listings respect memberships. Read-only users lose explanations that spend model credit. | Offer a separate budgeted explanation capability if read-only users should use it; expose non-secret lease diagnostics instead of credential-derived data. |
| S26 | New private directories/files use 0700/0600. Other OS users or services cannot read them through permissive modes. | Use intentional group ACLs or scoped exports for shared-service access. Check migration of existing file permissions separately. |
| S27 | TOTP accepts SHA1/256/512, integer periods 5–300 seconds and digit counts 4–10. Unusual authenticators outside those ranges fail. | Validate against supported provider requirements and document exceptions; do not impose unexplained bounds on legitimate imports. |
| S28 | Event activation is restricted to source tasks in the same organization. Cross-organization automation and events without a resolvable source task can stop firing. | Model explicit cross-organization subscriptions with publisher/consumer consent and payload minimization; scope non-task events independently. |
| S29 | Editing organization default/builtin instructions requires `organization:edit`; normal knowledge pages remain writable. Agents lose implicit ability to curate shared defaults. | Add a narrower instruction-publishing capability or reviewed organization-wiki changes. Broad organization administration should not be the only way to curate instructions. |
| S30 | Hosted cells refuse package `agentMcp`; self-hosted support remains. Hosted package-provided tools are unavailable, alongside upstream's hosted install prohibition. | Run declared MCP commands in a task sandbox with explicit credentials and controlled transport, or provide a platform-managed service. Neither hosted alternative is implemented here. |

## Every correctness and console change

| ID | Candidate behavior and functionality cost | Preferred implementation / remaining limit |
|---|---|---|
| C1 | Lease liveness filtering uses stable turn IDs after asynchronous probes. No intended feature removal. | Exercise concurrent grant/release/sweep behavior and replay compatibility; do not assume pure state edits have no downstream command consequences. |
| C2 | Codex failure classification ignores ordinary successful stream output. No intended loss of legitimate commands containing error-like text. | Test structured failure events for every supported stream shape so real provider failures remain recognized. |
| C3 | Cron catch-up starts at the allowed window edge. Older missed occurrences are not replayed by this path. | Make catch-up policy explicit: skip, latest, or bounded replay, with idempotent runs. |
| C4 | Event insert and inbox materialization commit together. A materialization failure now rolls back the event as well. | Preserve atomicity and provide an explicit repair/retry path for rejected events. |
| C5 | A live PID retains its worktree lock beyond ten minutes. A hung holder can now block indefinitely. | Preserve mutual exclusion while adding ownership-aware diagnostics and deliberate stale-owner recovery, not time-based lock theft. |
| C6 | Completed review processes leave the in-memory map; durable status/output remain available. Live process handles are unavailable after exit. | Verify late readers receive durable output and completion status; define retention explicitly. |
| C7 | WebSocket errors/rejected handlers are handled instead of escaping. No intended capability loss. | Preserve observable error reporting and cleanup; catching an error alone is not recovery. |
| C8 | Agent-field search reads manifest keys with a legacy fallback. No intended removal. | Define migration precedence when both old and new keys exist. |
| C9 | The agent platform proxy excludes additional webhook/meta/health paths. Agents lose those routes through this proxy. | Expose narrowly scoped diagnostics through the authenticated API where useful; do not proxy unauthenticated ingress routes indiscriminately. |
| C10 | Expired identity tokens are swept when the cache grows. No intended loss of valid sessions. | Add a true memory bound and lifecycle-based eviction; a sweep trigger is not a hard cache cap. |
| C11 | Worker failure is reported through a hook/log. It does not restart the dead worker or restore task progress. | Wire supervisor restart or controlled worker replacement and show unavailable status in the UI. This is detection, not full self-healing. |
| C12 | Removes the broken `npm run worker` command; remote-access hints reflect real authentication. Users invoking that script still need a replacement. | Supply a working dedicated worker entry point if standalone workers are supported; otherwise document the supported startup command. |
| U1 | Paste/drop in text fields no longer triggers the same pending-action behavior; key handling is narrowed. | Test ordinary typing, Enter/Space, composition, paste and uploads in a real browser. The change is not proof all keyboard paths are fixed. |
| U2 | Unknown tasks' `view.updated` events trigger list refresh. No intended removal; extra reloads are possible. | Cover create, delete, tag and permission-change events explicitly and coalesce fetches. |
| U3 | Removes an unreachable advanced/events renderer and refreshes event-derived sections through page rendering. Full rerenders may disturb focus or cost more work. | Update affected components while preserving focus, scroll and drafts; provide an accessible raw-event view if users need one. |
| U4 | Inbox/credential approval events refresh more UI state. No intended removal; late async responses can still race navigation. | Scope responses to the selected organization/project and cancel or ignore stale results. |
| U5 | Closing a task pushes browser history rather than replacing it. This changes Back/Forward behavior and may reopen the task. | Specify and browser-test list→task→close→Back/Forward and direct deep links before calling navigation universally fixed. |
| U6 | Review-action sockets close on navigation; reconnect backs off to 30 seconds. Recovery after an outage may feel slower. | Reset on successful reconnect, consider jitter/online wakeup, and show disconnected status without stopping the server process. |
| U7 | Picker epochs discard stale search results; shared tab scoping replaces duplicates. Old network requests still run. | Debounce/cancel requests as well; verify scope and keyboard selection under delayed responses. |
| U8 | Secret updates use a masked modal and action attributes are escaped. Native prompt keyboard/close behavior is replaced by custom UI. | Verify focus trapping, cancel/Escape, navigation teardown and password-manager behavior. Masking is not protection from privileged browser scripts. |
| U9 | Removes apparently unused renderer/helpers/CSS and unreachable tab markup. No intended reachable feature loss, but dynamic consumers are not disproven by text searches alone. | Keep functional resource rendering and event visibility tested; recover any genuinely used component from Git rather than adding parallel implementations. |

## Other changes and deletions

* **Root files:** removed `icon_1.png`, `icon_2.png`, `icon_3.png`, `ooga 32.md`, `ooga1.md`, `ooga2.md`, `ooga31.md`, `ooga41.md`, `ooga42.md`, `oogshabda.md`, and `BUG-e2b-transport-timeouts-escalate.md`. Cost: design experiments and a standalone incident note disappear from the current tree, even if not runtime dependencies. The incident is summarized in the backlog. Safer archival alternative: retain useful design provenance under an archive; all originals remain recoverable from the parent of `ac90420`.
* **Wiki SPEC:** restores `SPEC/SKILL.md` from the historical specification. This recovers a reference, not proof it describes current desired behavior. Reconcile outdated requirements with accepted product decisions before treating it as authority for more fixes. No Python source changes were made.
* **Tests:** changed assertions/fixtures accompany the source changes, including stage authorization, mail, connectors, skills, triggers, wiki and browser regressions. Test edits do not themselves provide user features, and synthetic capability tests missed the effective-grant defect above.
* **Merge accounting:** compare `18b5b29^2..18b5b29` to see this task's contribution relative to the target it incorporated. A diff against the original task base also includes other tasks' intervening fixes, branding assets and workflow changes; those are not all review fixes authored by this task. S12 records an upstream restriction intentionally, rather than taking credit for it.

## User-facing coverage and remaining work

The original report includes U1–U9, the runtime observations in §1c, the console backlog in §2.27–29, and user-facing lifecycle problems elsewhere in §2 (stalled workers, credential recovery, sandbox retries, queue waits). All are retained; the report is not limited to the most serious findings.

However, the prior smoke test covered first-run setup, project/task navigation, mock task live updates, one Review confirmation and settings. It did not validate real-provider/cloud/PR/merge flows, multiple users, reconnect/resume after host sleep, complex approval lifecycles or all navigation paths. “Nothing else broke” only described those exercised flows. Attributing the user's other bugs to untested lifecycle paths was speculation.

Treat the email resend/duplicate-toast observations as reproduction leads until outbound-email configuration and actual visible toast instances are verified. Large request counts are a measured symptom in that earlier run, not proof of the sole cause of perceived slowness. Filter-menu size, first-run destination and Review wording are usability/spec questions, not automatically implementation defects. Static backlog locations refer to the reviewed snapshot and may have been repaired by other tasks since.

The right next validation is a browser scenario matrix for navigation/history, concurrent edits, live event updates, offline/reconnect, uploads, vault approvals and task stage transitions, plus real-agent/cloud/landing runs in an isolated environment. This recovered report does not claim that work is complete.

## Verification status

This recovery checked the saved commit identities, cancellation/unmerged status, original report, task-vs-target file inventory, and source paths underpinning the corrections above. Prior typecheck/test results are historical evidence documented in the original report; they are not a fresh full-suite run. No production code was changed in this recovery. In particular, the approval grant defect is documented, not silently repaired or approved for landing.

## Complete recovered task file inventory

This is the saved source proposal relative to its incorporated target, before the documentation-only recovery commit. `A` means added, `M` modified, `D` deleted. It includes tests and small supporting edits as well as the numbered behavior changes. The separate wiki proposal adds `SPEC/SKILL.md`.

```text
D	BUG-e2b-transport-timeouts-escalate.md
A	docs/review-2026-09-08.md
D	icon_1.png
D	icon_2.png
D	icon_3.png
D	ooga 32.md
D	ooga1.md
D	ooga2.md
D	ooga31.md
D	ooga41.md
D	ooga42.md
D	oogshabda.md
M	package.json
M	src/activities/core.ts
M	src/agent/acp.ts
M	src/agent/codex.ts
M	src/agent/remote-process.ts
M	src/autonomy/agent-mail.ts
M	src/autonomy/config-homes.ts
M	src/autonomy/connectors.ts
M	src/autonomy/git-profiles.ts
M	src/autonomy/vault-items.ts
M	src/autonomy/vault.ts
M	src/coordinators/agent-queue.ts
M	src/domain/search.ts
M	src/gateway/review-actions.ts
M	src/gateway/server.ts
M	src/main.ts
M	src/ops/backup.ts
M	src/packages/schema.ts
M	src/platform/api.ts
M	src/platform/authorization.ts
M	src/platform/capabilities.ts
M	src/platform/platform-request.ts
M	src/platform/trigger-scheduler.ts
M	src/resolve/skills.ts
M	src/store/attachments.ts
M	src/store/db.ts
M	src/temporal/worker-pool.ts
A	src/util/git-ref.ts
M	src/world/git-broker.ts
M	src/world/merge.ts
M	src/world/worktree-lock.ts
M	src/world/worktree.ts
M	tests/agent-mail.test.ts
M	tests/connectors.test.ts
M	tests/mcp.test.ts
M	tests/skills.test.ts
M	tests/stage-transitions.test.ts
M	tests/triggers.test.ts
M	tests/wiki.test.ts
M	web/app.js
M	web/conversation.test.cjs
M	web/host-local.test.cjs
M	web/notification-delivery.test.cjs
M	web/rail-state.test.cjs
M	web/styles.css
```
