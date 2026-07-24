# karmax — Build Specification

> A complete specification for an agent-orchestration platform centered on a todo list. Written to be handed to a coding agent as the source of truth for v1, with design rationale included where a decision is non-obvious. v2 material is isolated at the end.

---

## 0. Philosophy

karmax is built on three convictions:

1. **Everything is a todo list.** Just as the development environment of the past was a fancy text editor, the development environment of the AI era is a fancy todo list. Every unit of work — a coding change, a script run, a real-world action, even setting up the system itself — is a **task** on a list, assignable to a human or an agent. There is no second organizing abstraction competing with the task list.

2. **Self-healing infrastructure.** Agents do not merely run inside karmax; they can *repair and extend* it. They edit workflows, add error-resolution cases, and save skills — all through the same reviewed, versioned mechanisms a human would use. The system is designed to get more reliable through use.

3. **Whatever can be automated, should be.** Human attention is the scarcest resource. Errors are resolved automatically before a human is asked. Agents register accounts, log in, drive browsers, and pay for services within bounded budgets. A human is pulled in only at genuine decision points (review gates, irreversible actions, spending above a threshold) — never for mechanical work the system could do itself.

### The architectural through-line

One meta-principle makes the above buildable without collapsing into unmaintainable complexity: **keep the hard, slop-prone core small, and make every capability a pluggable layer that the core does not know about.** Concretely, three patterns recur throughout this spec, and almost every feature is one of them:

- **The durable workflow** — a long-lived, crash-proof orchestration process per task. All control flow is this.
- **The lease coordinator** — a singleton that hands out leases on a scarce resource (merge slots, agent-account capacity, spend budget). All contention is this.
- **The declared contribution** — a typed, declared thing (an event type, a UI panel, an action, a world provider) that the host renders or routes without anticipating it. All extensibility is this.

A fourth principle governs all three: **declare, don't guess.** Events, actions, UI, and capabilities are always declared with a typed contract that consumers bind to. Nothing reverse-engineers another component's shape.

---

## 1. Technology stack

- **Durable execution engine: Temporal.** This is the spine and is non-negotiable for v1. It provides the durability, event delivery, timers, retries, child workflows, and state queries that the platform would otherwise reimplement badly. See §3.
- **Language: TypeScript end-to-end** (Temporal TS SDK for workflows/activities, the gateway, and the web UI), for cohesion and shared types across the workflow contract and the UI. (Temporal also supports Python/Go/Java if a different choice is made later; the spec assumes TS.)
- **Coding agents: Claude Agent SDK and Codex (app-server / SDK)**, behind a provider-adapter interface (§7).
- **Secrets: a credential broker** backed by a vault (HashiCorp Vault, a cloud secret manager, or 1Password Unified Access). See §8.
- **Worlds: a provider interface** with local and pluggable remote/sandboxed backends (§11).
- **Remote access: Tailscale (default) or Cloudflare Tunnel + Access** (§12).
- **Data home:** `~/.karmax/` holds workflow repos, agent config homes, prompt/skill content, and local state.

---

## 2. Domain model

| Concept | Definition |
|---|---|
| **Organization** | The tenant boundary owning memberships, teams, projects, repository connections, execution policy, runner pools, identity policy, usage, and audit. |
| **Project** | An organization-scoped namespace owning task lists, settings, active workflows, and configuration. |
| **Task list** | An ordered list of tasks within a project. The primary surface a user interacts with. |
| **Task** | A unit of intent. Has a workflow, parameters, a message history, a stage, and a view-model. In v1 a task runs exactly one execution. |
| **Workflow** | A durable orchestration *definition* (code) describing how a task is carried out. Versioned, tested, agent-editable. See §4. |
| **Agent profile** | A declarative spec parameterizing an agent (provider, model, effort, tools, prompt templates, capabilities, limits). See §7. |
| **World** | The environment a task's work happens in: a git worktree, a container, or a remote sandbox. Accessed through a provider interface. See §11. |
| **Resource coordinator** | A singleton workflow that leases a scarce resource (merge slot, agent account, budget). See §6. |
| **Event** | A typed, namespaced, schema-declared message emitted by a workflow onto the event bus. See §5. |
| **Capability** | A named permission (e.g. `create-task`, `merge-into:<repo>:<branch>`). Granted to principals (users, agent profiles) with scope. See §8. |
| **Credential** | An external secret (login, API key, card) resolved at runtime from the broker via a handle, never stored in plaintext. See §8. |

**Design note — why projects and task lists are fundamental, not workflows.** Workflows are how work is *done*; tasks are the work itself. A user thinks in tasks on a list, not in orchestration graphs. The list is the spine; workflows are an implementation detail of each task.

---

## 3. Core architecture: durable execution

### 3.1 What a workflow execution is

Each task runs as one **Temporal workflow execution**: a durable function whose state is reconstructed by deterministically replaying an append-only event history. It behaves as a single process that never crashes and can block for arbitrary durations (seconds to weeks) on external events, holding no thread or process while parked.

**The determinism rule is mandatory and load-bearing.** Workflow code may only: call activities, start child workflows, start durable timers, wait on/handle signals, answer queries, and do pure computation. Every side effect — LLM calls, spawning agents, opening PRs, file/network I/O, clocks, randomness — **must** be wrapped in an **activity**, whose result is journaled once and replayed thereafter. This constraint is a feature: it forces a clean separation between *deciding what happens* (the workflow) and *doing it* (activities), which is exactly the separation a naive event-driven design lacks.

### 3.2 The primitives and what each is used for

- **Activity** — side-effecting work, with retries/timeouts. (Create world, run an agent turn, open a PR, run CI.)
- **Signal** — async event delivered into a running workflow. (Follow-up message, hotfix, merge-slot granted, manager confirmation, dependency satisfied.) Durable; queued even if no worker is polling.
- **Query** — read-only re-run returning current state without mutation. (The task's view-model: "what stage, what actions are allowed.")
- **Update** — synchronous signal with a validator and a return value; can reject before admission. (Change target branch, but only if the PR is not yet open.)
- **Child workflow** — a separately-tracked execution a parent starts and awaits. (Sub-tasks.)
- **Task queue** — routes work to workers; a queue served by a single worker with one slot serializes work. (Merge serialization.)
- **continue-as-new** — restarts an execution with fresh, empty history carrying input forward. (Long-lived coordinators; recurring tasks.)
- **signal-with-start** — create-or-signal atomically. (Enqueue into a coordinator without caring whether it already exists.)
- **Versioning / patching** — branch behavior by version so in-flight executions keep their original code path while new ones take the new one.

### 3.3 The event bus / dispatcher

External happenings (GitHub webhooks, token-window refills, cross-task dependencies) are routed to the right workflow as signals by a thin **dispatcher**. This is the only legitimately "event-driven services" layer in the system, and it sits *underneath* control flow as a router — it never *is* the control flow. Workflows emit typed events (§5); the dispatcher delivers them as signals to subscribers.

**Design note — why not model workflows themselves as reactive event rules.** A swarm of "on event X in state Y do Z" rules makes a task's state implicit, scattered, and unanswerable. Durable imperative code keeps the state explicit and the control flow readable even with waits, parallelism, and sub-tasks. Reactive routing belongs only in the transport layer.

### 3.4 The gateway and the platform MCP server

- **Gateway** — a thin, stateless HTTP service that translates requests into Temporal `signal`/`query`/`update` calls and enforces authz. It holds no business logic. The web UI and phone talk only to the gateway.
- **Platform MCP server** — the single API that agents use to act on the system: create/edit tasks, create review info, spawn sub-tasks, save skills, edit workflows (via the reviewed path), reorder coordinators, etc. One MCP server given to every agent; integration is written once because both Claude and Codex speak MCP. Every call carries a scoped credential and is permission-checked (§8).

---

## 4. Workflows

### 4.1 What a workflow is

A workflow is **a package of ordinary durable-execution code**, not a configuration file and not a graph the system interprets. The control flow is written as readable imperative TypeScript: stages are plain sequencing, waits are `await`s on conditions, sub-tasks are awaited child workflows, contention is a lease. This is deliberate — full programming-language power and debuggability, with no interpreter to build or maintain.

**Two distinct nouns share the word "workflow":**

- The **definition** — the editable, versioned, tested code artifact. This is the product concept users and agents work with.
- The **execution** — a running Temporal instance of that definition for one task.

Keeping these separate resolves most apparent contradictions about editing "a workflow."

### 4.2 Repo layout

Each workflow lives in its own git repo under `~/.karmax/workflows/<name>/`:

```
~/.karmax/workflows/software-dev/
  manifest.ts          # name, version, requires, event schemas, capabilities,
                       # onActivate hook, UI slot contributions, command registrations
  workflow.ts          # the durable orchestration spine (deterministic)
  activities.ts        # side-effecting work: createWorld, runAgentTurn, openPr, ...
  prompts/             # role prompt templates referenced by agent profiles
    merge.md  resolve.md
  resolve/cases.ts     # auto-resolve case list (matcher -> vetted action)
  ui/                  # slot contributions (task panel, project-settings section, ...)
  api/actions.ts       # action -> signal/update/query mapping for the gateway
  tests/workflow.test.ts
```

### 4.3 The manifest

`manifest.ts` is what the host reads to wire a workflow in. It declares:

- `name`, `version` (semver; the git SHA is the precise pin).
- `requires: [...]` — other workflows this one depends on (e.g. software-dev `requires: ['merge-queue']`). Activating a workflow activates the transitive closure.
- `events: {...}` — the typed event types this workflow emits, each with a schema (§5).
- `capabilities: [...]` — capabilities this workflow's agents may need (the ceiling; §8).
- `onActivate` — an optional preparation task the workflow contributes; the default workflow's runs automatically when a project is created (§4.6).
- `ui: [...]` — slot contributions (§10).
- `commands: [...]` — command/keybinding registrations (§10).

### 4.4 The update model (this is the crux of "agent-editable")

There are **two different artifacts with two different update models**:

**Workflow code** is deterministic and replay-bound, so it is **version-pinned per execution**. A task records the workflow version at creation and runs that version to completion; new tasks pick up the newest version; running tasks are never hot-swapped. A published `type@version` export is immutable: changed command ordering or behavior is registered under a new version while the old implementation remains available for replay. Editing is **a pull request, literally**:

1. An agent (or human) edits the workflow repo on a branch.
2. The workflow's own test suite runs, plus a replay-compatibility check.
3. A human (or trusted-policy gate) reviews and approves.
4. Merge publishes a new version.

This PR gate is **the single most important safety boundary in the system**: agents can *propose* changes to live orchestration but never *silently publish* them. The review itself is run by the **merge-only workflow** (§5 of workflows list) pointed at the workflow repo — the gate is dogfooded, not separate machinery.

**Prompts, skills, and memory** are content, not deterministic code, so they get the opposite model: **freely editable, snapshotted at the point of use.** When prompt assembly composes what goes to an agent, the concrete text is recorded as the (journaled) input to that turn. Editing a skill therefore never rewrites a past task and simply applies to future uses. No versioning ceremony is needed for content.

> **Rule of thumb: content the agent reads is free to edit; code that auto-runs is gated.**

**The wiki is that content system's home.** Each organization and each project owns a wiki under `~/.karmax/content/wiki/<scope>/<id>/` — skills, memories, and prompts are all the same thing to the system. An entry is a **folder** holding a `SKILL.md` or `MEMORY.md` in the standard Agent Skills format (YAML frontmatter, then markdown); the folder name is its title, any other files (scripts, images, even further md files) ride along without becoming entries, and folders without a page file are sections that nest the tree. Frontmatter carries `name`/`description` plus two delivery controls: `delivery: unconditional | indexed` (default indexed) and `importance: <number>` (default 0). An *indexed* entry appears in the **table of contents** agents receive; an *unconditional* entry's full body is sent with every prompt — a scope's "general prompt" is simply an unconditional entry, and the built-in karmax working instructions ship as a bundled default at `@builtin/how-to-work` — an on-disk entry at that exact path is its editable override (the §9 overlay model: editing customizes, deleting the override restores the default; the rest of the `@` namespace stays reserved and built-in identities never rename). Every agent turn receives, in order: the built-in instructions, then per scope (organization, then project) its unconditional entries in full followed by the indexed TOC (names + descriptions only, expanded to every leaf, siblings ordered by importance). When a TOC's estimated tokens exceed 20k, each penultimate list of ≥10 entries keeps its 9 most important and folds the rest behind a `[more…]` link naming the exact expansion call. Agents navigate with `read_wiki` (TOC / section / full page) and grep with `search_wiki`; both are gateway-backed platform tools that run host-side, so they work identically from local worktrees and cloud sandboxes. Reads need the scope's read capability; writes reuse `skill:write` (the wiki *is* the skills store).

### 4.5 Versioning and in-flight changes

Finite task workflows rarely need in-flight migration — let running tasks drain on their pinned version. Long-lived coordinators (§6) are the exception: their durable state outlives any code version, so coordinator edits require tested state migrations and Temporal patching for in-flight executions. See §9 for why safe mode does not rescue them.

### 4.6 Registration hooks and dependencies

Two manifest mechanisms, kept deliberately minimal:

- `requires` — declared workflow dependencies, resolved transitively on activation.
- `onActivate` — a workflow may declare a **task** (run by an agent) to prepare a project for it. A new project's tasks default to the software-dev workflow, so on project creation karmax automatically seeds software-dev's prep task — "make this project karmax-ready": ensure git is initialized in each repo; for brownfield repos, scan for hardcoded resources (e.g. ports) that would collide between worktrees, and fix them. It's seeded as a **draft** (a project is usually named before its repo is set, and a repo-oriented task can't run without one), so it waits on the list for the user to queue once the repository is configured. (There is no separate "activate a workflow on a project" step — a task selects its workflow directly.)

**Design note.** The bootstrap is *itself a karmax task*, which is the philosophy applied to the system's own setup. Do not generalize this into a large lifecycle-event framework; `requires` plus `onActivate` (and optionally `onDeactivate` later) is sufficient.

### 4.7 Standard workflows shipped in v1

- **software-dev** — branch/world → do → review → PR (optional) → merge → end, with resolve and sub-tasks. Detailed in §5.
- **just-do** — a single straightforward agent call, no merge machinery.
- **script-exec** — run a script/command as a task.
- **goal** — like software-dev, but auto-confirms after the provider reports a verified successful turn completion. `signal_completion` may attach a structured summary but is not required.
- **merge-only** — the review-and-merge half of software-dev (no Do stage). Starts at the review gate, then optional PR, then merge. Used to review agents' PRs, including edits to workflow repos.
- **merge-queue** (coordinator) — leases the single merge slot per target branch (§6).
- **token/account coordinator** — tracks per-account limits and leases agent-account capacity (§6, §7).

---

## 5. The software-development workflow (detailed)

### 5.1 Stages and flow

```
Setup → Do ⇄ Review → PR → Merge → End
                │
                └── (Review can be a human or an AI/parent task)

Resolve is cross-cutting: any stage on error → auto-resolve → Resolve agent → resume or escalate.
Sub-tasks: during Do, spawn child workflows and await them.
Merge is the point of no return.
```

> The **Review** stage is the gate formerly called "Confirm"; it resolves either by **confirming** (advance) or by **sending a follow-up** (return to Do). Name is adjustable.

### 5.2 Stage details

**Setup.** An activity creates the world (a git worktree off the base branch, or a container/remote world per project config; §11), copies the gitignored files the project config names, and allocates non-conflicting resources (ports). Records the world handle in workflow state.

**Do.** Runs the assigned coding agent profile **one turn per activity** (`runAgentTurn`). Between turns only a session ID is stored; the agent process does not exist while the task waits (§7). During a turn the agent may, via the platform MCP: create review info, spawn sub-tasks, save skills, and **signal completion via a structured tool call** (not a parsed "promise" string — structured is unambiguous and unspoofable). On completion/idle/needs-input → Review.

**Review.** The workflow's view-model exposes the allowed actions `[confirm]` and `[send follow-up]` plus review info. The **confirmer** is an ordered list of **confirm layers**, played sequentially each time the task reaches Review — each layer is either a **human** confirmation (waits for the Confirm click) or a **Confirm agent** turn that reviews the work and returns a structured verdict (confirm / revise / reject — the same transitions a human drives). Every layer must approve for the task to advance; a revise/follow-up returns to Do and the next Review replays the sequence from the first layer. Zero layers ⇒ auto-confirm; the default is a single human layer; "agent review, then a final human confirmation" is two layers. Layer lists inherit like every other field (task → project → global defaults). For a **sub-task the confirmer is the parent task's workflow** regardless, which receives the child's review info and either confirms or sends a follow-up — the ordinary parent/child signal pattern. Confirm → PR. Follow-up → append to agent input, return to Do.

**PR.** Opening a GitHub PR is **optional** — a project setting gated by GitHub authorization. The Review stage *is* the conceptual PR; a GitHub PR is just an optional integration output. Off → the merge agent merges branches locally under the queue. On → open a real PR.

**Merge.** Enqueue in the merge-queue coordinator for the target branch; on grant, run the **merge agent** in the world; release the lease; → End. The merge commit is the **point of no return**: before it, the task may be cancelled; after it, not.

**Resolve (cross-cutting).** On an unhandled error at any stage, route first to **auto-resolve** (scripted handlers keyed on error signature — retries, known fix scripts). Provider-originated failures keep their structured classification through this path: transient usage/session limits mark the current credential exhausted and rotate to another compatible login or park until its reset; transport/provider outages and recoverable process interruptions retry the checkpointed session without spending a Resolve turn. Persistent faults such as invalid configuration, permissions, disk exhaustion, or credentials that require funding/re-auth remain human decision points rather than being retried blindly. On an auto-resolve miss/novelty, spawn the **Resolve agent** with a context bundle. On fix → resume the originating stage; on failure → escalate to the human via the task UI. A human/parent Retry leaves Escalated immediately and restores the originating public stage while the replacement work is waiting or running. Fixes the Resolve agent discovers are saved as skills.

### 5.3 Transition rules

| From | To | Condition |
|---|---|---|
| Setup | Do | world ready |
| Do | Review | provider's verified successful turn terminal event (or an explicit raise) |
| Do | Do | sub-tasks spawned → awaited → resumed |
| Review | Do | follow-up message |
| Review | PR | confirm |
| PR | Merge | PR opened (if enabled) **and** merge-queue slot granted |
| Merge | End | merge success |
| any | Resolve | unhandled error |
| Resolve | (origin) | fix succeeded |
| Resolve | human escalation | fix failed |

### 5.4 Prompt templates (shapes)

Assembled per role by an activity that fills the **role template** (owned by the agent profile) with **task bindings** (owned by the workflow) plus global/project instructions, then snapshots the result as the journaled turn input.

- **Do agent:** global + project instructions; a "you are running inside karmax; here are your tools" preamble listing the platform MCP tools (create-sub-task, create-review-info, optional signal-completion summary, save-skill); the world handle; the task prompt.
- **Merge agent (`prompts/merge.md`):** "You are merging task `{{task}}`. Its work is on branch `{{branch}}` in the worktree at `{{path}}`. Merge `{{targetBranch}}` into this branch, resolve conflicts, ensure the build and tests pass, then merge into `{{targetBranch}}`. Review context: `{{reviewInfo}}`. Finish only when the branch is ready."
- **Resolve agent (`prompts/resolve.md`):** "The `{{stage}}` step failed for task `{{task}}`. Error: `{{error}}`. Worktree: `{{path}}`. Recent transcript: `[[transcript]]`. Candidate resolution skills: `[[skills]]`. Diagnose and fix so `{{stage}}` can resume; if you cannot, explain why."

`{{...}}` are bindings filled at assembly; `[[...]]` are links resolved from the content store at assembly time and snapshotted.

### 5.5 Per-stage task UI

The task UI is the view-model the workflow projects (§10). Always present: title, message history, stage indicator, and two **cheap check-in** affordances:

- **Open a terminal in the world** — a PTY spawned on demand against the on-disk worktree / via the world provider's PTY. Ephemeral; nothing persistent.
- **Open the conversation** — renders the *stored session transcript*. It does **not** resume the agent (the agent only runs during a turn). This is what keeps check-in cheap. The transcript is an ordered, timestamped timeline: human/agent messages plus provider-native work items normalized into stable kinds (reasoning, command, file change, tool/search, sub-agent, and lifecycle status). Item updates retain their provider id so `started → completed/failed` renders as one evolving row. These presentation events never enter the model's `Message[]` input history.

Stage-gated actions:

- **Pre-send:** editable initial prompt + parameter forms (target branch, agent profiles).
- **During Do:** live output stream (from the event log), a queue-a-follow-up box, a cancel button (live only before the point of no return).
- **At Review:** confirm / follow-up actions, plus the review panel (links to a running server, diffs, polished output the agent created).
- **In the merge queue:** position in queue, reorder / cancel-if-allowed.
- **Post-merge:** read-only links to the PR and commit.

### 5.6 Reference workflow code (illustrative)

```ts
export const followUp = defineSignal<[Msg]>('followUp');
export const confirm   = defineSignal('confirm');
export const setTarget = defineUpdate<boolean, [string]>('setTarget'); // validated
export const view      = defineQuery<TaskView>('view');

export async function softwareDev(task: TaskInput) {
  let stage = 'setup', target = task.target, confirmed = false;
  const msgs = [...task.msgs];

  setHandler(view, () => projectView(stage, msgs, target, allowed(stage)));
  setHandler(followUp, (m) => msgs.push(m));
  setHandler(confirm, () => { confirmed = true; });
  setHandler(setTarget, (b) =>
    (stage === 'do' || stage === 'review') ? (target = b, true) : false);

  await withResolve(() => stage, async () => {        // try/catch -> auto-resolve -> Resolve agent
    const world = await act.createWorld(task.base, project.copyGlobs);
    let session;
    for (stage = 'do' ;; ) {
      const turn = await act.runAgentTurn(profiles.do, world, msgs, session);
      session = turn.session;
      if (turn.subTasks)
        await Promise.all(turn.subTasks.map((s) => executeChild(softwareDev, { args: [s] })));
      if (turn.completed) {
        stage = 'review';
        await condition(() => confirmed || msgs.length > turn.seen);
        if (confirmed) break;                          // -> PR; else loop back to Do
      }
    }
    stage = 'pr';    if (project.remote === 'pr') await act.openPr(world, target);
    stage = 'merge'; await mergeQueue.acquire(target);
                     await act.runAgentTurn(profiles.merge, world, null, session);
                     await mergeQueue.release(target);
    stage = 'done';
  });
}
```

---

## 6. Resource coordinators (the lease pattern)

A scarce shared resource is owned by a **singleton coordinator workflow** with a well-known ID (Temporal enforces one running execution per ID, so the ID *is* the singleton). The coordinator holds the queue/capacity as explicit state and hands out **leases**.

### 6.1 Merge queue

- ID per serialization domain, almost always per target branch: `merge-queue:<repo>:<branch>`.
- A task wanting to merge does **signal-with-start** to enqueue, then `await(() => granted)`.
- The coordinator, when the slot is free, pops the head and signals it `granted`; the task runs its merge and signals `release`; the coordinator pops the next.
- Because the queue is explicit state: **reorder** = a `prioritize(taskId)` signal; **position** = a query; **N parallel slots** = the same code with the slot count raised (a counting semaphore).
- **Crash safety:** after granting, the coordinator awaits `release` *or* a lease-timeout; on timeout it checks the grantee's status and reclaims if it died.
- **continue-as-new:** the coordinator is long-lived and accumulates history (every enqueue/grant/release), so it must periodically continue-as-new, carrying the queue state forward.

### 6.1a Agent-turn queue (host capacity)

- One host-wide singleton, `agent-queue`, leases capacity only around model subprocesses; workflows waiting at Review, on accounts, timers, or I/O do not consume it.
- Capacity defaults to 3 and is persisted as **Organization settings → Host capacity → Concurrent agent turns**, explicitly labeled installation-wide. `KARMAX_MAX_ACT` remains a distinct worker-throughput limit for all activities, and per-login concurrency remains an account-pool limit.
- Waiting turns and active leases are explicit coordinator state. The coordinator contributes the reorderable **Agent queue** to the host-owned **Queues** page alongside the merge queue.
- The worker applies live free-memory/load gates after lease grant. Those adaptive safety checks are separate from the configured counting-semaphore capacity because only an activity can inspect live host resources.
- Current turns enroll by stable turn ID at the existing activity boundary, preserving replay compatibility for workflow histories recorded before this coordinator existed. Dead-task leases are reclaimed after a liveness check.

### 6.2 Token / account coordinator

Same pattern, leasing **agent-account capacity** instead of merge slots:

- Tracks each account's 5-hour and weekly windows and refresh times.
- Per agent turn, leases a config home (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`, §7) for an account with headroom.
- When the whole pool is exhausted, parks turns until a refresh timer fires.
- Resolve/auto-resolve consult it to decide when *not* to spawn agents and when to retry turns that failed on rate limits.

**Design note — the unification.** Merge slots, host agent-turn capacity, agent-account capacity, and (in v2) spend budgets are all the same coordinator-with-leases pattern at different scopes. External-resource brokering is not new machinery; it is this one primitive pointed at different pools.

---

## 7. Agents

### 7.1 Agent profile model

A declarative spec: `{ provider, model, effort, tools/mcp, promptTemplates, capabilities, resourceLimits, auth }`. A **provider adapter** translates the profile into the concrete invocation:

- **Claude** → Claude Agent SDK (same harness as Claude Code; session resume/fork; hooks; MCP).
- **Codex** → Codex app-server / SDK (structured items/turns/threads; approvals pause a turn; resumable threads).

`auth` references an **auth source**: either a subscription **config home** (a `CODEX_HOME`/`CLAUDE_CONFIG_DIR` directory) or an API-key **credential handle** (§8). Never a raw key inline.

### 7.2 The per-turn execution model

**The workflow is the long-lived (but cheap) thing; the agent runs one turn at a time inside an activity (expensive, but ephemeral).** `runAgentTurn`:

The task view reports the turn's resource boundaries separately: `waitingFor: account` while credential capacity is being leased, `waitingFor: agentSlot` / `agentTurn: waiting-slot` after the account grant while host admission is pending, and `agentTurn: running` only after the activity has acquired the host slot. The workflow publishes the post-grant transition immediately; it must not leave the last account-wait snapshot visible for the duration of a running turn.

1. Spins up / resumes the agent session (via session/thread ID stored in workflow state).
2. Lets the agent work until the provider emits a verified successful terminal event. Failed, interrupted, cancelled, truncated, or transport-ended terminal states throw even if partial text exists. Structured assistant errors (quota, authentication, billing, overload/server failure, output truncation) and provider-marked text-only API errors are classified before a later generic terminal result can erase their cause; recoverable infrastructure interruptions retry and resume the checkpointed provider session.
3. Captures output, events, and the new session ID; exits — the process dies, RAM is reclaimed.

Between turns — where all waits live — the agent is only a stored session ID. **RAM is consumed strictly during turns, never during waits**, regardless of whether a wait is five seconds or five hours. This is the fix for the naive "long-lived agent process" design that exhausts system resources.

**Yield only at turn boundaries.** Anything long the agent triggers (a 20-minute test suite, a build) becomes its own activity or child workflow so the agent's turn can end; a fresh turn resumes with the result. The agent never sits idle holding context.

### 7.3 Config homes under `~/.karmax`

karmax mints **one config home per (account × profile)** under `~/.karmax`, and injects the right `CODEX_HOME` / `CLAUDE_CONFIG_DIR` at process spawn. This is the official isolation mechanism for both tools and isolates auth, settings, sessions, MCP servers, and skills. Because these are environment variables read at process startup, they apply identically to the CLI, the app-server, and the SDK subprocess. The config home also carries browser MCP config (§7.5). Local CLI agents may load the platform MCP from it; remote Claude exposes the same handlers through its host SDK server, and remote Codex exposes them as app-server dynamic tools over the existing PTY. Consequently a cloud world never needs an inbound route to a locally hosted Karmax merely to use platform tools.

**Gotcha — scrub the environment for *login* isolation, not as a sandbox.** Spawn each agent with a **clean environment per spawn**: unset any inherited `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` so one account's key can't leak across profiles, and inject only the target profile's `CODEX_HOME`/`CLAUDE_CONFIG_DIR`. This mechanism isolates **logins** (auth, settings, sessions, MCP, skills) — it is deliberately **not** a filesystem or process sandbox. The agent still runs as the karmax user against the real home directory; *containing what an agent can read/write/execute is the **world's** job* (§11 — the default worktree is a trusted "runs on your machine" posture; the container/microVM providers are the real boundary), never the config home's. The one requirement this places on the config home: `CODEX_HOME`/`CLAUDE_CONFIG_DIR` must capture *all* account-scoped state, so two profiles sharing the real home cannot cross-contaminate logins. If a tool stashes account state outside its config dir, tighten that capture — do **not** reach for scrubbing the home directory, which conflates login isolation (this section) with sandboxing (§11).

### 7.4 Agent communication

- **Point-to-point** (supervisor follow-up to a sub-task at the review gate; a hotfix to one task) = **a signal to that task's workflow**, appended to the agent's next turn. No new machinery; it falls out of signals + the per-turn loop.
- **Fan-out** (a hotfix broadcast to all active tasks touching a file) = **a small workflow** that enumerates targets and signals each. Only orchestrated multi-target comms deserve to be a workflow.

### 7.5 Browser automation

Browser control is via MCP, so it works identically across CLI/app-server/SDK:

- **chrome-devtools-mcp** for inspection/debugging; **Playwright MCP** for full headless automation.
- Run **headless + isolated**, per task, torn down with the turn; cap concurrency.
- For logged-in sessions, use a dedicated `--user-data-dir` per account (Chrome blocks remote debugging on the default profile).
- Run the browser in a container with network policy for anything touching real credentials.

### 7.6 Autonomy (browser, accounts, payments)

The philosophy is maximal autonomy within bounded, auditable controls:

- **Registering / logging in:** never a plaintext password file. Use the credential broker (§8): the agent requests a scoped credential through the platform MCP, the broker injects it just-in-time at spawn, and newly-created accounts are written back to the vault. TOTP-capable brokers let agents complete MFA without a human; un-automatable bank step-up is surfaced as a human gate at the review stage.
- **Payments (v1):** a **virtual card per agent profile (or per task)** with a hard cap and merchant-lock (e.g. Stripe Issuing for programmatic/business use). Enforcement is at card-authorization level, so over-budget transactions are declined automatically. Spending above a configured threshold requires approval at the review gate. Model the budget as a lease (§6) so the rail can be swapped later. (Payment-protocol rails are v2; §13.)

---

## 8. Permissions and security

### 8.1 Capability model

A flat set of namespaced capabilities (`task:create`, `task:conversation:fork`, `project:settings:write`, `credential:write`, `merge-into:<repo>:<branch>`, ...). Principals are **humans, tasks, and system services**. Grants are scoped global/project; a token records its originating task for provenance but that id is not itself an object ACL. Project scope controls visibility across tasks, which lets an authorized agent discover and coordinate peer tasks without receiving global access.

Humans choose one of four job-shaped authorization profiles rather than a permission checklist: **Developer**, **Project maintainer**, **Automation operator**, and **Administrator**. Membership establishes scope; it is not a second role system. A hidden protected-owner marker exists solely to preserve one recovery principal and grants no separate authority. Profiles are configurable at organization scope with project overlays. See `PLAN-authorization.md` for the capability matrix.

### 8.2 Attenuation

An agent acts on behalf of the user/task that spawned it. Its **effective capabilities = intersection(role-profile ceiling, task authorization profile, granting principal's capabilities)**. The task stores that result and its grantor when it is created. Every workflow-spawned agent — retries, Resolve/Confirm/Merge roles, replacement runs, and children — derives from that stored grant, so retry topology cannot escalate privilege. If a requested profile exceeds the creator, it is capped and the task records `attenuated: true`; approval-based elevation may be added later without changing the token model.

### 8.3 Enforcement

- **The workflow mints the agent's credential** — it alone knows the task, the profile, and the granting user — issuing a scoped token when it spawns the agent.
- **The platform MCP server checks** each call's action against the token's effective capability set before executing.
- **The gateway checks the same mapping** before every human or agent HTTP operation, including routes implemented directly by host services (credentials, payments, processes, review actions, users, safe mode). Authentication is not authorization.
- **Human authentication is delegated to Better Auth** (password hashing, database sessions, HttpOnly cookies, rotation, rate limiting, account lifecycle). Karmax consumes only its verified user id and owns project/task policy.
- **The merge capability** (`merge-into:...`) is granted only to merge-agent profiles and authorized humans. Do agents get write to their own world/branch only, so every merge into a protected target (including workflow repos) is forced through the merge agent under the queue.
- **The most dangerous action — publishing workflow/infra changes — is gated not by a runtime check but by the PR-test-approve flow (§4.4).** That gate covers the real blast radius; a minimal capability check covers the rest.

### 8.4 Credential broker

Agents never see raw secrets in prompt/context. A vault-backed broker provides:

- **Just-in-time injection** at spawn into the isolated environment.
- **Scoping** to exactly what the task needs (not the user's full set).
- **Rotation** and short-lived credentials.
- **Full audit** of which agent requested what, when, why.

Agent profiles and workflow repos store **credential handles** (pointers), never raw keys — a key committed into an agent-editable, git-versioned workflow repo is a guaranteed leak.

### 8.5 Audit and policy administration

Profile edits, grants, revocations, defaults, and capability-checked gateway operations append to the durable audit log. The same administration is available to authorized agents through the platform MCP. Workflow/infra publication still requires both the runtime capability and the merge-only reviewed path: authorization permits proposing and reviewing an edit, never bypassing the protected merge queue.

---

## 9. Resilience: safe mode and defaults

**Defaults ship immutable and read-only with each release; customizations are versioned overlays that shadow them.** Resolution order is **project override → user override → bundled default**. Nothing is ever destroyed; "restore" is choosing which layer to resolve from, not a copy operation.

- **Global safe mode** boots fully vanilla (resolve with all overlays off) — the floor for "I can't even open the app." Because it is the normal resolver with overlays disabled, it is robust against its own bugs.
- **Per-workflow disable/fallback** drops a single misbehaving custom workflow to its default (or off) while the rest of the customization keeps working — the common case, analogous to disabling one extension rather than rebooting.
- **Roll back the overlay** to the last green generation (its git history) for surgical recovery.

**Safe mode must be a repair environment, not just a read-only fallback:** it must give you enough working system to fix the broken customization in place (run vanilla software-dev plus an agent to repair the custom workflow, or revert the overlay).

**Boundary (be precise about the guarantee):** safe mode reverts **code/behavior, not state**. Tasks, worlds, event histories, and config survive booting vanilla, but vanilla code cannot un-break an *in-flight* task of a broken custom workflow (it doesn't understand that instance's durable state shape) — let those drain or cancel. The guarantee is "the system stays operable and fixable," not "every running custom task is recovered."

**The one case safe mode does not cover: coordinators.** Their durable state outlives any code version, and safe mode swaps code, not state. A coordinator edit that corrupts its own continue-as-new payload cannot be fixed by booting vanilla code over corrupt state. Coordinators therefore still require tested state migrations and Temporal patching on the way in (§4.5). Rule: finite workflows edit freely (the floor catches mistakes); stateful coordinators demand care on the way in.

---

## 10. UI and the contribution system

### 10.1 The contribution system

The host implements a **protocol**, not a catalog of anticipated workflows — like a browser rendering any conforming page. A workflow package contributes typed, declared things into named **slots/extension points** on the host: task-detail panel, task-list item, task-list column, project-settings section, global-nav, queue panel (with the old merge-queue panel retained as an alias), review area, dashboard widget. Mounting is simple; the design work is keeping the **slot set small, stable, and versioned**, because contributions bind to it.

A **command/keymap registry** is the substrate for keyboard navigation: core and contributions register commands; every declared action is a command; keybindings are a view over the registry. The "extensive keyboard navigation system" is this registry, not a separate mechanism.

### 10.2 The rendering tiers (with a guaranteed floor)

Every workflow, however custom, exposes **typed structured state and typed declared actions**, so there is always a renderable floor. Tiers, from safest/most-consistent to most-expressive:

1. **Generic auto-render (floor)** — the view-model shown as structured display; each declared action auto-rendered as a form/button from its argument types. Works for *any* conforming workflow.
2. **Declarative composition** — compose host widgets (list, gauge, thread, diff, table).
3. **Mounted component** — a first-party / reviewed component in a slot.
4. **Sandboxed iframe** — untrusted/agent-authored UI (e.g. a rich review panel), in an iframe with a postMessage bridge to a capability-scoped client.

Trust determines the mounting mechanism (reviewed → mounted; untrusted/agent → sandboxed), not expressiveness. A custom component is only a prettier renderer over the same `query`/`signal`/`update` contract — it cannot invent new backend operations.

**Structured state is mandatory even when a custom renderer exists** — it is what keeps search, audit, automation, and the generic-fallback rendering working for every workflow. A workflow that shipped only a bespoke iframe and no structured state is forbidden by the protocol.

### 10.3 Core UI modules

The host shell and core modules are **first-party**, built on the same contribution system so extensions can **augment** them (add a task-list column, a settings section, a dashboard widget). v1 core modules:

- **Task list** — the primary surface (per project / task list).
- **Merge queue UI** — ordered queue, reorder, position, cancel.
- **Settings** — matching organization and project surfaces with a pane-per-section rail: the rail is real navigation (exactly one section visible at a time, the URL hash naming the open pane so deep links and background re-renders land on the same section), ordered Git & GitHub → Compute → Agent logins → Task defaults → Payments → People & authorization → Workflows → Advanced. Each section title carries a one-line plain-language purpose instead of decorative numbering, and saves confirm in place on the pressed button rather than via corner toasts naming wire ids. Agent logins are organization-owned; the project section links directly to that organization section and only edits project credential precedence. Shared task fields render once and are consumed by every workflow declaring them; dedicated workflow blocks contain only genuinely unique fields. Both settings surfaces present ONE agent for Do and Merge by default with a "Separate Do and Merge agent configurations" checkbox (the same unified shape as the task form and Quick defaults), and the Review route is edited beside those agents — there is no standing Confirm-agent profile in the UI; review agents are configured per layer in the route. Repository selection/creation belongs to the project that uses it, while project access belongs under People & authorization.
- **Inbox** — one full page opened from the top-bar attention icon; never a second sidebar destination or notification popover.

Human routing is specified in `PLAN-collaboration.md`. Karmax deliberately does
not reproduce issue-tracker assignee/delegate/reviewer/follower state. Each
workflow human wait declares the exact user/team/special audience for that step;
the per-user inbox is a materialized projection of those workflow events.
- **Wiki** — the organization and project wikis (§4.4): a tree of skills/memories with a rendered page view, a frontmatter-as-form editor (raw YAML behind a toggle, markdown preview), and an Index showing exactly what agents receive each turn: every unconditional entry in full, then the rendered table of contents (names + descriptions, importance order, [more…] folds). The project wiki is a project tab; the organization wiki is the bottom-left rail link.
- **Dashboard** — agent runs, token/limit status across accounts, resources used.
- **The final composed app UI** with the keyboard-navigation registry.

### 10.4 Parameter forms — the third declared contribution

Just as a workflow declares its events (§5), capabilities (§8), and UI slots (§10.1), it declares its **parameters**: a typed `params` schema in the manifest. This single declaration drives three surfaces, so there is exactly one source of truth and no per-surface guessing (the "declare, don't guess" rule, §0):

1. **The task form** — the expanded "new task" composer. The quick one-line composer stays for fast capture; an *expand* affordance reveals the full form rendered from the schema (e.g. for software-dev: a multi-line prompt textarea, an **agent field** per role, base/target branch, copy-globs, PR toggle, and workflow-owned Review route).
2. **The project-settings form** — shared task defaults plus workflow-unique fields at project scope. Repository sources render once as a repeatable datalist accepting connected GitHub SSH URLs or, when self-hosted, local paths.
3. **The organization-settings form** — the matching shared-default model at organization scope (the schema retains the historical `global` spelling on the wire). Shared values live in `__common__`; historical workflow rows remain compatible overlays.

**Field model.** Each parameter is a `FieldSpec`: `{ name, type, label, help?, required?, options?, default?, scopes, bind, role? }`.

- `type` ∈ `text | string | number | boolean | select | list | repoPath | branch | agent`. The `agent` type is a composite control (§10.5).
- `scopes` ⊆ `{ task, project, global }` — which surfaces the field appears on. A prompt is `task`-only; `repos` is `project`-only; base/target/profiles appear on all three.
- `bind` tells the host where a resolved value lands in the workflow input (`prompt | top | project | profile`), so the same generic assembler maps any workflow's fields into its `TaskInput` with no per-workflow code.

This generalizes the §10.2 declared-action argument descriptor — the same renderer draws action forms and parameter forms.
The `repos` declaration also tells Karmax that the workflow requires project
source code. Its wire shape remains a project-bound list for compatibility, but
the first-party UI edits the canonical project sources once: attached GitHub
repository records for hosted/cloud use, or local paths/SSH URLs for self-hosted
use. Karmax synchronizes historical per-workflow rows so they cannot override
that canonical set.

**Defaults resolution is the overlay model (§9).** A field's effective value is `task override → project setting → organization setting → field default`. Settings forms write to project and organization overlays; the task form reads resolved defaults and lets the user override per-task. Safe mode resolves field defaults only.

**Drafts.** The expanded task form can **save as draft** instead of queueing. A draft is a stored task record with its parameters but no started workflow; it can be edited and later **queued** (which starts the workflow with the stored params) or deleted. This makes the task form a first-class composition surface, not a fire-and-forget dialog.

### 10.5 The agent field (selecting and configuring an agent)

The `agent` field type is the reusable control for choosing the agent that runs a role — used both in the task form (per-role override) and in the project/global settings (per-role defaults). It collects an **AgentSpec**: `{ provider, model, effort?, resumeFrom? }`.

- **provider** ∈ `claude | codex` (and `mock` for tests). **model** is a provider-scoped list with a free-text escape (Claude: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`, …; Codex: `gpt-4.1`, …). **effort** ∈ `low | medium | high | xhigh | max` where the provider/model supports it.
- **resumeFrom** continues a prior agent session: either a **task search** picker (find a previous task; resume its stored session for that role) or a directly-entered **conversation/session id**. The chosen session is passed to `runAgentTurn` as the initial session (§7.2), so the agent continues with its prior context (forking, not mutating, the source).

The AgentSpec resolved per role flows into the workflow as `input.agents[role]`; `runAgentTurn` builds the effective agent profile from it (overriding the stored profile's provider/model/effort) and applies the resume session on the first turn. This keeps the agent's declarative profile model (§7.1) intact — the field is just the UI for assembling per-use overrides.

**Quick-task defaults.** Each scope has one **Different agents for Quick tasks?** switch. Off means quick tasks use the regular agent defaults. On enables one shared, agent-only `quick:` overlay; project Quick agent defaults inherit from the organization Quick agent defaults. Branches, Review route, remote policy, and other task defaults never diverge merely because the Quick composer was used.

Quick defaults are purely opt-in and inherit from the general defaults until a field is set, so the overlay stack for a quick task is (highest → lowest precedence):

```
agent task override → project-quick agent → global-quick agent → project-general agent → global-general agent → agent field default
```

Disabling a scope's Quick overlay removes it from this chain without deleting its values. Full-form tasks skip the Quick layers entirely.

### 10.6 URLs and task numbers — every view is bookmarkable

The console is a single-page app, but every page has its own **URL** so a specific task, project, settings page, or the dashboard can be bookmarked, shared, and reached with the browser's back/forward buttons. The URL — not an in-memory tab variable — is the single source of truth for *{active organization, active project, active tab, open task}*. The gateway already serves `index.html` for any non-asset path (the SPA fallback), so the client owns routing via the History API; a deep link like `/acme/web/tasks/42` loads the app and reconciles state to that URL on boot.

**The scheme (all host-owned).** Every page lives under its **organization's slug** — the tenant is the top path segment — so the org is always explicit in the URL and switching orgs re-homes the whole namespace. Projects are addressed by a **slug of their name**, not their opaque id, nested beneath their org, so a bookmark reads like `/acme/web/settings`:

```
/                                    → home (redirects into the current org)
/<org>                               → org home (redirects to a project or the dashboard)
/<org>/dashboard                     → organization dashboard
/<org>/settings                      → organization settings
/<org>/inbox                         → inbox
/<org>/wiki                          → organization wiki (bottom-left rail link)
/<org>/<project>                     → task list          (the primary surface)
/<org>/<project>/queue               → merge queue
/<org>/<project>/activity            → activity feed
/<org>/<project>/wiki                → project wiki (a project tab)
/<org>/<project>/settings            → project settings
/<org>/<project>/tasks/:num          → a task permalink (opens the drawer over its list)
/<org>/<project>/tasks/:num/:tab     → the task page pinned to one of its tabs
```

Organizations carry a persisted `slug` (falling back to a slug of the name for records that predate it). A small set of reserved second-segment words (`dashboard`, `settings`, `inbox`, `wiki`) name organization-level views rather than projects, so those never round-trip through a project slug; every other second segment is a project. Project slugs need only be unique **within their org** — the slug resolves to a project by matching the slugified name (case-insensitive), scoped to the URL's org; names are expected distinct, and on the rare collision the first-created project wins. Because the console loads the full org + project list at boot, org↔project↔slug resolution is entirely client-side — no round-trip to open a deep link. Pre-organization URLs (`/dashboard`, `/organization`, `/settings`, `/projects/:name/…`) are still parsed and then **canonicalised** (History `replaceState`) to the org-prefixed form, so old bookmarks and server-issued redirects keep working.

**Workflows do not own URLs.** This is the answer to "does a workflow own its page?": no. Every page is a first-party **core UI module** (§10.3) whose *route* is host-owned; a workflow only ever *augments* a host page through the declared contribution system (§10.1) — a slot, a widget, an action, a param field — never by claiming a path. The merge queue is the illustrative case: it looks "produced by a workflow," but it is a host route that *projects* the merge-queue **coordinator's** query state (`{queue, current}`, §6.1) joined with each task's `mergeQueue` position. The coordinator is queried; it does not render or route. The same holds for the dashboard (projects the account coordinator's query). Keeping routes host-owned means the URL space is finite, stable, and knowable without loading any workflow package.

**Task numbers (`num`).** Each queued task carries a simple, human-facing sequential id — numbered **per project**, so every project runs its own `#1`, `#2`, … assigned when the task is first queued, alongside the opaque `id`. A never-queued draft has no `num`; if queued work is later moved back to drafts, it retains its number and permalink. The **`id` never changes**: it is the Temporal `workflowId`, the event key, and the session key, so it must stay stable for replay and cross-task signalling. `num` is purely the human/URL handle: the UI shows `#num` everywhere a task is named (list rows, drawer header, merge queue, notifications, sub-task links), the permalink is `/<org>/<project>/tasks/:num`, and it is a search key — both the task search box and the "Fork a previous agent" picker match on `#num` as well as title. The store owns `num` (unique per `(projectId, num)`, with legacy queued work backfilled per project in creation order); the gateway resolves `(:projectId, :num) → id` (so a permalink to an archived/not-yet-loaded task still opens) and mirrors `num` onto the task view (the workflow only knows the opaque `id`).

---

## 11. Worlds

### 11.1 The world provider interface

A world is accessed through a small interface so the backend is swappable without touching workflows:

```
create()/open()             # provision or reconnect from a durable handle
exec()/startProcess()       # bounded commands and streaming executions
read/write/list files       # provider-confined filesystem operations
openPty()                   # interactive terminal (powers cheap check-in)
fetchPort()                 # authenticated service preview via the gateway
park()/status()             # sleep inactive compute and inspect lifecycle
destroy()
```

`createWorld` dispatches to the configured provider. The workflow talks only to this interface, so local-worktree → container → remote sandbox changes nothing upstream.

Pool, resources, network posture, organization cloud budget, and parked-world
retention form one organization **compute** policy (Settings → Compute). Projects
inherit it; their sparse override is limited to a pool exception and a tighter
project budget. The **provider choice itself is a different axis** — the *agent
environment* (worktree / container / E2B / Daytona). It is a **task default**
(§10.4), edited beside the base/target branches, so it inherits organization →
project → task like any other field and a single task can pick a different
environment without a project-wide change (it binds to `input.project.worldProvider`,
which every world-creating workflow reads). Its canonical value still lives in the
execution policy, so runner-pool compatibility and the effective-config merge stay
coherent; the Compute section shows the effective environment read-only and scopes
its pool list to it. Provider-specific template/snapshot/image settings stay on
that provider connection. General coding defaults to unrestricted outbound
internet; a domain/CIDR allowlist is an explicit enterprise hardening mode.

When a self-hosted project stores a local repository path but selects a remote
world provider, `createWorld` resolves the repository's existing `origin` (or
sole remote) and normalizes ordinary HTTP(S) git URLs to SSH. The local path is
not sent to the provider. A GitHub App is optional for this path; it exists for
hosted repository discovery/creation, webhooks, and repository-scoped keys.
GitHub App manifests include a webhook only when Karmax is on a publicly
reachable HTTPS origin. Local/private instances reconcile repository access on
demand; installation lifecycle events are received automatically and are never
listed as manifest subscriptions.

**Multi-repo worlds.** A project may configure several `repos`; a task's world then checks out **one worktree per repo**, each on the same `karmax/<taskId>` branch off its own base. A single repo keeps the flat layout (the world root *is* the worktree); with several, the world root is a parent directory holding one subdirectory per repo (named after it, deduped on collision), so the agent sees `frontend/`, `backend/`, … side by side and works across them. The finalize-merge lands the branch in **every** repo, stopping at the first conflict for the merge agent to resolve — a re-run re-merges already-landed repos as no-ops (partial-merge recoverable, not atomic). The world handle carries the full `repos[]`; older single-repo handles are read through a compatibility shim (`worldRepos`).

For the local worktree provider, a configured network Git URL is materialized
once as a Karmax-managed local checkout under the worlds data directory; task
worktrees branch from that checkout exactly as they do from a user-supplied
local path. The handle retains the configured URL separately for repository
enrollment and checkpoint identity. Clone credentials are ephemeral (a selected
GitHub repository's read-only deploy key, then a Git profile, then host Git/SSH)
and are never written into the checkout or durable handle.

A multi-repo task must serialize against *every* repo it touches, not just one — so it takes a slot in the merge queue (§6.1) of **each** repo. To keep concurrent multi-repo merges deadlock-free, slots are acquired by **ordered acquisition** (lock ordering): the task's repos are sorted into one global order and their slots claimed one at a time in that order, holding each while it waits for the next. Because all tasks request shared repos in the same order, a task only ever waits on a repo ordered *after* everything it already holds, so the wait-for graph is acyclic and the classic three-task cycle (A&B, A&C, B&C) cannot deadlock. Slots are released after the finalize-merge (and on cancel/abort); an orphaned lease is reclaimed by the coordinator's liveness check.

### 11.2 Backends

- **Local (default):** git worktree; or a local container / devcontainer for isolation on the host.
- **Sandboxed/remote (pluggable):** a managed microVM/container provider behind
  the same provider contract. The first target is E2B; Daytona is the second
  conformance implementation; Modal is reserved for GPU/special workloads.
- **Remote dev env / your own infra:** an outbound-connected Karmax runner pool
  on a local machine, customer VPC, or (later) Kubernetes/Kata fleet.

The hosted design deliberately distinguishes an immutable project **Environment**
(what runs), a **Runner pool** (where it runs), a per-attempt **World** (mutable
workspace), and an ephemeral **Execution** (agent/command/PTY/service). A logical
world belongs to one attempt, but it does not keep one VM running: compute is
leased only while an execution is active. See `PLAN-cloud.md` for provider
selection, pricing, lifecycle, GitHub/SSH, runner, and multi-tenant design.

### 11.3 Ties to the rest of the spec

- The provider **PTY** powers the "open a terminal in the world" check-in against remote worlds.
- Provider **park/open** powers resume-while-parked: when a workflow waits on a
  human, the provider pauses compute while retaining the filesystem, and the
  next provider operation reconnects and resumes it. E2B's inactivity timeout
  is a second backstop if an explicit park is missed.
- Provider lifecycle state is projected through workflow events; webhook-driven
  failure signals are a future contract extension, not required for the first
  hosted backend.
- A provider's secure credential injection feeds scoped secrets (§8) into a world without putting them in the agent's context.

**Implemented scope:** local worktrees, local Docker containers, E2B, and Daytona
all implement the same execution contract. Remote worlds park while a task waits,
resume on demand, proxy HTTP/WebSocket previews through the authenticated gateway,
checkpoint portably, and return Git changes through the host-side broker without
retaining write credentials after provisioning. Organization-scoped runner pools,
capacity/budget leases, usage attribution, portable restore, and generation fencing
complete the managed-runner baseline described in `PLAN-cloud.md`.

---

## 12. Remote access (phone / off-laptop)

For a self-hosted/local installation, karmax serves its web UI on localhost; a
mesh or tunnel makes it reachable. This is purely an access layer, orthogonal to
the core. Karmax Cloud instead serves the authenticated gateway directly; its
control/execution split is specified in `PLAN-cloud.md`.

The gateway binds to loopback by default. A hosted deployment sets
`KARMAX_HOST=0.0.0.0` behind a TLS reverse proxy and
`KARMAX_PUBLIC_URL=https://karmax.example.com`. Browser/auth URLs use the public
origin, while agent/MCP service traffic remains on the loopback control-plane
URL and never hairpins through the public proxy.

- **Default (private, just you):** **Tailscale** — phone joins the tailnet and reaches the laptop directly; use **Tailscale Serve** for a private `https://*.ts.net` URL (HTTPS is required for some phone-browser features). Nothing is exposed publicly.
- **Public URL with auth (business / multiple people):** the hosted cell image
  behind Caddy or a managed TLS load balancer, with Karmax identity/authorization
  always enabled; an edge access proxy/WAF is optional defense in depth.
- **Quick one-off:** ngrok (random URL; demos only).

**Non-negotiable:** never put a naked public tunnel in front of karmax — it can move money and drive agents. Keep it private behind Tailscale, or public only behind Cloudflare Access, **and** give karmax its own auth regardless (defense in depth).

---

## 13. Evolved and deferred features

Features in this section began as post-v1 seams. Each subsection says whether it
has since landed; the remaining items are still deferred.

### 13.1 Multiple attempts (implemented)

A **task** is the intent; it owns one or more **attempts** — mutually exclusive alternate executions, of which at most one may commit. Attempts can be assigned up front or added at any time before commitment, including when every earlier attempt is cancelled. Attempts requested in the original creation form are materialized before execution and queued together. An attempt added later copies a chosen sibling's parameters into an editable draft and never starts implicitly, leaving the user free to change it before queueing.

Mechanism (reuses existing primitives, no new machinery):

- Each attempt is its own pinned Temporal execution and world, linked by a durable intent id. It may later be **forked** from a sibling's starting point; ordinary creation currently starts from copied parameters and a fresh world.
- The intent holds a compare-and-set **winner lease of size 1**. Entry into Merge is the logical commitment boundary: the attempt must claim this lease before it can enqueue for a branch merge slot. The merge commit remains the physical point of no return. Claiming earlier than the commit closes the double-merge race.
- A successful claim makes that attempt principal and immediately signals every running sibling to cancel; unqueued sibling drafts are marked superseded directly. The committed lease is monotonic, so no later attempt can be created or queued even if the eventual merge fails.
- Cancelled and superseded attempts are historical records, never silently deleted.
- The task list contains one row per intent. The detail panel shows the attempts as a compact selectable stack; clicking any row switches the whole panel to that attempt, and both the row and header identify the current attempt. The initial attempt stays principal while eligible; if it is cancelled or fails, the earliest remaining eligible attempt becomes principal. A committed attempt always becomes principal.
- The confirmer is intent-scoped and snapshotted once. Every attempt uses the same human/auto/agent configuration. For an agent confirmer, all review requests enter one serialized, intent-scoped conversation (a durable shared transcript replayed into fresh provider sessions, so account-home rotation cannot split it).

Invariants: dependents bind to the **task**, never to an attempt; at most one attempt can enter the irreversible path; a task has exactly one principal pointer; changing which attempt is principal never changes the task's number or intent identity; and confirmer identity never varies between attempts. This is the lease pattern at a third scope.

### 13.2 Other deferred items

- Approval-based privilege elevation and fine-grained per-field/data-row policy beyond global/project scope.
- A workflow **distribution/marketplace**.
- **Broadcast agent comms** beyond the implemented simple fan-out.
- **Agentic payment protocols** (e.g. mandate-based / tokenized agent payment rails) layered behind the v1 budget-lease abstraction.
- Additional world providers and richer dashboard analytics.

---

## 14. v1 build checklist

- [x] Temporal cluster + worker scaffold; deterministic workflow / activity split.
- [x] Gateway (HTTP → signal/query/update) + the platform MCP server with scoped-token checks.
- [x] Projects, task lists, tasks; the task view-model contract.
- [x] Workflow package format (manifest, repo layout, `requires`, `onActivate`); version-pinning per execution.
- [x] Workflows: software-dev, just-do, script-exec, goal, merge-only; merge-queue and token/account coordinators (lease pattern + continue-as-new + crash-safe leases).
- [x] Per-turn agent loop with session resume; provider adapters for Claude and Codex; per-(account×profile) config homes with scrubbed env.
- [x] Capability model + attenuation + workflow-minted scoped tokens; PR-test-approve gate via merge-only.
- [x] Credential broker (vault-backed, JIT, scoped, audited); credential handles only.
- [x] Contribution system: slots, declared event schemas, command/keymap registry; the generic auto-render floor + declarative tier + sandboxed-iframe escape hatch.
- [x] Core UI: task list, merge-queue UI, settings (incl. per-workflow project UI), user/notifications, dashboard, keyboard navigation.
- [x] World provider interface + local-worktree + one container provider; cheap PTY check-in + transcript view.
- [x] Immutable defaults + overlay resolution + global safe mode + per-workflow fallback.
- [x] Remote access via Tailscale (default) / Cloudflare Tunnel + Access; karmax's own auth.
- [x] Virtual-card budget per profile/task with hard cap + review-gate threshold.

---

## 15. Glossary

- **World** — the environment a task's work happens in (worktree/container/sandbox).
- **Review stage** — the gate where the confirm layers (each a human or a Confirm agent; the parent, for sub-tasks) approve in order or send a follow-up. (Formerly "Confirm.")
- **Point of no return** — the merge commit; cancellation is impossible after it.
- **Lease** — a grant of a scarce resource handed out by a coordinator (merge slot, account capacity, budget).
- **View-model** — the structured, typed projection of a task's (or coordinator's) state and allowed actions that the UI renders.
- **Config home** — a `CODEX_HOME` / `CLAUDE_CONFIG_DIR` directory isolating one agent account's auth/settings/sessions/MCP.
- **Credential handle** — a pointer into the credential broker; resolved to a live secret only at spawn.
- **Substitute** (v2) — one of several mutually-exclusive alternate executions of the same task.
