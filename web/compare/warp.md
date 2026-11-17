# tavya vs Warp Factories

How tavya differs from Warp Factories (and Oz, which it succeeds), as of November 2026, and when to choose which.

## What Warp Factories is

"Warp Factories is open, flexible infrastructure for building your own software factory": a staged path from an issue to a pull request (triage, specification, build, review), run by Warp's own agent, Claude Code or Codex on Warp's cloud computers. Work starts from schedules, Slack, Linear, Jira, GitHub, GitLab, webhooks or the API, and a parent run can start child runs on a different agent. It is in early access. Prices: pay as you go (20% above the model provider's API rates), Build at $20 a month, Business at $50 a user. Enterprises can run the workers on their own infrastructure. Warp's terminal client is open source.

## What is the same

Several vendors' agents in one place, a cloud computer per run, parent and child runs, a coordinator, many triggers, apps through MCP, secrets, and review by an agent before a person sees the work.

## Where Warp Factories is ahead

- **A defined pipeline** from issue to pull request, with a specification step a person approves.
- **Issue trackers and GitLab**: Linear, Jira, GitLab and Azure DevOps beside GitHub.
- **The terminal.** If your team already works in Warp, it is the same product.

## Where tavya is ahead

- **Your plans.** An agent can run on your own Claude or ChatGPT plan as well as an API key. Warp's documentation says agent use is billed to an API account.
- **Not only code.** Papers, websites, video and errands are tasks like any other; a task needs no repository.
- **Logins, passwords, a mailbox and a wallet.** Agents get saved browser sessions, a password vault they fill from without seeing, an address for mail and a card with a budget per task ([Give an agent a card with a budget](/docs/agent-payments)). Warp's documentation describes apps and secrets.
- **Work that lands without you, when you say so.** A review step can be an agent, and in a fully autonomous project agents answer, approve and land each other's work within a budget. In Warp, "agents never merge on your behalf".
- **Data in versions.** Datasets and databases are kept in versions beside the code, and `.env` and credential files are written back at their paths ([Files Git ignores](/docs/ignored-files)).
- **Tasks as deep as the work needs.** A sub-task can have sub-tasks; Warp's child runs are one level deep.
- **Your own cloud account on any plan**: E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud.
- **The server is open source too**, under the GNU AGPL-3.0.

## Which to choose

Choose Warp Factories for an engineering team that wants a fixed issue-to-pull-request pipeline tied to Linear or Jira. Choose tavya for a general task list across code and other work, on the plans you already pay for.

## Sources

- [Warp Factories](https://docs.warp.dev/factories/), [How Factories work](https://docs.warp.dev/factories/how-factories-work/), [Harnesses](https://docs.warp.dev/factories/harnesses/), [Orchestration](https://docs.warp.dev/agent-platform/cloud-agents/orchestration/), [Factory agents](https://docs.warp.dev/factories/factory-agents/), [Secrets](https://docs.warp.dev/factories/secrets/)
- [Warp pricing](https://www.warp.dev/pricing)
