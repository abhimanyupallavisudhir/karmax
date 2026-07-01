# Plan — dynamic, version-pinned workflow repos (self-healing substrate)

This is item 21: load workflow *packages* from version-pinned git repos at runtime
instead of baking them into the karmax binary, with **replay-compatibility** so a
running execution always sees the exact code version it started under. It's the
substrate the self-healing story leans on: agents PR a workflow repo, a new
version is published, new executions pin it, old ones keep replaying the old one.

---

## 1. Why this is hard (read first)

Everything else in karmax is "just code." This one fights **Temporal determinism**:

- A workflow's history is replayed on every worker pickup. The code that replays
  **must** be logically identical to the code that produced the history, or the
  worker throws a non-determinism error and the execution wedges.
- So we cannot just `import()` whatever `main` of a repo is today and run it —
  a task that started under v1 must keep replaying v1's code even after v2 ships.
- Activities are exempt (they don't replay — only their *results* are journaled),
  so activity code can change freely. **The determinism constraint is workflow
  code only.** This split is the key that makes the plan tractable.

## 2. What already exists (don't rebuild)

- **Package format**: `WorkflowManifest` (`src/contrib/manifests.ts`) — name,
  `version`, `requires`, `events`, `capabilities`, `ui`, `params`, `onActivate`.
- **Version recorded per execution**: `tasks.workflowVersion` (set from
  `manifest.version` at `createTask`; surfaced in the drawer).
- **The reviewed edit gate**: `propose_workflow_edit` (platform MCP) → the
  merge-only PR/test/approve pipeline. Agents already have the *write* path.
- **Contribution loading is already declarative**: slots/commands/events/params
  are data served over `/api/contributions` + `/api/schema`; the client renders
  whatever is declared (incl. the new tier-2 widgets). So **UI contributions from
  a new repo need no client changes** — only the manifest must reach the registry.
- **Single worker, statically-bundled workflows**: `src/workflows/index.ts`
  re-exports the workflow fns; `makeWorker` (`src/temporal/worker.ts`) bundles
  them. This is what we generalize.

## 2b. Workflow-ownership gaps (do these FIRST — they are the package payload)

Loading a workflow from a repo is pointless if the platform still hardcodes how
that workflow's agents are orchestrated. Today the **declared-data** half of the
contribution protocol works (events, params, actions, UI widgets, capabilities-
as-open-strings, commands), but the **agent-orchestration** half is baked into the
binary. A dynamically-loaded package must be able to bring all of the following;
each is a self-contained, testable step that also stands on its own before item 21:

| Gap | Hardcoded in | Becomes |
|---|---|---|
| **Roles** — prompt template, capability ceiling, default agent spec | `DEFAULT_ROLE_TEMPLATES` (`agent/prompt.ts`) + `seedProfiles` (`agent/profiles.ts`), keyed by role string | `roles[]` on the manifest; prompt assembly, seeding, and the profiles UI derive from it. **Phase 0 below.** |
| **Agent tools** — what tools/MCP an agent may wield | fixed `TOOL_SCHEMAS` (`agent/tools.ts`); no manifest hook | `agentTools[]` (+ `mcp[]`) declarable per workflow/role, merged onto the platform baseline |
| **Stages + pipeline UI** — the lifecycle | fixed `Stage` enum + one hardcoded `NODES` pipeline in `web/app.js` rendered for every task | `stages[]` on the manifest; the client renders the workflow's own pipeline from the declaration (falls back to the generic floor) |
| **Auto-resolve** — retry/resolve heuristics | fixed `CASES` (`resolve/cases.ts`) | `resolveRules[]` declarable; platform cases become the default set |
| **Prompt preamble** | `TOOLS_PREAMBLE` + `GLOBAL_INSTRUCTIONS` inlined | optional per-workflow preamble override |

Resolution stays **by role name** (shared vocabulary — configure "merge agent"
once, reused wherever a `merge` role appears), matching how profiles already
resolve. A registry dedupes declared roles by name; a future need for a
same-named role with a *different* template per workflow would add `(workflow,
role)` keying — noted, not built.

## 3. Target model

A **workflow package** is a git repo (or a subdir) at a pinned ref:

```
workflow.json         # the manifest (name, version, requires, capabilities, ui, params, onActivate)
workflow/             # DETERMINISTIC workflow code (the softwareDev-equivalent)
activities/           # Node activities (may use fs/net; not replayed)
ui/                   # optional: extra declarative contributions (data, not code)
skills/               # optional seed skills
```

`version` is an immutable semver-ish tag. Publishing = a new immutable ref in a
**package store** (a content-addressed cache keyed by `name@version` → a resolved,
verified snapshot). Executions pin `name@version`; the store guarantees that ref
never changes.

## 4. The determinism-safe execution design

Three viable approaches; recommendation last.

### Option A — Temporal Worker Versioning (Build IDs)
Temporal's native answer. Each set of bundled workflow code gets a **Build ID**;
the server pins each execution to a Build ID and routes replays to a compatible
worker. New code = new Build ID marked compatible/incompatible.
- **Pro**: correct by construction; Temporal handles routing + old-version replay.
- **Con**: operationally heavy (multiple worker builds/deployments per version);
  karmax would need to spin a worker per active Build ID. Overkill for a
  single-box self-hosted install.

### Option B — Multi-version bundling in one worker (recommended)
One worker process registers **every active version** of every workflow under a
**version-qualified workflow type**: `softwareDev@1.0.0`, `softwareDev@1.1.0`, …
- `createTask` starts the workflow type `${workflow}@${pinnedVersion}` — so the
  execution is bound to that exact code for its whole life (incl. replay).
- Adding v1.1.0 registers a new type; **v1.0.0 stays registered** so in-flight
  executions replay unchanged. Determinism is preserved because a given execution
  never changes its workflow type.
- Workflow code per version is loaded by **bundling** the package's `workflow/`
  entry at worker build time (Temporal's `bundleWorkflowCode`) — one bundle per
  version, or one combined bundle exporting all version-qualified fns.
- **Retirement**: a version is unregistered only once no non-terminal execution
  references it (query the store's task index — we already have it).
- **Pro**: single worker, no per-version deployment; fits self-hosted. Replay-safe
  by the type-pinning invariant.
- **Con**: the worker must (re)bundle when a new version is published → a worker
  refresh (see §6). All active versions live in one process (memory bounded by
  active-version count, which is small).

### Option C — `getVersion`/`patched` gates
Keep one workflow fn; guard changed regions with `patched('x')`. 
- **Pro**: no bundling machinery.
- **Con**: only works for *incremental in-place edits by us*, not for loading
  arbitrary third-party/agent-authored packages. Doesn't deliver the vision.
  Useful **within** a single package's evolution, not as the loading mechanism.

**Recommendation: Option B**, with C's `patched()` available to package authors
for intra-version tweaks. A `WorkflowResolver` maps `name@version` → the bundled
workflow entry; the worker registers all active versions; `createTask` starts the
version-qualified type. This keeps one worker, preserves replay, and loads
agent-authored packages.

## 5. Components to build

1. **Package store** (`src/packages/store.ts`): resolve `name@version` from a git
   repo/ref into a verified, content-addressed local snapshot; cache; expose
   `resolve(name, version)`, `list()`, `manifest(name, version)`. Verify the
   manifest against a schema; refuse code outside the declared shape.
2. **Manifest schema + loader**: promote `WorkflowManifest` to a validated schema
   (zod) loaded from `workflow.json`; the bundled `MANIFESTS` becomes the *seed*
   set, with store-loaded packages merged in.
3. **WorkflowResolver + worker registration** (`src/temporal/worker.ts`): build a
   bundle per active version; register version-qualified workflow types; a
   `refresh(activeVersions)` that adds new bundles without dropping in-use ones.
4. **Version-qualified start** (`src/platform/api.ts`): `createTask` starts
   `${type}@${resolvedVersion}`; `resolvedVersion` = project's pinned version for
   that workflow (a new project/global setting) or the latest published.
5. **Activity loading**: activities from a package are plain Node modules loaded
   into the worker's activity map, namespaced by package; no determinism concern.
6. **UI contributions**: the store's manifests flow into `ContributionRegistry`
   (already data-driven) → `/api/contributions` + `/api/schema`. **No client
   change needed.**
7. **Pinning + upgrade UI**: project settings gets "workflow version" per active
   workflow (pin / upgrade / rollback); a new package publish appears as an
   available upgrade. Reuses the settings-overlay + FieldSpec machinery.
8. **Self-healing loop**: `propose_workflow_edit` (exists) → merge-only gate →
   on merge, publish a new package version → surfaced as an upgrade → user (or an
   autonomy policy) pins it for new tasks. Old tasks unaffected.

## 6. The worker-refresh problem (the one real operational wrinkle)

Publishing a new version must make the worker serve a new bundle. Options:
- **Drain + rebuild**: bring up a second worker with the new bundle set, shift the
  task queue, drain the old (Temporal-native, zero-downtime, heavier).
- **In-process re-register** (simpler for self-host): the TS SDK doesn't hot-swap
  a running worker's registered workflows, so "refresh" = stop + recreate the
  Worker with the enlarged bundle set. In-flight *activities* survive (they're
  re-delivered); workflow executions resume against their pinned types. Do this on
  publish, gated behind a short quiesce. Acceptable for a single-box install.

Decision needed at build time; start with in-process re-register, evolve to
drain+rebuild if multi-node.

## 7. Trust & safety (reuses the capability model)

- Agent-authored packages are **untrusted**: their workflow code runs in the
  Temporal deterministic sandbox (no fs/net already); their activities run with a
  **scoped token** minted from the package's declared `capabilities` ∩ the
  granting principal (existing attenuation). A package can't exceed its manifest.
- Publishing requires passing the **merge-only PR/test/approve gate** — the same
  human/AI review that guards any merge. No package reaches the store unreviewed.
- The manifest's `capabilities` are the ceiling shown to the approver at pin time.

## 8. Rollout phases

Workflow-ownership first (§2b) — each makes the platform derive behavior from the
manifest instead of hardcoding it, so a loaded package can actually bring its own.
These are independently shippable *before* any loading machinery. **All ✅ done:**

- **Phase 0 — `roles[]`** ✅ Manifest `roles[]` (name, label, promptTemplate,
  capabilities, default agent spec); do/merge/resolve templates + seeded defaults
  moved out of `prompt.ts`/`profiles.ts` into declarations; prompt assembly,
  `seedProfiles`, and the profiles UI derive from a role registry (by name,
  deduped). A novel role registers, seeds, and gets its own prompt (tested).
- **Phase 0b — `agentMcp[]`** ✅ A workflow declares MCP servers its agents get on
  top of the platform baseline; `TaskInput.workflow` threaded through so
  `runAgentTurn` reads the manifest and the Agent SDK path merges them into
  `mcpServers`. (Custom function tools with karmax-side handlers still need the
  loadable-package work — item 21.)
- **Phase 0c — declarative `stages[]` + pipeline** ✅ The client renders each
  workflow's own lifecycle from the manifest (software-dev default when
  undeclared), instead of the hardcoded `NODES`.
- **Phase 0d — `resolveRules[]`** ✅ Declarable retry/resolve heuristics (regex
  data), checked before the platform `CASES`.
- **Phase 0e — `promptPreamble` override** ✅ Per-workflow tools-preamble override.

Then the loading machinery (these package declarations are its payload):

- **21a — Package store + manifest schema + loader** ✅ `src/packages/schema.ts`
  (zod validation of a manifest — strict required fields, `.passthrough()` for
  forward-compat) + `src/packages/store.ts` (`PackageStore`: register/validate,
  `resolve(name, version?)` with latest-by-numeric-version, `list`, `versions`).
  `PackageStore.withBundled()` seeds from `MANIFESTS`; malformed packages are
  rejected. No execution change yet — nothing consumes it; 21b wires it in.
- **21b — Version-qualified registration + start** ✅ The worker registers each
  task workflow under a `type@version` export (`workflows/index.ts`, via ES
  arbitrary-string export names — verified to bundle + register on Temporal
  1.11). `qualifiedType`/`pinnedType` (`workflows/names.ts`) map a workflow +
  version to its Temporal type, falling back to the bare type if that version
  isn't registered (unpinned, never a failed start). `createTask` pins to the
  manifest version, `queueTask` to the version stamped on the draft, so a later
  upgrade never swaps a running/queued execution's code. Determinism proven in
  `tests/versioning.test.ts`: two versions of a probe workflow coexist in one
  worker and each execution returns its own pinned version while the other runs.
- **21c — External package load** ✅ Three pieces, all tested hermetically:
  - `packages/repo.ts` `WorkflowRepoLoader` — fetch a workflow repo, pin to the
    exact commit (§4.3), snapshot it .git-free, validate + register the manifest.
  - `packages/bundle.ts` `buildVersionedBundle` — compile external package *code*
    into the Temporal deterministic sandbox under its `type@version`, alongside
    the built-ins (`export *` carries the bundled qualified types through; a
    webpack resolve hook points at the project node_modules). `worker.ts` gained
    an optional `workflowBundle` so a worker can run the augmented bundle.
    `tests/external-workflow.test.ts`: a git-loaded workflow runs end-to-end,
    driving a platform activity, while the built-ins still work in the same worker.
  - `packages/store.ts` `retire()` + `livePinnedRefs()` — refuse to drop a
    version any live execution is still pinned to (the §21b determinism rule).
- **21d — Install/list UI + reachable from the product** ✅ `WorkflowManager`
  (`packages/manager.ts`) ties loader + store + worker refresh together:
  `install({url, ref})` loads a package, registers it, rolls the worker (§21e),
  and refuses to shadow a built-in name; `list()` reports built-in + installed
  workflows with versions; `resolveStart()` (shared with the API via
  `platform/resolve-start.ts`) resolves built-in *or* installed workflows to a
  version-pinned start type. `KarmaxApi` gained an optional `workflows` dep +
  `installWorkflow`/`listWorkflows`; `createTask`/`queueTask` now start any
  registered workflow. Gateway: `GET /api/workflows`, `POST
  /api/workflows/install`. UI: a Workflows card in Global settings (list +
  install-from-git). `main.ts` runs a `WorkerManager` and wires the manager at
  `~/.karmax/workflows`. `tests/install-workflow.test.ts`: install from a git
  repo → list as external → create+run a task on it end-to-end.
- **21d+ — version pinning + self-healing loop** ✅
  - **Version-bump guard**: `install` refuses to re-publish `name@version` from a
    different commit (would swap code under in-flight tasks); an edit must bump
    the version, re-installing the same commit is a no-op. SHA tracked per type.
  - **Per-project version pin**: `pinWorkflow`/`workflowPins` + `createTask`
    honors the pin (`resolveStart(workflow, pinnedVersion)`); a project can hold
    on an older installed version while others take latest. Gateway endpoints +
    a "Workflow versions" card in project settings.
  - **Self-healing loop** (SPEC §4.4): `proposeWorkflowEdit` records the edit
    target; a bus listener in `main.ts` reloads the edited workflow from
    `repo@target` when its merge-only task completes (`reloadSpecForWorkflowEdit`,
    unit-tested; deduped; runs in the gateway process so rolling the worker is
    safe; a forgotten version bump fails the reload loudly, never swaps code).
  - `tests/self-heal.test.ts` + version-bump/upgrade/pin in
    `tests/install-workflow.test.ts`. 167 hermetic tests pass.
- **21e — Worker refresh** ✅ (see the §21e commit — `WorkerManager` rolls the
  live worker with a superset bundle; in-flight executions survive).

## 9. Testing strategy

- Store/manifest: unit tests (resolve, cache, schema-reject malformed).
- **Determinism test (the crucial one)**: start execution under v1; publish v2;
  assert the v1 execution completes replaying v1 (no non-determinism error) while
  a fresh execution runs v2. Use two trivial workflow versions with observably
  different behavior.
- Retirement: a version unregisters only after its last execution terminates.
- Capability: a package can't call an activity outside its manifest ceiling.
- All hermetic (real Temporal dev server + local git refs; no network).

## 10. Open questions (decide before 21b)

- Version identity: strict semver + immutable tags, or content hash? (Lean: tag +
  hash, tag for humans, hash for the store key.)
- Pin granularity: per project only, or per task too? (Lean: project pin, task
  override — mirrors the existing overlay model.)
- Worker refresh: in-process re-register first; when do we need drain+rebuild?
- Do we ever auto-upgrade in-flight tasks? (No — pinning per execution is the
  whole point; upgrades apply to *new* tasks.)

---

**Bottom line**: the determinism constraint is workflow-code-only, and Option B
(version-qualified workflow types in one worker, pinned per execution) satisfies it
without per-version deployments. Most of the surrounding machinery — manifest,
version recording, declarative UI/params, the reviewed edit gate — already exists;
the net-new work is the package store, version-qualified worker registration, and
the pin/upgrade surface.
