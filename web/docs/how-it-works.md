# How it works

The few ideas behind tavya, each in a paragraph.

## Organizations and projects

An **organization** is a team: its people, billing, agent accounts, passwords and payment cards. A **project** belongs to one organization and is one task list, with its repositories, data, secrets and wiki.

## Tasks

A **task** is one piece of work, done by an agent or a person. It moves through **Working → Review → Landing** (merging), then ends. A task can start sub-tasks and wait for them, wait for another task, or run on a schedule. **Queues** show the agents waiting for a free slot and the changes waiting to merge, in an order you can change.

## Agents

A task's main agent does the work. Its questions go to the **Responder**, which is you by default or an agent you choose. At **Review**, each review step is a person or an agent. Anyone can call in more agents with **@**. They all share one conversation and take turns. Claude Code, Codex and OpenCode are supported, using your subscriptions or API keys.

## Worlds

Each task runs in its own **world**: a cloud computer with the project's repositories, wiki, data and secrets, including the files Git ignores. Choose its size per task, or grow it while the task runs. An idle world is saved and stopped, then restored where it left off. Open a world's web server in your browser with **Live preview**.

## Resources

**Resources** are a project's files that do not belong in Git: datasets, databases, model weights. They are versioned. A task works on its own copy, and its changes become the next version when the task lands.

## Wiki

Each project and organization has a **wiki** of skills, memories and prompts that agents read before working and update as they learn. Type **[[** in a task to point an agent at a page.

## Access

Agents work with real accounts, within limits you set:

- **Passwords**: logins, saved browser sessions and passkeys from the vault, or from a connected password manager.
- **Payments**: cards with a budget per task; spending above it waits for approval.
- **Apps**: connected services (GitHub, Slack, Google…) through MCP or Composio.

You choose which of these each task may use.

## Authorization

People and agents follow the same rules. Each has a level (Viewer, Developer, Project maintainer, Administrator, Super-administrator) in a project or organization. A task's agents never get more than the person who started it. When an agent needs more, someone who can grant it gets a request. Everything you can do in the console, an agent can do through the API and MCP.

## Plans and storage

Your plan sets how many agents run at once and how much storage you get. See [Pricing](/pricing).
