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

**Phase A — the parameter foundation (unblocks 1, 2, 3 + several gaps)**
1. `FieldSpec` type; generalize `ActionArg`. Manifest `params` for each workflow.
2. `settings` store table + migration of `ProjectConfig`.
3. `resolveParams` + `assembleTaskInput` (overlay resolution + binding).
4. Refactor `KarmaxApi.createTask` to resolve+assemble (no behavior change yet).
5. Tests: resolution precedence, binding, back-compat with existing tasks.

**Phase B — agent field + resume**
6. `AgentSpec` type; `agent` FieldSpec on the do/merge/resolve roles.
7. `input.agents` → `runAgentTurn` effective-profile build + resume session.
8. Persist per-(task,role) session id to the store; task-search resume endpoint.
9. Tests: agent override changes provider/model; resume passes session.

**Phase C — drafts**
10. Task `status: draft`; createTask `draft` option; `queueTask`; edit params.
11. Tests: draft not started; queue starts with stored params.

**Phase D — UI**
12. Generic form renderer from FieldSpec (task / project / global).
13. Expanded task composer + draft controls.
14. Global settings surface; project settings as a tab; nav split.
15. Agent-field UI (provider/model/effort + resume picker).
16. Verify in browser (or curl + Artifact snapshot if automation blocked).

**Phase E — the trust/correctness gaps (from my assessment)**
17. Auto-detect the repo's default branch; validate at task creation.
18. Auto-generated git-diff review (changed files + test result) at Review.
19. Live agent-output streaming into the thread + cancel-a-running-turn.
20. Restart/resume verification + store↔Temporal reconciliation; persist sessions.

**Phase F — deeper spec features (later)**
21. Dynamically-loaded, version-pinned workflow repos + replay-compat (real
    self-healing).
22. Token/account coordinator wired into the turn loop.
23. Real GitHub PR lifecycle + webhook dispatcher.
24. Archive/delete + world/branch pruning; pagination; observability.

Phases A–D deliver the user's three demands; E is the "make it trustworthy"
pass; F is the long tail. Each phase is independently shippable and tested.
