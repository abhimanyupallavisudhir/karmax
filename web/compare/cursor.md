# tavya vs Cursor cloud agents

How tavya differs from Cursor's cloud agents and automations, as of November 2026, and when to choose which.

## What Cursor cloud agents are

Cursor's cloud agents "run in isolated VMs in the cloud with full development environments", each with a desktop, and return pull requests with screenshots and video. Automations start them from schedules, webhooks, GitHub, Slack, Linear and PagerDuty. Bugbot reviews pull requests. The agent is Cursor's own and can use models from Anthropic, OpenAI, Google and others. Cloud agents come with the Premium plan, $30 a month, and up.

## What is the same

A cloud computer per task, parallel sub-agents, schedules and events, encrypted secrets, review before a change lands, and self-hosted machines for the work.

## Where Cursor is ahead

- **The editor.** If you write code in Cursor, its cloud agents are one click away and share its context.
- **Git hosts**: GitHub, GitLab, Azure DevOps and Bitbucket Cloud. tavya works with GitHub, or hosts repositories itself.
- **An iOS app.**

## Where tavya is different

- **Your choice of agent.** A task runs Claude Code, Codex or OpenCode as their makers ship them, on your own Claude or ChatGPT plan or API key, and one can review another ([Let one agent review another](/docs/agent-review)). Cursor's third-party models are billed at API list price from its own plan.
- **No editor needed.** tavya is a task list: write the task, review the result. People who do not code can use it.
- **A card with a budget, logins and an inbox** for agents ([Give an agent a card with a budget](/docs/agent-payments)).
- **Not only code.** Papers, websites, video and errands are tasks like any other.
- **Tasks that wait for other tasks**, and projects where agents answer and review.
- **Open source**, under the GNU AGPL-3.0.

## Which to choose

Choose Cursor's cloud agents if Cursor is where you work and the job is code. Choose tavya to run Claude Code and Codex themselves on the plans you already have, to hand whole projects to agents, or for work beyond code.

## Sources

- [Cursor cloud agents](https://cursor.com/docs/cloud-agent), [Automations](https://cursor.com/docs/cloud-agent/automations), [Bugbot](https://cursor.com/docs/bugbot), [Models and pricing](https://cursor.com/docs/models-and-pricing)
- [Cursor pricing](https://cursor.com/pricing)
