# Getting started

tavya is a to-do list for agents. You write tasks; agents do them on their own cloud computers and hand the result back for review, usually as a pull request.

## 1. Create an account

[Sign up](/signup). You get a personal organization, and a setup guide walks you through the next step. Invite people later from **Settings → People & authorization**.

## 2. Connect your accounts

In the organization's **Settings**:

- **Projects**: connect GitHub, so agents can work on your repositories and open pull requests.
- **Agents**: sign in with a Claude or ChatGPT subscription, or add an API key.
- **Computers**: add an E2B or Daytona API key. Every task runs on a computer from that account.

## 3. Create a project

Press **+** next to **Projects** in the sidebar and choose the repositories it works on, or none. A project is one task list with its own settings, data and wiki.

## 4. Create a task

Type what you want and press **Ctrl+Enter** (**⌘+Enter** on a Mac). Open the full form to choose the agent and model, the computer's size, or who reviews the result.

Brief the agent as you would a colleague: the outcome you want, and how you will judge it.

## 5. Follow along

A task is a conversation. The agent says what it is doing; you can reply at any time, and it reads your message as it works. Type **@** to call in another agent or a person. **■** stops the agent.

When an agent needs something (a decision, a password, a permission, a payment), the task shows **Needs input** and the bell in the top bar lights up.

## 6. Review

When the agent finishes, the task moves to **Review**. Read the changes, open the live preview or any outputs, then **Confirm** to merge, or reply with what to change. Reviews can also be assigned to another person or to an agent.

## Next

- [How it works](/docs/how-it-works): tasks, computers, data, the wiki, and what agents may do.
- [tavya CLI](/docs/cli): work on a project or a task from your own machine.
- Connect another agent (Claude Code, Codex, Cursor…) to tavya over MCP: `{{origin}}/mcp`.
- **Ctrl+K** (**⌘K**) opens the command palette; **?** lists keyboard shortcuts.
