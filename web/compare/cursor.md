# tavya vs Cursor cloud agents

How tavya differs from Cursor's cloud agents and automations, as of November 2026, and when to choose which.

## What Cursor cloud agents are

Cursor's cloud agents "run in isolated VMs in the cloud with full development environments", each with a desktop, and return pull requests with screenshots and video. Automations start them from schedules, webhooks, GitHub, Slack, Linear and PagerDuty. Bugbot reviews pull requests. The agent is Cursor's own and can use models from Anthropic, OpenAI, Google and others. Cloud agents come with the Premium plan, $30 a month, and up.

## What is the same

A cloud computer per task, parallel sub-agents, a coordinator, schedules and events, apps through MCP, encrypted secrets, review before a change lands, and self-hosted machines for the work.

## Where Cursor is ahead

- **The editor.** If you write code in Cursor, its cloud agents are one click away and share its context.
- **Git hosts**: GitHub, GitLab, Azure DevOps and Bitbucket Cloud. tavya works with GitHub, or hosts repositories itself.
- **An iOS app.**

## Where tavya is ahead

- **Your choice of agent.** A task runs Claude Code, Codex or OpenCode as their makers ship them, on your own Claude or ChatGPT plan or API key. Cursor's agent is its own, and its third-party models are billed at API list price from its plan.
- **Reviewers you choose.** Each review step is a person or an agent on any vendor's model, and an agent can answer the working agent's questions in your place ([Let one agent review another](/docs/agent-review)). Cursor's reviewer is Bugbot, and its approval agent approves pull requests it rates low-risk.
- **Tasks that wait for other tasks.** A task can start when another lands, a parent reviews its sub-tasks, and approved changes land through a merge queue ([Schedule tasks and react to events](/docs/scheduled-tasks)). A Cursor agent can wait for a pull request, a check or a timer, not for another task.
- **Projects that run themselves.** In a fully autonomous project, agents answer, review, approve and land each other's work within a budget, and a permanent co-ordinator creates the tasks.
- **Logins, passwords, a mailbox and a wallet.** Agents get saved browser sessions, a password vault they fill from without seeing, an address for mail and a card with a budget per task ([Give an agent a card with a budget](/docs/agent-payments)). In Cursor a site's password is a secret the agent reads as a variable.
- **Data in versions.** Datasets and databases are kept in versions beside the code, and `.env` and credential files are written back at their paths ([Files Git ignores](/docs/ignored-files)).
- **Not only code, and no editor needed.** Papers, websites, video and errands are tasks like any other; people who do not code can write a task and review its result.
- **Open source**, under the GNU AGPL-3.0.

## Which to choose

Choose Cursor's cloud agents if Cursor is where you work and the job is code. Choose tavya to run Claude Code and Codex themselves on the plans you already have, to hand whole projects to agents, or for work beyond code.

## Sources

- [Cursor cloud agents](https://cursor.com/docs/cloud-agent), [Automations](https://cursor.com/docs/cloud-agent/automations), [Bugbot](https://cursor.com/docs/bugbot), [Models and pricing](https://cursor.com/docs/models-and-pricing), [Approval agents](https://cursor.com/docs/approval-agents), [Setup](https://cursor.com/docs/cloud-agent/setup), [Subagents](https://cursor.com/docs/subagents)
- [Cursor pricing](https://cursor.com/pricing)
