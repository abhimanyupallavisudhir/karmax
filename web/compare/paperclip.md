# tavya vs Paperclip

How tavya differs from Paperclip, the open-source orchestrator for teams of AI agents, as of November 2026, and when to choose which.

## What Paperclip is

"Open-source orchestration for teams of AI agents": a self-hosted control plane with an org chart of agents, budgets per agent, and review and approval stages. It drives the agent programs you install (Claude Code, Codex, Cursor, Gemini CLI, OpenCode and others), on your machine by default or in a sandbox provider you connect. It is MIT licensed and free; a hosted Paperclip Cloud has a waitlist.

## What is the same

Both are open source and put several vendors' agents in one place. Both have tasks that wait for other tasks, delegation from one agent to others, schedules and webhooks, review steps that are a person or an agent, connections to other apps, secrets, and results that are not code. Both can run a project with agents in charge.

## Where Paperclip is ahead

- **Licence.** MIT, where tavya is AGPL-3.0.
- **More agent programs**: Cursor, Gemini CLI, Pi, Hermes and others beside Claude Code, Codex and OpenCode.
- **More connectors**: a catalogue of about 85 services.
- **The company picture.** An org chart, roles and budgets per agent are its centre.
- **Community.** A large open-source following.

## Where tavya is ahead

- **Hosted, with a computer for every task.** Sign up and a task has its own cloud computer with your repositories, data and secrets; nothing to install or keep running. Or connect your own E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud account ([Cloud computers](/docs/computers)). Paperclip runs on your machine by default.
- **A wallet.** Agents pay from a card with a budget per task; anything above it waits for your approval ([Give an agent a card with a budget](/docs/agent-payments)). Paperclip's budgets cap what agents spend on models: "Paperclip does not auto-detect 'this code is about to spend money.'"
- **Logins, passwords and a mailbox built in.** Saved browser sessions, a password vault agents fill from without seeing, and an address for mail come with every organization. Paperclip reaches saved logins and an agent mailbox through accounts you bring at Browser Use Cloud and AgentMail.
- **Work that lands.** A task's result arrives as a pull request or files with a live preview, and lands through a merge queue when its review route approves. Paperclip "does not push them to a remote git host on your behalf".
- **The whole project comes along.** `.env` and credential files are written back for every task, and datasets and databases are kept in versions ([Files Git ignores](/docs/ignored-files)). Paperclip leaves `.env` files out of an isolated workspace, for your own command to recreate.
- **One permission system for people and agents.** An agent never has more access than the person who started its task.

## Which to choose

Choose Paperclip if you want an MIT-licensed control plane on your own machine and will supply the computers and agent programs yourself. Choose tavya if you want that orchestration hosted, with a cloud computer, accounts and a budget ready for every task. tavya can also be [hosted yourself](/docs/self-hosting).

## Sources

- [Paperclip on GitHub](https://github.com/paperclipai/paperclip), [paperclip.ing](https://paperclip.ing)
- [Adapters](https://docs.paperclip.ing/reference/adapters/overview/), [Execution policy](https://docs.paperclip.ing/guides/power/execution-policy/), [Workspaces](https://docs.paperclip.ing/guides/projects-workflow/workspaces/), [Requiring approval before spend](https://docs.paperclip.ing/how-to/require-board-approval-before-spend/), [Connectors](https://docs.paperclip.ing/connectors/)
