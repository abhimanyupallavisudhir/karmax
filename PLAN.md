# karmax — roadmap to a polished, usable product

This plan integrates the user's demands (1–3 below) with the gaps I found in the
v1 build. It is ordered so the foundational, slop-prone pieces are built once and
cleanly, then everything reuses them. TDD throughout.

## The unifying idea (avoids the slop)

Three of the demands and several of the gaps all reduce to **one missing
abstraction: a declared parameter schema per workflow** (SPEC §10.4). Get this
right and task forms, project settings, global settings, defaults resolution, and
the agent selector all fall out of it instead of becoming parallel ad-hoc code.

- **`FieldSpec`** (manifest `params: FieldSpec[]`) is the single source of truth.
- **One form renderer** draws it in three scopes (task / project / global).
- **`resolveParams(workflow, projectId, taskOverrides)`** = the §9 overlay model
  (task → project → global → field default).
- **`assembleTaskInput`** maps resolved fields into `TaskInput` via each field's
  `bind` hint — generic, no per-workflow code.
- The **agent field** produces an `AgentSpec`; `runAgentTurn` builds the effective
  profile from it. No second profile system.

Storage: a `settings(scopeKey, workflow, json)` table (`scopeKey` = `global` or a
projectId). The existing `ProjectConfig` is migrated into
`settings[projectId]['software-dev']` and thereafter derived for the workflow
input — one model, not two.

---

## User demands

### 1. Full task forms (+ drafts)
- Manifest `params` schema per workflow (FieldSpec[]).
- Quick one-line composer **stays**; add an **expand** to the full form.
- Full form = every task-scoped field (prompt textarea, agent-per-role, branches,
  world provider, copy-globs, PR toggle).
- Mirror the same form in **project** and **global** settings (defaults), scoped
  by `FieldSpec.scopes`.
- **Save as draft** (stored, not queued) → edit / queue / delete.

### 2. Agent profiles UI (the `agent` field)
- Composite control: provider, model (provider-scoped list + free text), effort.
- **Resume from a previous agent**: task-search picker **or** raw session id.
- Used in the task form (per-role override) and settings (per-role defaults).
- Wire `input.agents[role]` → `runAgentTurn` builds the effective profile +
  passes the resume session on turn 1. Persist each turn's session id to the
  store so resume-by-task can look it up.

### 3. Global settings + global vs project scope
- Distinct **Global settings** surface (user scope) vs **Project settings** (tab,
  project scope). Both render the per-workflow forms; scope decides which fields
  show and which overlay they write.
- Clarify nav: project-scoped tabs (Tasks / Merge queue / Activity / Project
  settings) vs global (rail-bottom: Dashboard / Global settings).
- Global settings also hosts: agent accounts (connect/register key), profiles,
  safe mode, theme/password.

---

## Build order

> **Status:** Phases A–E are ✅ done (69 tests; verified live incl. real Claude +
> Codex agents). Form fields now **prefill the effective value and store only
> what the user changed** (no inherit-checkbox / "Inherit:" entries). Remaining:
> two small leftovers + Phase F.
>
> Small leftovers (not yet done): instant mid-turn cancel (cancel currently lands
> between turns); a real draft `DELETE` endpoint (today drafts soft-delete in the UI).

**Phase A ✅ — the parameter foundation (unblocks 1, 2, 3 + several gaps)**
1. `FieldSpec` type; generalize `ActionArg`. Manifest `params` for each workflow.
2. `settings` store table + migration of `ProjectConfig`.
3. `resolveParams` + `assembleTaskInput` (overlay resolution + binding).
4. Refactor `KarmaxApi.createTask` to resolve+assemble (no behavior change yet).
5. Tests: resolution precedence, binding, back-compat with existing tasks.

**Phase B ✅ — agent field + resume**
6. `AgentSpec` type; `agent` FieldSpec on the do/merge/resolve roles.
7. `input.agents` → `runAgentTurn` effective-profile build + resume session.
8. Persist per-(task,role) session id to the store; task-search resume endpoint.
9. Tests: agent override changes provider/model; resume passes session.

**Phase C ✅ — drafts**
10. Task `status: draft`; createTask `draft` option; `queueTask`; edit params.
11. Tests: draft not started; queue starts with stored params.

**Phase D ✅ — UI**
12. Generic form renderer from FieldSpec (task / project / global).
13. Expanded task composer + draft controls.
14. Global settings surface; project settings as a tab; nav split.
15. Agent-field UI (provider/model/effort + resume picker).
16. Verify in browser (or curl + Artifact snapshot if automation blocked).

**Phase E ✅ — the trust/correctness gaps**
17. Auto-detect the repo's default branch; validate at task creation.
18. Auto-generated git-diff review (changed files + test result) at Review.
19. Live agent-output streaming into the thread + cancel-a-running-turn.
20. Restart/resume verification + store↔Temporal reconciliation; persist sessions.

**Phase F — deeper spec features (later)**
21. Dynamically-loaded, version-pinned workflow repos + replay-compat (real
    self-healing). This is the substrate the others below lean on for editability.
22. Token/account coordinator wired into the turn loop.
23. Real GitHub PR lifecycle + webhook dispatcher.
24. Archive/delete + world/branch pruning; pagination; observability.
25. **(a) ✅ Profile + account management UI** — edit role profiles
    (provider/model/effort/capabilities/maxTurns/auth) and connect accounts /
    register API keys from Global settings. Backend (ProfileStore, broker,
    /api/profiles) mostly exists; this is forms + a couple endpoints + an
    `edit_profile`/`register_account` platform-MCP tool so agents can self-edit.
26. **(b) Contribution UI tiers 2–3** — a host widget library (list/gauge/thread/
    diff/table) + a renderer that draws whatever a workflow declares into a slot,
    so extension UIs work without bespoke code (today only tier-1 auto-render and
    tier-4 iframe are wired; the core modules are hardcoded, not declarative).
27. **(c) Payments + agent account registration.** Design (converged):
    - **Cards are resources** added at project/global scope (like repos). An agent
      never "owns a wallet"; money is a shared funding source + policy limits.
    - **Two concerns on the two existing layers:** *which* cards an agent may use →
      the capability system (`use-card:<id>` / `use-card:*`, attenuated, default =
      all project cards); *how much* it may spend → the budget-lease (§6), a number
      keyed by the grant — never a number crammed into a capability string.
    - **Three limits + funding (orthogonal):** (1) the agent's **allowance** (grant)
      — soft, exceeding → `needs_approval` (human raises/approves); (2) a **review
      threshold** — big spend within allowance still asks; (3) the **hard cap**
      (card/Stripe limit + optional absolute ceiling) — `denied`, can't proceed.
      Funding availability is separate → `needs_funding`.
    - **`request_spend({amount, merchant, why})`** (platform-MCP tool + activity)
      returns one of `granted` | `needs_approval` | `needs_funding` | `denied`.
      `granted` proceeds with no human; the middle two **park the task** (Temporal
      durable wait) and raise a **review packet** with the amount, the reason, and a
      one-tap action — "Approve / raise allowance" (A) or "Top up $X" + link (B).
      `denied` returns to the agent as a normal tool result so it adapts (cheaper
      option / skip / report blocked) — never hangs, never silently fails. Money
      only moves on `granted` (a point-of-no-return, like the merge commit).
    - **Refine the budget coordinator** (currently flat cap/threshold decline) to
      emit those four outcomes.
    - **Pluggable `PaymentProvider`** (`provision` / `authorize` / `fund` / `revoke`)
      selected by a registry like world providers: `MockPaymentProvider` first
      (no external account, fully testable), then `StripeIssuingProvider`
      (Issuing handles card provisioning, spend limits, merchant locks,
      auth-time decline) or Privacy.com for individuals. The rail implementation
      lives in an editable layer (workflow-repo/skill) so agents can PR changes
      when a provider's API shifts — runtime self-healing depends on (21).
    - **Layering for build:** (c)-1 ✅ = request_spend + four-outcome lease + review-
      packet funding + MockPaymentProvider (done; cards-as-resources, BudgetService,
      Cards/budget UI, 12 tests); (c)-2 = real card rail (Stripe Issuing, external);
      (c)-3 = agent account registration + MFA via broker + browser MCP (large).

28. **(d) Connect accounts + multiple logins + switching** (SPEC §7.3, §6.2). Both
    tools support per-home logins: Claude via `CLAUDE_CONFIG_DIR`, Codex via
    `CODEX_HOME`. Build:
    - A **LoginManager**: mint a config home per (provider × account), spawn the
      provider's own login (`claude setup-token` / `codex login`) with that home's
      env, capture the device/OAuth URL, return it. The user completes OAuth;
      karmax never types credentials. `status()` checks the home for a credentials
      file.
    - **"Connect account" UI** + endpoints (`POST /api/accounts/connect`,
      `GET /api/accounts` lists config-home accounts + login status). Profiles'
      account picker offers config-home accounts, not just key handles.
    - The Claude Agent-SDK path already runs against a profile's `configHome`;
      Codex-*subscription* needs routing through the Codex app-server/CLI (reads
      `CODEX_HOME`) instead of the raw API — larger, sub-item.
    - **Wire the account coordinator (§6.2, item 22) into the turn loop**: lease a
      config home with token headroom per turn, rotate/park on rate limits.
29. **(e) Per-profile MCP baseline in config homes** (SPEC §7.5, §7.3). karmax
    writes a standard `mcpServers` set into each minted home — the karmax platform
    MCP **and** a browser MCP (chrome-devtools / Playwright) — so every agent on
    that profile gets browser automation + the platform API, editable per profile.
    The Claude SDK picks these up via `CLAUDE_CONFIG_DIR`; Codex via
    `config.toml [mcp_servers]`. This is the clean place to *enforce* a tool
    baseline and unblocks §7.5 (and the (c)-3 agent-registration flow, which needs
    a browser). Note: actually executing a browser MCP needs the npx server +
    a browser at runtime — a deployment concern, not karmax code.

These were in the original gap assessment / the accounts+MCP discussion; they were
triaged below the three explicit demands + the trust pass (Phase E), not cut.
(a)/(b)/(c)/(d)/(e) above are the concrete line items.

## Next up (current implementation target)

Per the conversation: **(a)** profile/account management UI, then **(c)-1** — the
`request_spend` four-outcome budget lease + review-packet funding + a
MockPaymentProvider (no external accounts, end-to-end testable). Then (b) the
declarative widget renderer; real Stripe rail, agent registration, and dynamic
version-pinned workflow repos (21) are the larger Phase-F push.

Phases A–D deliver the user's three demands; E is the "make it trustworthy"
pass; F is the long tail. Each phase is independently shippable and tested.
