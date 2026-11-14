# About tavya

tavya is a to-do list for AI agents: you write a task, an agent does it on its own cloud computer, and you approve the result. It is made by Abhimanyu Pallavi Sudhir in the United Kingdom, and it is open source.

## What it is

Every piece of work is a task on a list. A task gets its own agent (Claude Code, Codex, or any model through OpenCode) and its own cloud computer with your repositories, data and secrets. The agent works, asks when it needs something, and hands the result back for review by you, a teammate or another agent. Tasks can start other tasks, run on a schedule or when something happens, and use the logins, keys and budget you allow.

[How it works](/docs/how-it-works) explains the ideas in a page. [tavya compared](/compare) sets it beside the alternatives.

## The name

*-tavya* is a Sanskrit suffix that turns a verb into "that which is to be done": *kartavya* is a thing to do. Say it "TUV-yuh".

## Built with itself

Since June 2026 nearly every change to tavya has been made by a task in tavya: more than 900 tasks and 4,000 commits by November 2026. Its launch film, its documentation and this page were made the same way.

## Open source

tavya is free software under the GNU AGPL, version 3. Read the source, report a problem or contribute at [github.com/abhimanyupallavisudhir/karmax](https://github.com/abhimanyupallavisudhir/karmax) (the repository keeps the project's code name, karmax), or [run it on your own server](/docs/self-hosting).

## Where to find it

- The hosted service: [tavya.io](https://tavya.io)
- The command-line client: `npm install -g @tavya/cli` ([tavya CLI](/docs/cli))
- For other agents: an MCP server at `{{origin}}/mcp`, listed in the MCP Registry as `io.tavya/tavya`
- What changed lately: [Changelog](/changelog)
- Security reports and contact: [Security & Contact](/legal/security)
