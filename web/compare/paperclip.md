# tavya vs Paperclip

How tavya differs from Paperclip, the open-source orchestrator for teams of AI agents, as of November 2026, and when to choose which.

## What Paperclip is

"Open-source orchestration for teams of AI agents": a self-hosted control plane with an org chart of agents, budgets per agent, and review and approval stages. It drives the agent programs you install (Claude Code, Codex, Cursor, Gemini CLI, OpenCode and others), on your machine by default or in a sandbox provider you connect. It is MIT licensed and free; a hosted Paperclip Cloud has a waitlist.

## What is the same

Both are open source and put several vendors' agents in one place. Both have tasks that depend on other tasks, delegation from one agent to others, schedules and webhooks, agents as reviewers, and results that are not code.

## Where Paperclip is ahead

- **Licence.** MIT, where tavya is AGPL-3.0.
- **More agent programs**: Cursor, Gemini CLI, Pi, Hermes and others beside Claude Code, Codex and OpenCode.
- **The company picture.** An org chart, roles and budgets per agent are its centre.
- **Community.** A large open-source following.

## Where tavya is different

- **Hosted, with a computer for every task.** Sign up and a task has its own cloud computer with your repositories, data and secrets; nothing to install or keep running. Or connect your own E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud account ([Cloud computers](/docs/computers)).
- **Agents that can act for you.** A vault of logins they can use without seeing them, saved browser sessions, an inbox, and a card with a budget per task ([Give an agent a card with a budget](/docs/agent-payments)). Paperclip's budgets cap what agents spend on models.
- **Review of real work.** A task's result arrives as a pull request or files with a live preview, and lands through a merge queue when its review route approves.
- **One permission system for people and agents.** An agent never has more access than the person who started its task.
- **The whole project comes along**: repositories, large data with versions, and the files Git ignores ([Files Git ignores](/docs/ignored-files)).

## Which to choose

Choose Paperclip if you want an MIT-licensed control plane on your own machine and will supply the computers and agent programs yourself. Choose tavya if you want that orchestration hosted, with a cloud computer, accounts and a budget ready for every task. tavya can also be [hosted yourself](/docs/self-hosting).

## Sources

- [Paperclip on GitHub](https://github.com/paperclipai/paperclip), [paperclip.ing](https://paperclip.ing)
- [Adapters](https://docs.paperclip.ing/reference/adapters/overview/), [Execution policy](https://docs.paperclip.ing/guides/power/execution-policy/)
