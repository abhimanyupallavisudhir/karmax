# tavya vs Claude Code on the web

How tavya differs from Anthropic's own cloud agents (Claude Code on the web, Projects and cloud scheduled tasks), as of November 2026, and when to choose which.

## What Claude Code on the web is

Anthropic runs Claude Code for you: "a Claude Code session that runs on cloud infrastructure instead of on your machine". **Projects** (public beta on Pro, Max and Ultra) is one conversation in which Claude starts a parallel cloud session for each task. **Scheduled tasks** (research preview) run on a schedule, an API call or a GitHub event. Cloud sessions count toward your plan's usage, with "no separate charge for the cloud VM". Plans start at $20 a month.

## What is the same

Each task gets its own cloud computer and keeps working when your laptop is closed. Several run in parallel. Work can start on a schedule or an event. Results come back as pull requests or files, and both do work that is not code.

## Where Claude Code on the web is ahead

- **Price.** It is part of a Claude plan you may already pay for.
- **Apps.** The Claude apps for iOS and Android have a Code tab.
- **One vendor to deal with**, with Anthropic's support behind it.
- **Your own network.** Team and Enterprise plans can run sessions on self-hosted environments.

## Where tavya is different

- **More than Claude.** Claude Code, Codex and any model through OpenCode share one task list. Codex can review what Claude Code wrote, or the other way round ([Let one agent review another](/docs/agent-review)).
- **Agents that sign in and pay.** A vault of logins, saved browser sessions, an inbox, and a card with a budget per task ([Give an agent a card with a budget](/docs/agent-payments)).
- **Tasks that wait for other tasks**, sub-tasks reviewed by their parent, and projects where agents answer and review.
- **Your own cloud account on any plan**: E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud ([Cloud computers](/docs/computers)).
- **Teams.** People and agents share one set of permissions; an agent never has more access than the person who started its task.
- **Without GitHub.** tavya can host the repositories itself, and keeps large data beside them, versioned.
- **Open source**, under the GNU AGPL-3.0.

## Which to choose

Choose Claude Code on the web if you use only Claude, work on GitHub, and want cloud sessions at no extra cost. Choose tavya if you want several vendors' agents in one place, agents that use accounts and money within limits, or the computers in your own cloud account. tavya runs Claude Code too: [Run Claude Code in the cloud](/docs/claude-code-in-the-cloud).

## Sources

- [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [Projects](https://code.claude.com/docs/en/claude-projects), [Scheduled tasks](https://code.claude.com/docs/en/routines), [Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)
- [Claude pricing](https://claude.com/pricing)
