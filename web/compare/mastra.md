# tavya vs Mastra Factory

How tavya differs from Mastra Factory, Mastra's open-source software factory, as of November 2026, and when to choose which.

## What Mastra Factory is

"Mastra Factory is an open source, agent-powered software delivery environment": issues from GitHub, GitLab, Linear, Jira or incident.io land on a work board and move through triage, planning, building and review to a pull request. Each session runs Mastra's own coding agent, Mastra Code, with models from several vendors, in an isolated sandbox (Mastra's platform, E2B or another provider). Rules start work when an issue arrives or a card moves, and each stage can start or approve on its own. It has been in beta since September 2026. The template is Apache-2.0; you host it yourself or on Mastra's platform, whose plans start free.

## What is the same

A sandbox per session, models from several vendors, work started by events, an agent review before a person decides, side sessions that report back to the one that started them, encrypted environment variables, and the choice of hosting it yourself.

## Where Mastra Factory is ahead

- **A board for engineering intake.** Issues from Linear, Jira, GitLab and incident.io arrive as cards with rules you write per stage.
- **Built to be changed in code.** Factory is a Mastra application: teams reshape its stages, agents and tools in TypeScript, and Mastra co-builds custom factories.
- **GitLab** beside GitHub. tavya works with GitHub, or hosts repositories itself.
- **A more permissive licence**: Apache-2.0, where tavya is AGPL-3.0.

## Where tavya is ahead

- **Your choice of agent.** A task runs Claude Code, Codex or OpenCode as their makers ship them, on your own plan or API key. Factory runs Mastra Code.
- **Reviewers you choose, and agents that land the work.** Each review step is a person or an agent on any vendor's model, and an agent can answer the working agent's questions in your place ([Let one agent review another](/docs/agent-review)). In Factory an agent reviews, then you "make the merge decision through your repository's normal human review process".
- **Tasks that wait for other tasks.** A task can start when another lands, a parent reviews its sub-tasks, and approved changes land through a merge queue ([Schedule tasks and react to events](/docs/scheduled-tasks)). In Factory, "parent issues and sub-issues aren't modeled".
- **Projects that run themselves.** In a fully autonomous project, agents answer, review, approve and land each other's work within a budget, and a permanent co-ordinator creates the tasks. Factory's stages can start and approve on their own, but a person merges.
- **Logins, passwords, a mailbox and a wallet.** Agents get saved browser sessions, a password vault they fill from without seeing, an address for mail and a card with a budget per task ([Give an agent a card with a budget](/docs/agent-payments)). Factory's documentation describes environment variables and its issue-tracker connections.
- **The whole project comes along.** `.env` and credential files are written back at their paths, and datasets and databases are kept in versions beside the code ([Files Git ignores](/docs/ignored-files)).
- **Not only code.** Papers, websites, video and errands are tasks like any other; a task needs no repository. Factory needs a repository and targets software delivery.
- **Hosted, ready to use.** Sign up and write a task; there is no server to deploy.

## Which to choose

Choose Mastra Factory for an engineering team that wants an issue-to-pull-request pipeline it can reshape in TypeScript, on GitHub or GitLab. Choose tavya to run Claude Code and Codex themselves, to have agents review and land each other's work, or for work that needs accounts, money or no repository at all.

## Sources

- [Mastra Factory](https://mastra.ai/factory), [What is Factory](https://factory.mastra.ai/what-is-factory), [Sandboxes](https://factory.mastra.ai/configure/sandboxes), [Boards and rules](https://factory.mastra.ai/configure/boards-and-rules), [Reviews](https://factory.mastra.ai/using/reviews), [Work and approvals](https://factory.mastra.ai/using/work-and-approvals), [Intake](https://factory.mastra.ai/using/intake)
- [Announcing Mastra Factory in beta](https://mastra.ai/blog/announcing-mastra-factory-beta), [the template's licence](https://github.com/mastra-ai/softwarefactory-template), [Mastra pricing](https://mastra.ai/pricing)
