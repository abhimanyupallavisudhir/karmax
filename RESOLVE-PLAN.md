# RESOLVE-PLAN — Resolve logic, quota management, and recovery UX

> Source-of-truth plan for perfecting karmax's cross-cutting **Resolve** subsystem: quota/session-limit
> auto-resolution, a capable Resolve agent, human escalation, and the task-UI changes that make all of
> it inspectable. Aligns with SPEC §5.2, §5.4, §6.2, §7, §0 (self-healing) and §10.
>
> Decisions locked with the user (2026-07-03):
> - **Login switch on limit:** switch immediately to any available compatible login and *resume the same
>   conversation* (not a fresh context); park only when no compatible login is free.
> - **Recovery mechanism:** a **bounded typed transition vocabulary** (no free-form JSON actions).
> - **Delivery:** full sequenced plan, phases 1→4, implemented in order.

---

## 0. The reframe (what we are and aren't building)

Three things that looked like new subsystems are existing mechanisms extended:

1. **The "quota-tracking workflow" already exists** — it's the `accountCoordinator` singleton
   (`src/coordinators/account.ts`, SPEC §6.2). It has placeholder metering today; we make it real.
   "Waiting for quota refresh" = *a task parked in the coordinator queue*, surfaced in the view-model.
   The coordinator already grants by directly signalling the parked task — that **is** "emit an event
   when a login is available, wake the task." No new pub/sub bus.

2. **Recovery is one bounded vocabulary, three surfaces.** auto-resolve (script), the Resolve agent
   (structured tool call), and the human (UI buttons) all express the *same* small set of transitions:
   `resume`, `retryStage`, `gotoStage(+paramPatch)`, `parkUntil(event → thenAction)`, `escalate`.
   One workflow-side executor runs them. This is "declare, don't guess" (SPEC §0) applied to recovery.

3. **karmax owns the conversation.** The full `msgs` history lives in the workflow. Provider session
   ids/`previous_response_id`s are *optimizations*, not the system of record. So a login switch is never
   lossy in content — worst case we replay `msgs` under the new login.

### Corrected feasibility facts (verified against Claude Code / Anthropic docs, 2026-07)

- **Subscription (Max/Pro) limit errors are human-readable only:** `"You've hit your session limit ·
  resets 3:45pm"`, `"…weekly limit · resets Mon 12:00am"`, `"…Opus limit · resets 3:45pm"`. We can parse
  *which* window and the reset *clock-time*, but there is **no machine timestamp and no quota API**.
  → reset time = best-effort parse (in a configured timezone) + conservative fallback + manual override.
- **API-key path** returns clean headers: `retry-after` (seconds), `anthropic-ratelimit-*-reset` (RFC-3339).
- **Session transcripts are local files** and resume replays them under the current login. Portable across
  logins by copying the file (Claude) or re-sending `msgs` (either provider). Account binding only affects
  server-side quota/permission evaluation + prompt cache, not transcript readability.
- **No cheap availability probe** for subscription quota — "re-check" must be a tiny real turn or manual.
- **CLI resume** (for the copy-command UI): `cd <world> && CLAUDE_CONFIG_DIR=<home> claude --resume <id>`
  (must run from the world dir the session was created in). Codex gets a best-effort variant.

---

## 1. The bounded transition vocabulary (shared executor)

A single typed union, defined once and consumed by the workflow's outer stage dispatcher (§4). Used by
auto-resolve return values, the Resolve agent's `resolve_decision` tool, and the human escalation UI.

```ts
// src/resolve/transitions.ts (new) — pure types, importable by workflow sandbox + gateway + UI
export type WaitEvent =
  | { kind: 'account'; provider: 'claude' | 'codex'; earliestResetAt?: number }
  | { kind: 'mergeSlot'; domain: string }
  | { kind: 'human' }                       // waits for a follow-up / retry signal
  | { kind: 'subtask'; taskId: string };

export type ThenAction =
  | { do: 'resume' }                        // continue the interrupted role's session
  | { do: 'retryStage' }
  | { do: 'gotoStage'; stage: Stage; params?: Record<string, unknown> };

export type Transition =
  | { do: 'resume' }                        // re-run failed stage, resuming the agent ("Continue, you got cut off")
  | { do: 'retryStage' }                    // re-run failed stage fresh
  | { do: 'gotoStage'; stage: Stage; params?: Record<string, unknown> }
  | { do: 'parkUntil'; event: WaitEvent; then: ThenAction }
  | { do: 'escalate'; reason: string };
```

**Safety rules enforced by the executor (all deterministic, workflow-side):**
- No transition may cross `pointOfNoReturnPassed`.
- `gotoStage` targets must be reachable earlier stages (never skip forward past gates); `params` is
  validated by the *same* `validateParamPatch` used by `updateParams`, after re-deriving the destination
  stage's `consumed`/`targetLocked` (§4.3 rewind rule).
- `parkUntil.then` is itself a bounded `ThenAction` — the reason humans can rewind/edit/resume but do
  **not** hand-author `parkUntil` (the `then` space is too open for a form; only script/agent set it).

---

## 2. Part A — Quota / session-limit engine

### 2.1 Coordinator upgrade (`src/coordinators/account.ts`, `names.ts`)

`AccountState` gains:
```ts
provider: 'claude' | 'codex';
status: 'available' | 'exhausted' | 'manual-off';
window?: '5h' | 'weekly' | 'model';   // which limit caused exhaustion
resetAt?: number;                      // ABSOLUTE epoch ms (not a duration marker)
weeklyResetAt?: number;                // tracked separately from the 5h window
note?: string;                         // e.g. "Opus limit"
```
New signals (add to `names.ts`):
- `SIG_REPORT_EXHAUSTED { accountId, window, resetAt, note? }` — ground-truth feed from auto-resolve.
  Marks the account `exhausted`, arms a **per-account durable timer** (`sleep(until resetAt)` in a child
  scope) that flips it back to `available` and re-runs the grant loop.
- `SIG_SET_ACCOUNT_AVAILABILITY { accountId, status, resetAt? }` — manual override (UI/MCP).
- `SIG_RECHECK_ACCOUNT { accountId }` — triggers a probe activity (tiny real turn) that reports back.
- Lease request gains `provider`: `SIG_LEASE_ACCOUNT { taskId, turnId, provider }`.

`headroom(a)` becomes: `a.provider === req.provider && a.status === 'available' && a.inUse < a.maxConcurrent`.
Replace the blanket `sleep(FIVE_HOURS)` reset with per-account timers keyed on real `resetAt`.
Extend `AccountsView` with `provider/status/window/resetAt/weeklyResetAt/note` for the dashboard.

### 2.2 Limit detection at the adapter (`src/agent/claude.ts`, `codex.ts`, new `src/agent/limits.ts`)

`classifyLimitError(providerError, provider): { limited: boolean; window?; resetHint?: string }`:
- Claude Agent SDK: detect `rate_limit_event` stream message and the `"You've hit your … limit · resets …"`
  text; extract window (`session`→`5h`, `weekly`, `Opus…`→`model`) and the clock-time hint.
- Claude Messages API / Codex Responses API: on HTTP 429, read `retry-after` + `anthropic-ratelimit-*-reset`
  (Claude) or Retry-After (OpenAI). These are machine-readable.
- `runAgentTurn` catches a classified limit error and rethrows a typed `LimitError { accountId, window,
  resetHint }` so the workflow/auto-resolve can branch precisely (instead of today's opaque string).

### 2.3 Reset-time resolution (activity — timezone math is side-effecting, not workflow-safe)

`resolveResetAt(resetHint, window, tz): number` in an activity:
- Parse `"3:45pm"` / `"Mon 12:00am"` → next future instant in `tz` (new setting `quotaTimezone`,
  default host TZ). Machine headers (RFC-3339 / retry-after) used directly when present.
- Low-confidence parse → conservative fallback: `now + 5h` (session) / next-week boundary (weekly).

### 2.4 The session-limit auto-resolve case (`src/resolve/cases.ts` — upgraded action model)

Widen `ResolveOutcome.action` beyond `'retry'` to a `Transition` (or a small handler-key set). New case
`session-limit` (distinct from the coarse `rate-limit` retry): on a `LimitError`, the auto-resolve
**activity**:
1. `resolveResetAt(...)` → absolute epoch.
2. `coordinator.reportExhausted(accountId, window, resetAt)`.
3. Re-lease for the same turn with the required provider.
   - **Granted a compatible login** → return `{ do: 'resume' }` (workflow resumes the interrupted role
     under the new config home + "Continue, you got cut off"; Claude carries `.jsonl`, Codex replays `msgs`).
   - **None available** → return `{ do: 'parkUntil', event: { kind:'account', provider, earliestResetAt },
     then: { do:'resume' } }`.

### 2.5 The latent bug (fix regardless)

`leasedTurn` (`software-dev.ts:323-336`) rotates the config home per turn while threading a single
`session`. Bind the stored session to the config home that minted it (`session:<taskId>:<role>@<home>`);
when the leased home differs from the session's home, **drop the provider session and replay `msgs`**
(Claude: optionally copy the `.jsonl` into the new home first). Never resume a session under a foreign home.

### 2.6 Dashboard + manual control (`web/app.js` `renderDashboard`, gateway, MCP)

- Extend the accounts widget: per-account provider, status, 5h + weekly windows, **reset countdown**.
- New gateway routes → coordinator signals: `POST /api/accounts/:id/availability`,
  `POST /api/accounts/:id/recheck`. Add matching MCP tools.
- "Re-check" = a probe turn (labelled as spending a sliver; no free quota API exists).

---

## 3. Part B — Resolve agent

### 3.1 Prompt (`src/contrib/manifests.ts` `RESOLVE_ROLE`, or extract to `prompts/resolve.md`)

Rewrite to state explicitly (SPEC §5.4):
- (a) *"You are not here to finish the task — only to diagnose this error and get the task back on track."*
- (b) *"Auto-resolve should have caught this and didn't. If this error is mechanically recognizable,
  propose an auto-resolve case via the reviewed PR path: edit `src/resolve/cases.ts` (add a matcher + a
  `tests/` case) on a branch and open it through `propose_workflow_edit` (the dogfooded merge-only gate,
  SPEC §4.4). If it isn't auto-resolvable but you found a reusable playbook, `save_skill` a resolve skill
  named `resolve/<slug>`."*
- (c) inject the **resolve-skills index** into `{{skills}}` (see §3.4).
- Tell it about the `resolve_decision` tool and the bounded verbs (§3.2).

### 3.2 Structured resolution decision (`src/agent/types.ts`, `tools.ts`, `runtime.ts`, `software-dev.ts`)

- Add `resolveDecision(t: Transition)` to `PlatformToolContext`; add a `resolve_decision` tool to
  `TOOL_SCHEMAS` (surfaced only for role `resolve`) whose args are the bounded `Transition` union.
- Add `resolution?: Transition` to `TurnResult`; collect it in `runtime.ts` like `signalCompletion`.
- `withResolve` **consumes** the decision instead of ignoring `r.completed`:
  `resume`/`retryStage`/`gotoStage` → hand to the stage executor; `parkUntil` → enter the parked state;
  `escalate` → jump straight to human escalation (no more burning the 2-attempt budget blindly).
- Pass the interrupted role's stored **session** into the resolve turn so `resume` actually continues it.

### 3.3 Stage machine + quiesce ("does the workflow need to be frozen?")

Refactor the straight-line body of `softwareDev` into an **outer dispatcher**:
```ts
for (;;) {
  switch (stage) {
    case 'setup':  await runSetup();  break;
    case 'do':     await runDo();     break;   // Do⇄Review loop lives inside
    case 'pr':     await runPr();      break;
    case 'merge':  await runMerge();  break;   // point of no return inside
    case 'done': case 'cancelled': case 'failed': return finish();
  }
  if (pendingTransition) applyTransition(pendingTransition);  // at a safe boundary only
}
```
- A transition is **applied only at await/park boundaries**, never mid-activity — that is the "freeze".
  In-flight turns are cancelled via the existing `activeTurn.cancel()` + `Cancelled` sentinel.
- **Rewind rule (§4.3):** `applyTransition({gotoStage})` re-derives `consumed`/`targetLocked` for the
  destination — moving `merge→do` re-opens the target window *unless* a PR bound it; `pointOfNoReturnPassed`
  is monotonic and blocks all rewinds.
- Fix the UI stage aliasing (`SOFTWARE_DEV_STAGES`): `resolve` and `escalated` should render as their own
  nodes (or at least not mis-map `escalated`→`merge`), now that resolve is inspectable.

### 3.4 Close the self-healing loop (`src/platform/api.ts`, new resolve-skills index)

Skills are **write-only** today (`api.saveSkill` writes files; nothing lists/loads). Add:
- `listResolveSkills()` → reads `<contentDir>/skills/resolve/*.md`, returns `{name, summary}` index.
- Inject that index into the resolve prompt's `{{skills}}` (currently hardcoded `''`).
- Wire the Resolve agent to `propose_workflow_edit` for auto-resolve-case PRs (tool already exists).

### 3.5 MCP expansion (`src/platform/mcp.ts`, gateway)

Add the mutate-a-live-task verbs the control-plane MCP lacks, capability-checked: `update_params`,
`set_target`, `goto_stage`, `park_until`, `resume_task`, `read_queue`, plus account controls
(`set_account_availability`, `recheck_account`). The Resolve agent's *self-directed* actions still go
through the structured-decision channel (§3.2); MCP verbs are for cross-task/human-equivalent control.

---

## 4. Part C — Human escalation + UI

### 4.1 Cheap visibility wins (Phase 1 — independent, high value)

- **All-role transcripts, collapsed except the active stage.** Capture Merge/Resolve turn output
  (they run on throwaway arrays today: `software-dev.ts:291,499`) into role-tagged transcripts in the
  view-model; render N `<details>` in `web/app.js` (~`:845`), open only for the active role.
- **Copy-command buttons.** Beside "Open terminal": copy `cd <worldPath> && $SHELL`. Per conversation:
  copy `cd <worldPath> && CLAUDE_CONFIG_DIR=<configHome> claude --resume <sessionId>` (Codex best-effort).
  (No clipboard code exists today.)
- **Remove diffs from review packets.** Drop the git-diff attach at `software-dev.ts:422-433`, the
  `buildReview` diff (`core.ts:251-268`), and the render sites (`web/app.js:829`, widget `:906`). Keep
  `changedFiles`, summary, links.

### 4.2 Human escalation controls (Phase 4)

Same bounded executor (§1/§3.3) surfaced as UI: **rewind to any earlier stage (incl. "unqueue" → draft)**
and edit whatever params that unfreezes (param-edit UI + `editableParams` gating already exist,
`web/app.js:935`). Humans get `resume`/`retryStage`/`gotoStage(+edits)`/`escalate`, **not** `parkUntil`
(§1). Escalation from the Resolve agent (its `escalate` decision, or its own turn erroring) lands here.

---

## Status (updated as built)

- **Phase 1 — Visibility & UI wins — DONE (tested, green).** Per-role transcripts (`TaskView.transcripts`; merge/resolve conversations captured); UI shows one collapsible transcript per role, open for the active stage; ⧉ copy-command buttons (terminal `cd <world> && $SHELL`; per-conversation `claude --resume <id>`); review-packet git diff removed (workflow + `buildReview` + UI).
- **Phase 2 — Quota engine — DONE (typechecks; hermetic suite green).** Coordinator is now provider-aware, status/reset-aware (`available`/`exhausted`/`manual-off`, absolute `resetAt`, weekly window), refreshes on real reset instants, and never head-of-line-blocks across providers; `reportAccountExhausted` (ground-truth feed, with timezone-aware reset parsing in `limits.ts`) + `setAccountAvailability` (manual override); `leasedTurn` leases by provider, surfaces `waitingFor` while parked, reports exhaustion + rethrows so withResolve re-leases; session/config-home binding bug fixed (`sessionMatchesHome`); dashboard shows status + reset countdowns + manual on/off/edit; `/api/accounts/availability` route. Reset parsing = best-effort (host TZ) + conservative fallback + manual override (no quota API exists).
- **Phase 3A — Resolve agent verdict + prompt — DONE (tested, green).** Bounded `transitions.ts` vocabulary; `resolve_decision` tool (+ Claude SDK MCP + mock `@decide`); `TurnResult.resolution`; `withResolve` consumes it (escalate short-circuits retries; resume/retryStage re-run; gotoStage/parkUntil escalate-with-note pending the executor); Resolve prompt rewritten (not-your-job / prefer-auto-resolve+capture-a-skill / skills index).
- **Phase 3B — stage-machine executor (gotoStage/parkUntil rewind) — NOT STARTED.** Risky: refactors the core workflow control flow into a stage dispatcher. Flag before executing.
- **Phase 4 — self-healing PR loop + human rewind UI + MCP expansion — NOT STARTED.**

## 5. Phasing (delivery order)

1. **Phase 1 — Visibility & UI wins (Part C.1).** All-role transcripts; copy-command buttons; remove
   review diffs; fix stage aliasing. Backend: capture merge/resolve transcripts into the view-model.
2. **Phase 2 — Quota engine (Part A).** Coordinator upgrade; limit detection + typed `LimitError`;
   reset-time activity; `session-limit` auto-resolve case; latent session/home bug fix; dashboard.
3. **Phase 3 — Recovery vocabulary + Resolve agent (Part B.1-3).** `transitions.ts`; stage-machine
   refactor + executor + rewind rule; `resolve_decision` tool + `TurnResult.resolution`; resolve prompt;
   pass session to resolve turn.
4. **Phase 4 — Self-healing + human controls + MCP (Part B.4-5, C.2).** resolve-skills index + load;
   auto-resolve-case PR wiring; MCP verb expansion; human rewind/edit/escalate UI.

## 6. Determinism & safety notes

- All clock/timezone/parse work in **activities**; the workflow sandbox never calls `Date.now()`.
- Coordinator edits touch durable continue-as-new state → tested state migration + Temporal patching
  where in-flight (SPEC §4.5, §9). New fields default-safe on replay of old state.
- Transition executor is pure/deterministic; the *effects* (turns, coordinator signals) are activities.
- Capability checks on all new MCP verbs (SPEC §8); the PR gate remains the boundary for workflow edits.

## 7. Open risks / to verify empirically

- Exact shape of the Agent-SDK `rate_limit_event` in the installed SDK version (TS) — verify against
  `node_modules/@anthropic-ai/claude-agent-sdk`.
- Whether copying a Claude `.jsonl` into a second config home + `resume` succeeds end-to-end under a
  managed-policy account (the `disableBypassPermissionsMode` case — mitigated by the existing
  `canUseTool` allow-all approver).
- Timezone source of truth for parsing human-readable reset times (account TZ vs host TZ).
