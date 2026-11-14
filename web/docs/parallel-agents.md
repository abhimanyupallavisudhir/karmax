# Run many agents in parallel

Run multiple Claude Code, Codex or OpenCode agents in parallel with tavya: one task per agent, each on its own cloud computer and branch, so they cannot collide.

## Why they cannot collide

Each task runs in its own world: a cloud computer with its own copy of the project's repositories, working on its own branch. Agents share nothing while they work. Their changes meet only when they land, one at a time.

## Start several

**Several tasks.** Press **New task** (or **N**), say what you want, and press **Ctrl+Enter** (**⌘+Enter** on a Mac). Do it again for the next one; each starts at once. From a project's folder, the [tavya CLI](/docs/cli) does the same:

```
tavya task new "Fix the login bug"
tavya task new "Add rate limiting to the API"
tavya task list
```

**Several attempts at one task.** In the task form's side column, set **Attempts** (1 to 8). The same task then runs that many times, each attempt on its own computer. When you confirm one at Review, tavya asks **Keep or cancel other attempts?** On a task's page, **＋ New attempt** adds another later, as a draft you can edit first.

**Sub-tasks.** An agent can split its own task into sub-tasks, each with its own agent. Ask for it in the prompt, for example "Split this into sub-tasks, one per package." A sub-task uses its parent's model and computer size unless the agent chooses others. Its work lands on the parent's branch, the parent's agent reviews it, and you review the parent once. The task's page lists them under **Sub-tasks**.

## What limits how many run at once

- **Your plan.** "Agents at once" is how many can work at the same time; more wait in line. See [Pricing](/pricing).
- **Model logins.** A Claude or ChatGPT subscription has usage windows. When every login is busy or out of quota, a task says so, for example **Waiting for a free Claude login** or **Waiting for Claude quota**. Add more accounts under **Settings → Agents**; tasks use the first available one.
- **Computers.** With the provider on **Any**, a full account gives way to the next, and a task waits only when all are full. Your own cloud account has its provider's limits ([Cloud computers](/docs/computers)).

The project's **Queues** tab shows **Agent work**: the agents running now, then the waiting work in the order it will start, higher priority first. Drag a row to change the order. A task that says **Held for higher-priority work** has a **Run now** button.

## How results come back

Each task stops at **Review** on its own. The **For me** view of the task list shows the tasks that wait for you. Read the changes, then **Confirm**, or reply with what to change.

Confirmed tasks move to **Landing**. Their changes merge one at a time through the **Merge queue** on the **Queues** tab, in an order you can drag.

## Mix models

The model is chosen per task, in the model field under **Agent** in the task form. One task can run Claude Code, the next Codex, a third an open model through OpenCode. **Settings → Task defaults** sets what new tasks start with.

## Next

- [Let one agent review another](/docs/agent-review): a second model checks each result.
- [Schedule tasks and react to events](/docs/scheduled-tasks): start work without pressing a button.
- [Cloud computers](/docs/computers): sizes, providers and your own account.
