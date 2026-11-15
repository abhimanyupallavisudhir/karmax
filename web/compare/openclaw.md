# tavya vs OpenClaw

How tavya differs from OpenClaw, the open-source personal assistant, as of November 2026, and when to choose which.

## What OpenClaw is

"The AI that really does things. Any OS. Any Platform." OpenClaw is an assistant that runs on your own machine and answers in the chat apps you use (WhatsApp, Telegram and others), with apps for iOS and Android. "State, memory, and credentials live on your hardware." It works with models from Anthropic, OpenAI, Google, xAI, OpenRouter, local models and more, has a scheduler and webhooks, and can start background sub-agents. It is MIT licensed and free; you pay the model providers.

## What is the same

Both are open source, work with many models, do work that is not code, can drive a browser, and can start work on a schedule or a webhook.

## Where OpenClaw is ahead

- **It lives on your hardware.** Nothing of yours is on someone else's server.
- **Chat first.** You talk to it where you already talk to people.
- **Model choice**, local models included, and an MIT licence.

## Where tavya is different

- **A task list, not a chat.** Every piece of work is a task with its own conversation, result and review, so many can run at once and nothing is lost in a thread.
- **A separate computer for every task.** An agent works in an isolated cloud computer with only the project it was given. OpenClaw's documentation says sandboxing is off by default: its agent works on your own machine.
- **Limits you set.** For each login you choose whether an agent may use it without asking and whether it may ever see it; payments have a budget per task; results wait for review ([Give an agent a card with a budget](/docs/agent-payments)).
- **Projects and teams.** Repositories, pull requests, a merge queue, shared data, and one set of permissions for people and agents.
- **Nothing to keep running.** tavya is hosted; you can also [host it yourself](/docs/self-hosting).

tavya answers in chat too: [Chat bots](/docs/chat-bots) connects Telegram, Slack, Discord and WhatsApp.

## Which to choose

Choose OpenClaw for a personal assistant on your own hardware that you reach through chat. Choose tavya to hand agents projects, with each task isolated, limited and reviewed.

## Sources

- [OpenClaw on GitHub](https://github.com/openclaw/openclaw)
- [Model providers](https://docs.openclaw.ai/concepts/model-providers), [Sandboxing](https://docs.openclaw.ai/gateway/sandboxing), [Sub-agents](https://docs.openclaw.ai/tools/subagents), [Scheduled jobs](https://docs.openclaw.ai/automation/cron-jobs)
