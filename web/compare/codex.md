# tavya vs Codex cloud

How tavya differs from OpenAI's Codex cloud tasks and automations, as of November 2026, and when to choose which.

## What Codex cloud is

OpenAI runs Codex for you: "Give Codex coding tasks to work through in the cloud, from investigating bugs to building features." Each cloud task runs in a virtual machine. Automations start tasks on a schedule or from Gmail, Slack and GitHub pull-request events, and Codex reviews pull requests when asked (`@codex review`) or automatically. It is part of ChatGPT plans (Plus is $20 a month) and shares the plan's allowance.

## What is the same

A cloud computer per task, parallel work, sub-agents, schedules and events, and review before a change lands.

## Where Codex cloud is ahead

- **Price.** It is part of a ChatGPT plan you may already pay for.
- **ChatGPT around it**: the same plan does research and browser tasks, and there is an iOS app.
- **GitLab.** Codex cloud works with GitHub and GitLab.com repositories; tavya works with GitHub, or hosts repositories itself.

## Where tavya is different

- **More than OpenAI's models.** Codex, Claude Code and any model through OpenCode share one task list, and one can review another's work ([Let one agent review another](/docs/agent-review)).
- **A card with a budget.** Agents pay within a budget per task; anything above it waits for your approval. With the vault, saved browser sessions and an inbox, an agent can finish a sign-up or a purchase on its own ([Give an agent a card with a budget](/docs/agent-payments)).
- **Tasks that wait for other tasks**, sub-tasks reviewed by their parent, and projects where agents answer and review.
- **Your own cloud account**: E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud ([Cloud computers](/docs/computers)).
- **Large data beside the code**, versioned, and every file Git ignores ([Files Git ignores](/docs/ignored-files)).
- **Open source**, under the GNU AGPL-3.0. Codex's command-line client is open source; Codex cloud is not.

## Which to choose

Choose Codex cloud if your work is in ChatGPT and on GitHub or GitLab, and OpenAI's models are the ones you want. Choose tavya to put Codex beside Claude Code and open models, to let agents use accounts and money within limits, or to run the computers in your own cloud account. tavya runs Codex too, on an API key or your ChatGPT plan.

## Sources

- [Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments), [Automations](https://learn.chatgpt.com/docs/automations), [GitHub integration](https://learn.chatgpt.com/docs/third-party/github), [Open source](https://learn.chatgpt.com/docs/open-source)
- [ChatGPT pricing](https://learn.chatgpt.com/docs/pricing)
