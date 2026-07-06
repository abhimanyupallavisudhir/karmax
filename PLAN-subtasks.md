# Plan — sub-tasks as a proper hierarchy (raise-to-parent, async join, branch stacking)

Sub-tasks exist and work end-to-end today, but the v1 implementation is a
synchronous fork/join that (a) can only be *awaited to completion*, (b) merges
children straight into `main` as siblings, and (c) auto-confirms children to
dodge a deadlock. This doc records the **intended** behaviour, the **current**
implementation (with file refs), and a **plan** to close the gap.

The three problems turn out to be facets of one change: turning sub-tasks from a
blocking fork/join into a **hierarchical actor model** — children *raise typed
events* to a parent that is an active agent (not a blocked `await`), and work
flows *up the branch hierarchy*, merging into `main` only once at the top.

---

## 0. Status (implemented on this branch)

Phases **A**, **B**, **C**, **D** are all **implemented**. "main" throughout this
doc means *the top-level task's target branch* (`input.target` → project
`defaultTarget`), not necessarily the literal `main`.

What landed:
- **Branch stacking (D)** — `spawnSubTasks` passes `base = target = world.branch`
  and commits-on-spawn (`software-dev.ts`), so a child branches off + merges back
  into the parent's world branch. Only the top-level task merges into *its* target.
  `finalizeMerge` already merges into whichever worktree holds the target, so no
  merge rewrite was needed (the ⚠ in §3-D was a non-issue).
- **Raise channel (A)** — `raiseFromChild` / `parentResponse` signals; children
  spawned via `startChild` (not `executeChild`); the parent is never a dead await —
  it drains child events each Do turn and parks only when idle-waiting.
- **Parent-as-confirmer + typed raises (C)** — a child raises `needs_confirmation`
  at Review, `blocked` at Escalation/merge-fail, and `needs_info`/`needs_permission`
  via `raise_to_parent`. The parent answers with `respond_to_sub_task`
  (confirm/comment/retry/cancel); its reply maps onto the same confirm/retry/
  cancel/follow-up transitions a human drives. Children stay human-resolvable as a
  fallback. `autoConfirm` is kept only for top-level goal tasks (no parent).
- **Async join (B)** — spawn is **non-blocking**: the agent keeps working in the
  same turn and across turns while children run in the background; child raises and
  results interleave as messages (`drainChildEvents` at the top of each Do turn).
  `wait_for_subtasks` lets the agent explicitly park when it has nothing else to do.
  An **end-stage barrier** holds the parent in Do until its children settle, so its
  own Review/PR/Merge never races ahead of delegated work. Fan-out is bounded
  (`MAX_CONCURRENT_SUBTASKS=8`, `MAX_TOTAL_SUBTASKS=50`; over-cap spawns are refused
  with a surfaced message, never silently). Children are cancelled on parent abort.
- **Deadlock fixed** — an escalated child no longer blocks on a hidden human; it
  raises to the parent, which resolves it or bubbles up visibly.
- Tools: `respond_to_sub_task`, `raise_to_parent`, `wait_for_subtasks` (mock DSL:
  `@respond`, `@raise`, `@wait`). Tests (`tests/pipeline.test.ts`): parent-as-
  confirmer + branch stacking, stuck-child-raises-blocked, and async-join +
  end-stage barrier.

Still deferred (nice-to-haves, not blocking): scoping the child's merge capability
to `merge-into:<parentBranch>` (the workflow already pins the child's merge target,
so this is defense-in-depth), and a `waitingFor: 'parent'` vs `'subtask'` UI polish
pass.

---

## 1. Intended behaviour

- **Delegation, not just fan-out.** A Do agent can spawn child tasks to offload
  well-scoped work. Children are full tasks (their own Do⇄Review⇄Merge).
- **Children raise *typed* events to their parent**, not only a final result:
  - `needs_info` — a question about the assigned task → the **parent agent**
    answers (it wrote the prompt; it has the context).
  - `needs_confirmation` — the Review gate → the **parent agent** confirms
    (SPEC §5's stated "parent as confirmer" intent).
  - `needs_permission` — a capability the child lacks (spend, merge target,
    resource) → routed to **whoever holds the authority**: the parent mints a
    scope-attenuated grant if it holds it (SPEC §8.2), else it bubbles to a human.
  - `stuck` — resolve exhausted / merge failure → the **parent agent** decides:
    retry with guidance, replace, abandon, or bubble up.
- **Routing rule:** a raised event goes to the **nearest ancestor with the
  authority/context to resolve it**; only what no ancestor can resolve reaches a
  human. Because every task (parent and child) is the same `softwareDev`
  workflow, this is uniform and **recursive**.
- **The parent is not forced to block.** Spawning is non-blocking. The parent
  agent may then either keep working, or explicitly mark itself *waiting on
  \<children\> (or until an escalation happens)*. The synchronous
  "spawn-then-wait-on-all" is just the degenerate case.
- **Work stacks on the branch hierarchy.** A child branches off its **parent's
  world branch** and merges **back into that branch** — never into `main`
  directly. `main` receives exactly **one** human-reviewed merge per top-level
  task, with all sub-work already assembled underneath.

---

## 2. What exists today (don't rebuild)

The plumbing is real and tested — the gaps are specific.

- **Data model**: `TaskRecord.parentTaskId`, `TaskView.subTasks: string[]`
  (`src/domain/types.ts`); `parentTaskId` column + `childTasks()` query
  (`src/store/db.ts`).
- **Spawn + await**: `src/workflows/software-dev.ts:262-289` — on a turn that
  returned sub-tasks, `Promise.all(... executeChild(softwareDev, ...))` spawns
  each child and **blocks on completion**, then posts results as system messages
  and `continue`s the Do loop.
- **Child record creation**: `core.prepareChildTask` (`src/activities/core.ts:299`)
  — creates the child with the parent's `workflow`/`workflowVersion`/`listId` and
  stamps `parentTaskId`; logs a `subtask.created` event.
- **Agent tool**: `create_sub_task(title, prompt)` (`src/agent/tools.ts:65`,
  handler `:140`). Collected into the turn result (`src/agent/runtime.ts:48`).
- **The escalation *shape* already exists once**: `request_spend`
  (`tools.ts:83`, `runtime.ts:54`) is a typed request → structured outcome
  (`granted | needs_approval | needs_funding | denied`) → human gate (drops a
  note into `reviewInfo`; human funds/approves; agent retries). **This is the
  template to generalize.**
- **States** to build on: `escalated` (blocked, awaits `retry`/`cancel`),
  `review` (`waiting`, awaits `confirm`/`followUp`), and `waiting` status.
- **Merge serialization**: the merge-queue coordinator keys on
  `domain = repo:target` (`src/coordinators/merge-queue.ts`) — reused as-is once
  `target` becomes the parent branch.
- **UI**: task detail lists children as clickable links (`web/app.js:636`).
- **Test**: `tests/pipeline.test.ts:133` — spawn+await one sub-task, parent
  reaches `done`.

### What does NOT exist (the gaps)

1. **No child→parent channel.** A child can only return a terminal result. No
   signals are defined from child to parent; the parent doesn't listen.
2. **The parent is dormant while children run.** `executeChild` blocks the Do
   loop, so the parent *cannot* react to anything mid-flight. This is the root
   cause of everything below.
3. **Escalation is untyped and human-only.** `needsInput` is *inferred*
   (`runtime.ts:88`: `!completed && subTasks.length === 0`) — the agent can't say
   *what* it needs. Escalation collapses to "a human via the queue," and children
   are **filtered out of that queue** (`web/app.js:993`, `!parentTaskId`).
   → An escalated child blocks on a human who can't see it, while the parent
   blocks on the child: **indefinite stall.** `autoConfirm` only bypasses the
   *Review* gate (`software-dev.ts:317`), not the *escalated* gate.
4. **No parent-as-confirmer.** `autoConfirm: true` (`software-dev.ts:280`) skips
   review entirely rather than routing it to the parent.
5. **Forced synchronous join.** `create_sub_task` conflates spawn and join — the
   tool literally returns `"sub-task queued"` but means "awaited now." No
   background spawn, no agent-controlled wait, no partial joins.
6. **Wrong branch topology.** `prepareChildTask` forwards the parent's `base`
   and `target` verbatim (`software-dev.ts:266-275`). So a child branches off the
   parent's **base** (e.g. `main`), *not* the parent's work, and merges into the
   parent's **target** (e.g. `main`) as a **sibling**. Children can't build on the
   parent's unmerged work; two siblings can interleave half-states into `main`.

---

## 3. The plan

Land in dependency order. Phase A is the substrate; B, C, D build on it.

### Phase A — child→parent event channel + non-dormant parent (unblocks everything)

- **Detached spawn.** Replace `executeChild` with `startChild` (get a
  `ChildWorkflowHandle`); record ids in `subTaskIds` (already tracked — reuse for
  cancel). Do **not** await inline.
- **Raise channel.** Define a `raiseToParent` signal on `softwareDev`. A child
  reads its parent from `workflowInfo().parent` (or the `parentTaskId` it already
  has) and signals `{type, payload}` where `type ∈ {needs_info, needs_confirmation,
  needs_permission, stuck, done}`.
- **Buffer + drain deterministically.** The parent buffers raised events in
  workflow state and **drains them into `msgs` at the top of each Do turn** (turn
  boundaries only — mid-turn content injection is non-deterministic; mid-turn
  *cancel* via `AbortSignal` is unaffected).
- **Cancellation bookkeeping.** On parent abort, iterate `subTaskIds` and cancel
  (or deliberately orphan) live children — `executeChild` used to tie lifetimes
  together; `startChild` does not.

Once A lands, the parent is an active agent that can *see* child events — which is
the precondition for B, C, and D.

### Phase B — async spawn + agent-controlled join

- **Split spawn from join.** `create_sub_task` becomes non-blocking (spawn +
  return child id). Add `wait_for(subtasks?, or_escalation)`: the Do loop, instead
  of running the next turn, parks in `condition(() => relevantChildEvent ||
  followUp || cancelled)` with `status: 'waiting'`. Keep-working = just don't call
  `wait_for`.
- **Join invariant at the end.** The Merge/End stage **implicitly waits** for the
  parent's tracked children before merging — preserves today's "parent never
  finishes before its delegated work" guarantee without idle-blocking.
- **Wake conditions** include human `followUp` and `cancel`, not only child
  events, so a waiting parent stays redirectable.
- **Bounds.** Add a per-task/project concurrency cap + max-depth/max-children
  guard (background spawning makes fork-bombs cheap); tighten budget controls.

### Phase C — typed escalation routing (generalize `request_spend`)

- **Typed raise, nearest-resolver routing.** Generalize `request_spend`'s
  request→outcome→gate shape into a general raise. `needs_info` /
  `needs_confirmation` / `stuck` route to the **parent agent** (injected as a
  message; the agent answers, confirms, retries, or bubbles up). `needs_permission`
  routes to whoever **holds the capability**: parent mints an attenuated grant
  (SPEC §8.2) or bubbles to a human.
- **Parent-as-confirmer.** Keep `autoConfirm` as an opt-in *default policy*, but
  when off, a child's Review raises `needs_confirmation` to the parent instead of
  blocking on a hidden human gate. Review and escalation are already independent
  gates (`confirmed` vs `retryRequested`), so they can be policed separately.
- **Visibility fix.** Whatever the parent chooses, if it ultimately needs a human
  it must put **itself** into a queue-visible state (it has no `parentTaskId`, so
  an escalated parent *does* surface at `web/app.js:993`). Never leave the block
  sitting on an invisible child.

### Phase D — branch stacking (children merge into the parent's branch)

- **Retarget children.** `prepareChildTask` passes `base = target =` the parent's
  actual `world.branch` handle (`karmax/<parentTaskId>`) — pass the handle, don't
  reconstruct the name (scratch repos differ).
- **Commit-on-spawn.** Worktrees share the object DB/refs but not working trees —
  a child sees only what's *committed* to the parent branch. The parent must
  snapshot its current work to its branch at spawn time (today it only commits at
  Merge).
- **⚠ Checked-out-branch merge (verify first).** A child finalizing a merge into
  the parent branch can't `git checkout <parentBranch> && git merge` — git forbids
  checking out a branch already live in the parent's worktree. Needs a
  checkout-free strategy (compute merge + update-ref, or merge from the parent
  side). **Audit `finalizeMerge` before committing to this approach** — it's the
  least obvious wrinkle.
- **Parent re-sync.** After a child merges, the parent fast-forwards its working
  copy to the advanced branch tip — piggyback on the Phase-A `done` event
  ("your branch advanced").
- **Scoped merge capability.** Replace children's broad `merge-into:*` with
  `merge-into:karmax/<parent>` — a non-protected branch, so no branch-protection
  issue, and *more* correct + secure than today.
- **Payoff.** Recursive composition (grandchild→child→parent→`main`); `main` only
  ever receives a fully-assembled, human-reviewed parent; sibling half-states can
  no longer interleave into `main`.

---

## 4. Why it's one change

- (C) parent-handled escalation **needs** (A)'s channel and a non-dormant parent.
- (B) async join **is** the same "parent isn't hard-blocked" change from (A).
- (D) branch stacking **needs** (A)'s notifications to re-sync and (C)'s
  parent-owned merges.
- `request_spend` is the existing proof-of-concept for the typed-request-with-gate
  primitive that (C) generalizes.

Ship A first; it is the load-bearing piece. B/C/D can then land independently.
