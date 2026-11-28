# Launch listings

The words and pictures tavya is listed with. Where each listing lives, which account holds it
and what it cost: the wiki's `ops/go-to-market` (§ Listings).

Facts used below, checked 2026-11-19: Free plan (5 agents at once, $5 of credits for 14 days);
Individual $9/month; Team $19/month + $5 per extra person; agents Claude Code, Codex, OpenCode;
computers on tavya's or your own E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud account;
source GNU AGPL-3.0 at github.com/abhimanyupallavisudhir/karmax; MCP server `https://tavya.io/mcp`
(MCP Registry `io.tavya/tavya`).

## The one-liners

- **Tagline** (the site's, until the owner picks another): Do anything with agents.
- **One sentence**: tavya gives each task its own AI agent and cloud computer, with your accounts and a budget, and you approve what comes back.
- **Short (≤ 160)**: A task list where each task gets an AI agent (Claude Code, Codex or OpenCode) and its own cloud computer. Agents sign in and pay within limits; you approve.

## Product Hunt

| Field | Limit | Value |
|---|---|---|
| Name | 40 | tavya |
| Tagline | 60 | Each task gets an AI agent and its own computer |
| Link | | https://tavya.io/?ref=producthunt |
| Description | 500 | below |
| Thumbnail | 240×240 | `product-hunt/out/thumbnail.png` |
| Gallery | 1270×760 | `product-hunt/out/gallery-1.jpg` … `gallery-8.jpg` (rendered at 2×) |
| Video | | the launch film (`web/media/tavya-launch.mp4`, 1:02) |
| Pricing | | Free options |
| Launch tags | 3 | Artificial Intelligence · Developer Tools · Productivity |
| Links | | GitHub https://github.com/abhimanyupallavisudhir/karmax · Docs https://tavya.io/docs |
| Company info | | Open source |
| Launch | | a Saturday, 12:01 AM Pacific (08:01 UTC); 21 November passed unscheduled, next proposed 5 December |

**Description** (425 characters):

> tavya is a task list where every task gets an AI agent (Claude Code, Codex or OpenCode) and its own cloud computer with your repositories, data and secrets. Agents can sign in, receive mail and pay from a card with a budget, only as far as you allow. Results wait for review by you or another agent. Tasks start sub-tasks, wait for each other or run on events, and a project can run itself. Free plan; open source (AGPL-3.0).

**Maker's first comment**: the owner writes it (Product Hunt: "personality travels further than a generic 'we're live' post"). What it could say, as facts to pick from, not text to paste:
- why: one person built tavya with tavya — 900+ tasks and 4,000+ commits since June 2026, its launch film and docs included;
- what is different: any vendor's agent in one list, reviewing each other; agents with logins, a password vault they fill from without seeing, a mailbox and a card with a budget; files Git ignores and versioned data come along; projects that run themselves;
- what it costs: a free plan with $5 of compute, or your own cloud account and your own Claude/ChatGPT plan or API key;
- the ask Product Hunt allows: "try it, comment, and share feedback" — never ask for upvotes.

Regenerate the pictures after changing a word in `product-hunt/gallery.html`: `design/launch/product-hunt/make.sh`.

## AlternativeTo, SaaSHub and other directories

- **Name**: tavya · **URL**: https://tavya.io
- **Short description**: A task list where each task gets an AI agent (Claude Code, Codex or OpenCode) and its own cloud computer. Agents sign in and pay within limits; you approve.
- **Description**:

> tavya is a to-do list for AI agents. You write a task in plain words; an agent (Claude Code, Codex, or any model through OpenCode) does it on its own cloud computer, with your repositories, data and secrets, including the files Git ignores. It asks when it needs something and hands the result back for review by you, a teammate or another agent.
>
> Agents can use the logins, passwords, API keys, mailbox and payment card you allow: a vault they fill from without seeing the secret, and a budget per task with anything above it waiting for your approval. Tasks start sub-tasks, wait for other tasks, and run on schedules, webhooks and GitHub events. A project can be made fully autonomous, with agents answering, reviewing and approving each other's work.
>
> Use your own Claude or ChatGPT plan or an API key, and tavya's computers or your own E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud account. Free plan. Open source under the AGPL-3.0; it can be self-hosted.

- **Licence / pricing**: Freemium · Open source (AGPL-3.0)
- **Platforms**: Online (SaaS) · Self-hosted
- **Categories**: AI tools / developer tools / productivity (whichever the site has)
- **Tags**: ai-agents, coding-agent, claude-code, codex, opencode, cloud-sandbox, task-management, mcp, self-hosted, open-source
- **Alternative to** (products whose users look for something like tavya): Claude Code, Codex, Devin, Cursor, Paperclip, Warp, Manus, OpenClaw, Vibe Kanban, Terragon, Conductor, Mastra Factory, Factory (Droids)
- **Screenshots**: `web/media/landing/*-light.webp`, or the gallery above
- **Logo**: `web/brand/royal-gold-arrow/icon-512.png`

## MCP directories (Glama, mcp.so, Smithery, PulseMCP)

- **Name**: tavya · **Server URL**: `https://tavya.io/mcp` (streamable HTTP, OAuth sign-in) · **Registry**: `io.tavya/tavya`
- **Description**: Run and manage AI agent tasks on tavya from any MCP client: create, search and steer tasks, answer agents' questions, read project wikis, and call any tavya API. Each task runs Claude Code, Codex or OpenCode on its own cloud computer.
- **Source**: https://github.com/abhimanyupallavisudhir/karmax (AGPL-3.0) · **Docs**: https://tavya.io/docs/getting-started
