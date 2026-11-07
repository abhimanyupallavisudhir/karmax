# Getting started

tavya is a to-do list for agents. You write tasks; agents do them on their own cloud computers and hand the result back for review.

## 1. Create an account

[Sign up](/signup). You get a personal organization, and a setup guide walks you through the next step. Invite people later from **Settings → People & authorization**.

## 2. Connect your accounts

Your first organization comes with **$5 of free compute for 14 days**. It pays for tavya's computers and for tavya's included model, so your first tasks need no agent login and no card.

In the organization's **Settings**:

- **Projects**: optionally connect GitHub, so agents can work on your GitHub repositories and open pull requests. Without it, your code lives in repositories tavya hosts.
- **Agents**: tasks start on tavya's included model (DeepSeek V4.1 Flash, served only by providers that keep no copy of your prompts). Any other model on OpenRouter also runs on your compute; the task form says when one costs more. Or sign in with a Claude or ChatGPT subscription, or add an API key: those are billed by their providers, not from your compute. Pick the model in **Task defaults** or on each task.
- **Computers**: tasks run on tavya's computers, charged to your trial or plan, or on your own E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud account ([Cloud computers](/docs/computers)).

## 3. Create a project

Press **+** next to **Projects** in the sidebar and name it. The project works on the repository of the same name, and tavya creates it if it doesn't exist yet: on GitHub when you connected it, else on tavya itself. Or pick **Choose other repositories** to add others, or none. A project is one task list with its own settings, data and wiki.

A repository tavya hosts is an ordinary Git repository: clone it with `git clone https://tavya.io/git/…` (the project's settings copy the address) and sign in with a personal token (**Profile → Apps and tokens**) as the password, or use [`tavya clone`](/docs/cli). **Move to GitHub** in the project's settings copies it, every branch, to a new GitHub repository that takes its place.

## 4. Create a task

Press **New task** at the top of the sidebar (or **N**), say what you want, and press **Ctrl+Enter** (**⌘+Enter** on a Mac). The same form chooses the agent and model, the computer's size, and who reviews the result.

Brief the agent as you would a colleague: the outcome you want, and how you will judge it.

## 5. Follow along

A task is a conversation. The agent says what it is doing; you can reply at any time, and it reads your message as it works. Type **@** to call in another agent or a person. **■** stops the agent.

When an agent needs something (a decision, a password, a permission, a payment), the task shows **Needs input**, its project's number in the sidebar goes up, and the bell at the bottom of the sidebar counts it. Often it asks with a small form: answer there, or just reply.

## 6. Review

When the agent finishes, the task moves to **Review**. Read the changes, open the live preview or any outputs, then **Confirm** to merge, or reply with what to change. Reviews can also be assigned to another person or to an agent.

## 7. Bring your team

Invite people from **Settings → People & authorization**. Everyone in a project can see its GitHub repositories automatically, with no invitation to accept. Teammates without a GitHub account can still run tasks and confirm them: tavya opens and merges their pull requests for them, as their role allows (**Developer** lands their own tasks, **Project maintainer** anyone's).

## Next

- [How it works](/docs/how-it-works): tasks, computers, data, the wiki, and what agents may do.
- [Cloud computers](/docs/computers): the providers compared, and how to connect your own account.
- [tavya CLI](/docs/cli): work on a project or a task from your own machine.
- Connect another agent (Claude Code, Codex, Cursor…) to tavya over MCP: `{{origin}}/mcp`.
- **Ctrl+K** (**⌘K**) opens the command palette; **?** lists keyboard shortcuts.
- **N** starts a new task; **n** starts one from a template, by its number. Save any task as a template with **Save as template**; manage them in **Task defaults**.
