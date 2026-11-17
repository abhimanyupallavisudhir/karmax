# tavya vs Codex cloud

How tavya differs from OpenAI's Codex cloud tasks and automations, as of November 2026, and when to choose which.

## What Codex cloud is

OpenAI runs Codex for you: "Give Codex coding tasks to work through in the cloud, from investigating bugs to building features." Each cloud task runs in a virtual machine. Automations start tasks on a schedule or from Gmail, Slack and GitHub pull-request events, and Codex reviews pull requests when asked (`@codex review`) or automatically. It is part of ChatGPT plans (Plus is $20 a month) and shares the plan's allowance.

## What is the same

A cloud computer per task, parallel work, sub-agents, schedules and events, secrets, and review before a change lands. A task can start without a repository in both.

## Where Codex cloud is ahead

- **Price.** It is part of a ChatGPT plan you may already pay for.
- **ChatGPT around it**: the same plan does research and browser tasks, and there is an iOS app.
- **GitLab.** Codex cloud works with GitHub and GitLab.com repositories; tavya works with GitHub, or hosts repositories itself.

## Where tavya is ahead

- **Any model.** Codex, Claude Code and any model through OpenCode share one task list, on your own plans or API keys. Codex cloud runs OpenAI's models only.
- **Reviewers you choose.** Each review step is a person or an agent on the model you pick, so Claude Code can check what Codex wrote, and an agent can answer the working agent's questions in your place ([Let one agent review another](/docs/agent-review)). In Codex cloud you inspect the changes and open the pull request; its code review is Codex's own.
- **Tasks that wait for other tasks.** A task can start when another lands, a parent reviews its sub-tasks, and approved changes land through a merge queue ([Schedule tasks and react to events](/docs/scheduled-tasks)). Codex's documentation describes no way for one cloud task to wait for another.
- **Projects that run themselves.** Make a project fully autonomous and agents answer, review and approve each other's work within a budget, while a permanent co-ordinator creates the tasks.
- **A mailbox and a wallet.** Agents receive mail at their own address and pay from a card with a budget per task; anything above it waits for your approval ([Give an agent a card with a budget](/docs/agent-payments)). ChatGPT's own browser keeps sign-ins and saved passwords, outside Codex cloud tasks, and asks you before every payment.
- **The whole project comes along.** `.env` and credential files are kept as secrets and written back at their paths; datasets and databases are kept in versions beside the code ([Files Git ignores](/docs/ignored-files)). Codex cloud environments take variables, secrets and a saved image of the prepared computer.
- **Your own cloud account**: E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud ([Cloud computers](/docs/computers)).
- **Open source**, under the GNU AGPL-3.0. Codex's command-line client is open source; Codex cloud is not.

## Which to choose

Choose Codex cloud if your work is in ChatGPT and on GitHub or GitLab, and OpenAI's models are the ones you want. Choose tavya to put Codex beside Claude Code and open models, to let agents use accounts and money within limits, or to run the computers in your own cloud account. tavya runs Codex too, on an API key or your ChatGPT plan.

## Sources

- [Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments), [Automations](https://learn.chatgpt.com/docs/automations), [GitHub integration](https://learn.chatgpt.com/docs/third-party/github), [Open source](https://learn.chatgpt.com/docs/open-source), [Codex cloud](https://learn.chatgpt.com/docs/cloud), [Code review](https://learn.chatgpt.com/docs/code-review), [Browser](https://learn.chatgpt.com/docs/browser)
- [ChatGPT pricing](https://learn.chatgpt.com/docs/pricing)
