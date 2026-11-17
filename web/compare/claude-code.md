# tavya vs Claude Code on the web

How tavya differs from Anthropic's own cloud agents (Claude Code on the web, Projects and cloud scheduled tasks), as of November 2026, and when to choose which.

## What Claude Code on the web is

Anthropic runs Claude Code for you: "a Claude Code session that runs on cloud infrastructure instead of on your machine". **Projects** (public beta on Pro, Max and Ultra) is one conversation in which Claude starts a parallel cloud session for each task. **Scheduled tasks** (research preview) run on a schedule, an API call or a GitHub event. Cloud sessions count toward your plan's usage, with "no separate charge for the cloud VM". Plans start at $20 a month.

## What is the same

Each task gets its own cloud computer and keeps working when your laptop is closed. Several run in parallel. Work can start on a schedule or an event. Results come back as pull requests or files, and both do work that is not code: a Claude Project needs no repository either. Both connect apps through MCP, keep secrets, and have a coordinator that hands work out.

## Where Claude Code on the web is ahead

- **Price.** It is part of a Claude plan you may already pay for.
- **Apps.** The Claude apps for iOS and Android have a Code tab.
- **One vendor to deal with**, with Anthropic's support behind it.
- **Your own network.** Team and Enterprise plans can run sessions on self-hosted environments.

## Where tavya is ahead

- **Any model.** Claude Code, Codex and any model through OpenCode share one task list, on your own plans or API keys. Claude's cloud sessions run Anthropic's models only.
- **Reviewers you choose.** Each review step is a person or an agent on the model you pick, so Codex can check what Claude Code wrote, and an agent can answer the working agent's questions in your place ([Let one agent review another](/docs/agent-review)). Claude's review is Claude's own, and it "never approves or blocks the pull request".
- **Tasks that wait for other tasks.** A task can start when another lands, a parent reviews its sub-tasks, and approved changes land through a merge queue ([Schedule tasks and react to events](/docs/scheduled-tasks)). Claude's documentation describes sub-agents and scripted workflows inside a session, not one thread waiting for another.
- **Projects that run themselves.** Make a project fully autonomous and agents answer, review and approve each other's work within a budget, while a permanent co-ordinator creates the tasks. A Claude Project has a coordinator too, but "the decision to merge stays with your team".
- **Logins, passwords, a mailbox and a wallet.** Beside apps and secrets, agents get saved browser sessions, a password vault they fill from without seeing, an address for mail and a card with a budget per task ([Give an agent a card with a budget](/docs/agent-payments)). Claude's documentation describes none of the four for cloud sessions.
- **The whole project comes along.** `.env` and credential files are kept as secrets and written back at their paths; datasets and databases are kept in versions beside the code ([Files Git ignores](/docs/ignored-files)). Claude's cloud environments take environment variables and uploaded files.
- **Your own cloud account on any plan**: E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud ([Cloud computers](/docs/computers)).
- **Teams.** People and agents share one set of permissions; an agent never has more access than the person who started its task.
- **Without GitHub.** tavya can host the repositories itself.
- **Open source**, under the GNU AGPL-3.0.

## Which to choose

Choose Claude Code on the web if you use only Claude, work on GitHub, and want cloud sessions at no extra cost. Choose tavya if you want several vendors' agents in one place, agents that use accounts and money within limits, or the computers in your own cloud account. tavya runs Claude Code too: [Run Claude Code in the cloud](/docs/claude-code-in-the-cloud).

## Sources

- [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [Projects](https://code.claude.com/docs/en/claude-projects), [Scheduled tasks](https://code.claude.com/docs/en/routines), [Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments), [Cloud environments](https://code.claude.com/docs/en/cloud-environments), [Code Review](https://code.claude.com/docs/en/code-review), [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude pricing](https://claude.com/pricing)
