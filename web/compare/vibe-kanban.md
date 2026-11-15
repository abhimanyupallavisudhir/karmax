# tavya as a Vibe Kanban alternative

Vibe Kanban is sunsetting and continues as a community-maintained, local project. How tavya compares for people who used it to run Claude Code, Codex and other coding agents from a board, as of November 2026.

## What happened to Vibe Kanban

On 10 April 2026 its makers wrote: "Vibe Kanban is sunsetting. The project will continue as open source and community maintained." Its remote services stayed up for 30 days, "after which Vibe Kanban will transition to a fully local architecture". The code is on GitHub under Apache-2.0.

Vibe Kanban is a board over coding agents: each card gets a workspace on your machine, you review the diff with inline comments that go back to the agent, and open a pull request.

## What carries over

- **A list of tasks, one agent each.** tavya's task list has the same shape: write a task, an agent does it on its own branch, you review.
- **Several vendors' agents**: Claude Code, Codex and any model through OpenCode.
- **Review, then a pull request**: read the changes, reply with what to change, confirm to merge.
- **Open source.** tavya is under the GNU AGPL-3.0.

## What is different

- **The agents run in the cloud.** Each task has its own cloud computer, so tasks keep working when your laptop is closed and you can answer from your phone. Vibe Kanban's workspaces are on your machine.
- **Sub-tasks, schedules and events.** A task can split itself, wait for another task, or run when something happens ([Schedule tasks and react to events](/docs/scheduled-tasks)).
- **An agent can review.** Any review step can be another agent, on another vendor's model ([Let one agent review another](/docs/agent-review)).
- **Not a board.** tavya is a list with stages (Working, Review, Landing) and no columns to drag.
- **Fewer agent programs.** Vibe Kanban also drives Gemini CLI, Copilot, Amp and Cursor.
- **It costs money to run in the cloud.** There is a free plan and a free trial of compute; local Vibe Kanban is free ([Pricing](/pricing)). Or [host tavya yourself](/docs/self-hosting).

## Moving over

Bring a project with the [tavya CLI](/docs/cli): `tavya import` in its folder takes the repositories and the files Git ignores. Then [Run many agents in parallel](/docs/parallel-agents).

## Sources

- [Vibe Kanban's shutdown announcement](https://www.vibekanban.com/blog/shutdown)
- [Vibe Kanban on GitHub](https://github.com/BloopAI/vibe-kanban)
