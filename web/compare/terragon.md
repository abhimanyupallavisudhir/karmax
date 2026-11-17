# tavya as a Terragon alternative

Terragon shut down in February 2026. How tavya compares for people who used it to run Claude Code and Codex in the cloud on their own subscriptions, as of November 2026.

## What happened to Terragon

Terragon's site says: "As of February 9th, 2026, the service has been shut down and all sandboxes have been terminated." Its code was published as a snapshot, as-is, under Apache-2.0.

Terragon was "a remote background agent orchestrator for running Claude Code, Codex, and other coding clis in the cloud": each task in an isolated sandbox, with recurring and event-triggered automations, on your existing Claude or ChatGPT subscription.

## What carries over

- **Coding agents in the cloud, in the background.** Each tavya task runs Claude Code, Codex or OpenCode on its own cloud computer and keeps working when your laptop is closed.
- **Your own plan or key.** Sign in with a Claude or ChatGPT plan, or add an API key; the provider bills the model.
- **Automations.** Tasks run on a schedule, on a GitHub event or a webhook ([Schedule tasks and react to events](/docs/scheduled-tasks)).
- **Pull requests.** Work lands as a pull request on your GitHub repository after review.

## What tavya adds

- **Review by an agent.** Any review step can be another agent, on another vendor's model ([Let one agent review another](/docs/agent-review)).
- **Sub-tasks and tasks that wait for other tasks.**
- **Accounts and a budget for agents**: a vault of logins, an inbox, and a card with a budget per task ([Give an agent a card with a budget](/docs/agent-payments)).
- **Your own cloud account**: E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud ([Cloud computers](/docs/computers)).
- **Work that is not code**, and teams with one set of permissions for people and agents.
- **Open source and running.** tavya is under the GNU AGPL-3.0; you can [host it yourself](/docs/self-hosting), so the service ending cannot strand you.

## Moving over

[Sign up](/signup), connect GitHub and an agent login under **Settings**, and start a task: [Run Claude Code in the cloud](/docs/claude-code-in-the-cloud).

## Sources

- [terragonlabs.com](https://www.terragonlabs.com/)
- [Terragon's open-source snapshot](https://github.com/terragon-labs/terragon-oss)
