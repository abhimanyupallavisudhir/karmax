# Plan — git-backed built-in workflows + upstream-sync (custom-behind-master)

A design note for a **deferred** workstream, so the parallel threads converge on one
shape before anyone builds it. Nothing here is implemented yet; this captures the gap,
the model, and the concrete plan. It extends [PLAN-dynamic-repos.md](./PLAN-dynamic-repos.md)
(item 21) and realizes the workflow-code half of SPEC §9.

---

## 1. The gap (why this exists)

SPEC §9: *"Defaults ship immutable and read-only with each release; customizations are
versioned overlays that shadow them. Resolution: project override → user override →
bundled default. Nothing is destroyed; 'restore' is choosing which layer to resolve from."*

That model is **live for settings** (`src/store/overlays.ts` — resolves the layers and
honors `safeMode` by returning the bundled value). It is **not** live for built-in
workflow *code*: the built-ins are compiled into the binary. `src/packages/manager.ts`
says so explicitly — *"the bundled built-ins remain compiled-in; upgrading a built-in over
git is deliberately out of scope here — that needs the built-ins to first become loadable
packages."* Installing a workflow that shadows a built-in name is refused.

Two consequences, both open:
1. **You can't customize a built-in** (edit `software-dev` for your project) the way §9
   promises — only *install new* workflow names.
2. **Upstream drift has no story.** If you overlaid `software-dev` and then karmax ships a
   better `software-dev`, your overlay forked from the old one and silently misses the
   upgrade. SPEC is silent here; this is the hole the "custom-behind-master" idea fills.

## 2. What already exists (don't rebuild)

- **Settings overlay + safe mode** — `src/store/overlays.ts`; gateway flag `KARMAX_SAFE_MODE`
  + toggle route (`server.ts`). Safe mode = resolve with overlays off → vanilla.
- **Version-bump guard** — `manager.ts` refuses re-publishing the same commit; an edit MUST
  bump the version (so old executions keep replaying old code — the determinism rule from
  PLAN-dynamic-repos §1).
- **Restore-at-boot** — `main.ts` reloads installed workflow packages on startup.
- **Built-in collision refusal** — `manager.ts` rejects installing over a built-in name,
  pointing at the PR gate (§4.4) instead.
- **The merge-only PR gate** (`merge-only` workflow) + `propose_workflow_edit` + the
  post-merge reload hook — the dogfooded review+merge+hot-reload path (§4.4).

The auto-sync feature below reuses ALL of these; it adds no new core mechanism.

## 3. Prerequisite (the architecturally significant piece)

**Turn each built-in into a git-backed loadable package**, so it can have a release ref
and a custom overlay — exactly the substrate PLAN-dynamic-repos already built for
*installed* workflows, now applied to the built-ins. Ship each built-in as a repo pinned
to a **release ref** (the immutable default), loaded through the same
`WorkflowRepoLoader`/version-pin path. Safe mode resolves to the release ref.

This is the bulk of the work and where the determinism/replay care lives — do it first,
agree on it separately.

## 4. The overlay + upstream-sync model (the small part, once §3 exists)

Per customized built-in:
- **release ref** = the shipped default (advances each karmax release; immutable floor).
- **`custom` branch** = the user's overlay (their edits).
- **Resolution:** run `custom` if it exists, else the release ref. (That IS "overlay
  shadows default.") **Safe mode** ignores `custom` → runs the release ref.
- **Upstream sync (the user's idea):** when a release advances the release ref past where
  `custom` forked → `custom` is *behind* → **auto-create an UNQUEUED (draft) task** to merge
  the release ref into `custom`, routed through the merge-only gate. Natural detection point:
  **boot after a karmax upgrade** — the same hook as restore-at-boot (`main.ts`), comparing
  each customized built-in's fork point to the new release ref.

Why unqueued/draft: upstream changes can conflict with a customization, so the draft merge
is *reviewed and resolved* before it takes effect — matching §9's "propose, never silently
publish."

## 5. Caveats to fold in

1. **Coordinators are the exception (§9/§4.5).** Safe mode swaps code, not state; a stateful
   coordinator can't be blind-merged-and-run — it needs a tested state migration + Temporal
   patch. An auto-sync task for a coordinator must FLAG this, not pretend it's a clean finite
   merge. Rule: finite workflows edit freely (the floor catches mistakes); coordinators
   demand care on the way in.
2. **Version-pin interaction (already guarded).** The merge produces a new `custom` version;
   in-flight tasks stay pinned to their old version, new tasks get the merged one. The
   existing version-bump guard applies — a merge that forgot to bump fails the reload loudly.
3. **Conflicts are the point of the gate.** If upstream touched the same lines you
   customized, the draft merge task is exactly where an agent resolves it and a human
   approves — not a silent auto-merge.
4. **Safe mode reverts code/behavior, not state (§9).** It keeps the system operable and
   fixable; it does not un-break an in-flight task of a broken custom workflow — let those
   drain or cancel.

## 6. Scope

- **§3 (built-ins → git-backed packages)** is significant and should be designed/approved on
  its own before building. It's the gate for everything else.
- **§4 (custom branch + behind-upstream → draft merge)** is *small* once §3 exists — it's a
  boot-time reconcile that spawns a draft merge-only task, reusing machinery that's already
  here (draft tasks, merge-only gate, restore-at-boot, version-bump guard).

Status: **not started, deferred.** No urgency — nothing is broken; the settings-overlay +
safe-mode floor already protects the app. Pick up when built-in customization becomes a
felt need.
