# PLAN — Task triggers

A **trigger** gates *when* a task's workflow starts. A task with triggers is
stored-not-started and *armed*; a dispatcher starts it when a trigger condition
is met. This plan answers the two design questions the feature raised and
records the v1 implementation.

## The two design questions

### 1. Should triggers be a workflow-level parameter, or generic for any task?

**Generic — on `TaskParams`, the same tier as `draft`.** Not in any workflow
manifest.

A trigger governs *whether/when the task's workflow starts*. That is orthogonal
to what the workflow does once it runs. Baking it per-workflow would force every
workflow (software-dev, just-do, script-exec, goal, and every installed package)
to re-implement start-gating, and it would make "run task B after task A" depend
on B's workflow — which is nonsense; the dependency is a property of the *task*,
not its orchestration code.

This mirrors how the codebase already treats lifecycle: `draft` (stored-not-
queued) is a generic `TaskParams` flag, not a manifest param (SPEC §10.4).
Triggers are the automated sibling of `draft` — a `draft` is queued by a human
click; a triggered task is queued by a condition. So triggers live exactly where
`draft` lives.

Consequence: the workflow never sees the trigger. The generic param assembler
(`assembleTaskInput`) only maps declared manifest fields into `TaskInput`;
`triggers`/`triggerState` are extra keys it ignores, so no trigger metadata ever
reaches an agent or a workflow execution. The gate is entirely pre-start.

### 2. What kinds — and should we support all general karmax event triggers?

**Yes. `event` is the general form; the other kinds are ergonomic
specializations of it.** One mechanism, three shapes:

| Kind | Fires when… | Recurs? | Notes |
|---|---|---|---|
| `dependency` | other task(s) reach a terminal outcome | no (one-shot) | sugar over `event` on the `view.updated` lifecycle feed |
| `schedule` | a cron matches, or a one-shot `at` time arrives | cron: yes; `at`: no | evaluated in UTC |
| `event` | **any** karmax event (SPEC §5) matches type + optional source-task + payload filter | opt-in | the general case: GitHub webhooks, world lifecycle, quota refills, custom workflow events |

Rationale for keeping all three rather than only `event`:

- `dependency` is the overwhelmingly common case ("run B after A"). Expressing it
  as a raw event trigger (`type: 'view.updated', taskId: A, where: {status:'done'}`)
  is possible but leaks the lifecycle-event name and can't express *all-of / any-of*
  across several deps. It earns a first-class shape.
- `schedule` isn't an event at all — it's time. It needs its own arming path
  (timers), so it's a distinct kind.
- `event` is the escape hatch that makes the answer to "should we support all
  general karmax event triggers?" a clean **yes**: anything on the bus (SPEC §5,
  §3.3) can trigger a task, including events emitted by other workflows and, once
  the dispatcher grows webhook ingress, external systems.

Composition: a task may carry **multiple** triggers; they combine with **OR** (any
one firing starts the task). Within a single `dependency` trigger, `mode: 'all'`
(default) or `'any'` controls how its `tasks` list combines. `dependency.on` ∈
`success` (default) | `done` | `failed` | `settled` selects which outcome counts.

## Architecture

No new durable machinery. The design reuses two things the codebase already has:

1. **The store as the durable source of truth.** An armed task is a normal task
   row with `params.triggerState = 'armed'` and `params.triggers = [...]`. It is
   stored-not-started, exactly like a draft (and `reconcile.ts` skips it on boot,
   like a draft, because it has no workflow yet).
2. **The in-process event bus + a dispatcher.** SPEC §3.3 reserves a thin
   *dispatcher* that "routes external happenings to the right workflow as signals
   … underneath control flow, never the control flow itself." The self-heal loop
   in `main.ts` already demonstrates the pattern (`bus.onAny` → react). The
   trigger dispatcher is the same shape.

### Components

- **`src/domain/triggers.ts`** (pure, no Node/Temporal): the `TaskTrigger` union,
  validation, event matching, dependency satisfaction, recurrence classification,
  and a self-contained UTC cron parser + next-fire. Pure so it's cheap to unit-test
  and safe to import anywhere (including, later, a Temporal workflow sandbox).
- **`src/platform/trigger-scheduler.ts`** — `TriggerScheduler`, the dispatcher.
  On `start()` it re-arms every stored armed task and subscribes to the bus. It
  routes bus events to armed tasks (event + dependency triggers) and runs
  wall-clock timers (schedule triggers). Clock/timers are injectable, so the whole
  thing is unit-testable with a fake clock — no Temporal server.
- **`KarmaxApi`** — `createTask` diverts a triggered task to armed instead of
  starting it; `fireTriggeredTask(taskId, mode)` starts it when a trigger fires;
  `cancelTrigger(taskId)` disarms it back to a draft. The API holds an optional
  `TriggerArmer` hook (the scheduler) so newly-created armed tasks arm live; the
  boot-time re-arm covers everything else.
- **`main.ts`** — constructs the scheduler after the API (resolving the
  construction cycle via `api.setTriggerArmer`), mints it a system token, `start()`s
  it, and `stop()`s it on shutdown.
- **Gateway** — `POST /api/tasks/:id/cancel-trigger`. Creation needs no new route:
  the existing task-create endpoint already forwards `params.triggers`.

### Firing: one-shot vs recurring

- **One-shot** (`dependency`, `at`, non-recurring `event`): the armed task itself
  starts (`mode: 'self'`) and is disarmed. To prevent a double-fire from
  overlapping events, the entry is disarmed *before* the async start is awaited;
  a start failure re-arms it so a fire is never silently lost.
- **Recurring** (cron by default, opt-in `event`): each fire spawns a fresh
  **clone** (`mode: 'clone'`) that runs immediately with the trigger metadata
  stripped, and the armed template stays in place for the next occurrence.

### Durability & restart

State lives in the store, so a restart re-arms everything from
`store.listArmedTasks()`. A cron that should have fired while karmax was down
fires on the next boot; dependency state is re-derived from each dep's last
recorded status (`lastView.status`), so a dep that completed during downtime is
detected at arm time. Node's ~24.8-day timer cap is handled by re-arming long
waits in chunks.

## Setting triggers (UI + API)

**UI.** The expanded task composer ("⋯ More") has a **Triggers** section:
- *Task dependencies* — a chip/token input: type to search the project's tasks,
  click or Enter to add a chip, ✕/Backspace to remove. Multiple chips = one
  `dependency` trigger over all of them (AND; outcome is always "reached Done").
- *On a schedule* — five labelled cron cells (Minute / Hour / Day / Month / Day of
  week) with range hints, evaluated in UTC.
- *Or run once at* — a datetime picker (`at`).
- *On an event* — a schema-driven picker: pick an event type from the catalog
  (`GET /api/events/catalog` = every workflow's declared events + curated platform
  events, grouped by source), then optionally add **payload filters** (rendered
  from that event's declared fields — e.g. `status = done`) and scope it to a
  source task. Produces an `event` trigger `{ type, where?, taskId? }`.

The **Repeatable** toggle is a prominent task-level control (a schedule auto-checks
and locks it). Leave triggers empty to start immediately. A task waiting on a
trigger shows a **waiting for trigger** badge + summary, with **Run now** and
**Cancel** (disarm → editable draft). Clicking it opens the editable form
(`updateArmedParams`; Save re-arms, Save-as-draft disarms).

**API.** `POST /api/projects/:id/tasks` with `params.triggers: TaskTrigger[]`.
Queuing a triggered draft (`POST /api/tasks/:id/queue`) *arms* it rather than
starting it. `POST /api/tasks/:id/run-now` starts an armed task immediately;
`POST /api/tasks/:id/cancel-trigger` disarms it back to a draft.

## Repeatable series (Model A — template + runs)

A task can be **repeatable** (`params.repeatable`). A repeatable task is a
**series**: it never runs its own workflow — it spawns independent **run**
records, each a normal task (`params.runOf = seriesId`) with its own world,
transcript, diff, and status.

- **Toggle** in the task form. A cron/recurring trigger **forces it on** (a schedule
  fires forever, so its task can't be a one-off) — the checkbox auto-checks and locks.
- **When runs are spawned:** on each trigger fire (the dispatcher fires `clone`
  for a repeatable series and leaves it armed); on **Run again** (manual, any
  time); and once immediately on create for a *triggerless* repeatable task so it
  isn't inert.
- **Non-repeatable tasks** are unchanged: the task itself runs once (`self`).
- **Display:** the series shows as one row with a `repeatable` badge, the schedule
  summary, and a run count + latest-run status; a caret expands it to list the
  runs (each opens the normal task view). Runs are hidden from the top level and
  grouped under their series.
- **Editing:** clicking a series opens a dedicated **config drawer** (the usual
  drawer surface) with the full editable parameter form (fields + triggers +
  repeatable + notes), a **Runs** list, and **Run again** — saved via
  `updateArmedParams` (the series has no running workflow, so its params are freely
  editable, like a waiting task). It isn't live-refreshed while open (that would
  clobber edits).
- **API:** `POST /api/tasks/:id/run-again` (spawn a run), `GET /api/tasks/:id/runs`
  (list runs). `run-now` on a series spawns a run; `queueTask` on a series spawns
  a run rather than starting a workflow; `reconcile` skips series (no workflow of
  their own). Editing a series (form or `updateArmedParams`) preserves the series.

## Deliberately deferred

- **Full Temporal-native durability.** SPEC §3.2 earmarks `continue-as-new` for
  recurring tasks and signals for "dependency satisfied", i.e. a singleton
  `triggerCoordinator` workflow (the §6 lease/coordinator pattern) is the
  end-state for surviving a crash *mid-pending-timer* without a boot to re-arm.
  The pure `src/domain/triggers.ts` module was written sandbox-safe precisely so
  that coordinator can reuse it verbatim. The in-process dispatcher is the v1
  seam; promoting it to a coordinator is additive.
- **External event ingress** (GitHub webhooks, etc.) feeding the bus — the event
  catalog + payload-filter builder are in place; once a webhook receiver emits
  those events onto the bus, `event` triggers pick them up with no dispatcher
  change. (The catalog can also grow to include installed-workflow events.)
- **Timezone-aware cron** (currently UTC) and per-fire jitter.

## Example

```jsonc
// Run a nightly job at 09:00 UTC on weekdays (recurring — spawns a fresh run each time)
{ "params": { "prompt": "run the smoke suite", "triggers": [{ "kind": "schedule", "cron": "0 9 * * 1-5" }] } }

// Start only after two other tasks both succeed (one-shot)
{ "params": { "prompt": "deploy", "triggers": [{ "kind": "dependency", "tasks": ["task_build", "task_test"], "mode": "all" }] } }

// React to any matching karmax event (the general form)
{ "params": { "prompt": "post-merge cleanup", "triggers": [{ "kind": "event", "type": "github.pr-merged", "where": { "branch": "main" } }] } }
```
