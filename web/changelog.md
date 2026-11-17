# Changelog

This page lists what is new in tavya, newest first: the features, providers, plans, commands and docs added each month.

## November 2026

- **Open source** — tavya's source code is public under the GNU AGPL-3.0, and you can host it yourself on your own server.
- **Free trial** — your first organization gets $5 of free compute for 14 days, so your first tasks need no card.
- **Included model** — tasks start on a model tavya provides, paid from your compute, with no agent login; any OpenRouter model works too.
- **Repositories without GitHub** — tavya can host a project's Git repositories itself; clone them over HTTPS, and move one to GitHub later.
- **Autonomous projects** — switch a project to fully autonomous, and agents plan the work, answer questions, review results and decide requests within a budget.
- **Files** — a project's Files tab shows its repositories, wiki and data as one folder tree; share a file or folder by public link.
- **Answer from the list** — approve a task's requests and answer its quick questions from its row in any task list, without opening it.
- **More ready-made tasks** — the task store adds weekly dependency updates, daily task tagging and weekly upkeep of the project wiki.
- **Claude Fable 5.2** — choose Anthropic's Fable 5.2 as the model of a task that runs Claude Code.
- **Team seats** — add or remove seats on the Team plan in Plan & billing, and keep a plan you had set to cancel.
- **Free plan computers** — on the Free plan, tavya's own computers go up to 2 CPUs, 4 GB of memory and 40 GB of disk.
- **Simpler console** — redesigned forms, a sidebar without a top bar, bigger targets, and decisions named by what they allow.
- **Faster review files** — the images, videos and other files an agent attaches for review open faster.
- **New guides** — the docs add guides on parallel agents, scheduled tasks, agent review, agent payments, ignored files and self-hosting.

## October 2026

- **tavya CLI** — put a project or a task on your own machine with its data and secrets, and start, follow and confirm tasks from the terminal.
- **tavya's own computers** — run tasks on computers tavya provides, charged to your plan's compute, with no provider account of your own.
- **Four more cloud providers** — connect your own Fly.io, Hetzner, AWS or Google Cloud account, for larger disks, lower prices or your own region.
- **Any provider** — leave a task's provider on Any, and tavya uses the first computer that fits and has room.
- **A computer per task** — choose each task's CPU, memory and disk, grow them while it runs, and move a running task to another provider.
- **MCP and tokens** — connect Claude Code, Codex, Cursor or another agent to tavya over MCP, and create personal tokens for scripts and CI.
- **Chat bots** — ask a project for work from Telegram, Slack, Discord or WhatsApp; each request becomes a task, answered in the same thread.
- **Events and webhooks** — start tasks from GitHub activity, incoming webhooks, or events that another task emits.
- **Task templates** — save any task as a template, and start new tasks from it in the console or from the CLI.
- **Task store** — browse ready-made tasks, read what each one does, then run or install it in a project.
- **Several agents, one conversation** — type @ in a task to call in another agent or a person; they share one conversation and take turns.
- **Several pull requests per task** — one task can work on several branches and open a pull request for each of them.
- **Fork contributions** — work on a repository you cannot push to: the agent works on your fork, and the pull request goes upstream.
- **OpenCode in the cloud** — OpenCode now runs on a task's cloud computer, as Claude Code and Codex do.

## September 2026

- **Connected apps** — connect apps such as GitHub, Slack or Google through MCP or Composio, and choose which ones each task's agent may use.
- **Cards and a budget per task** — give each task its cards and one total budget; a payment above the budget waits for your approval.
- **Insights** — see what your organization shipped, how long agents worked, and the tokens each model used.
- **Share a conversation** — share a task's conversation by public link, when your organization and project allow it.
- **New models** — Claude Opus 5.5 and OpenAI's GPT-6 models are available for tasks that run Claude Code or Codex.
- **One Tools picker** — choose a task's MCP servers and connected apps in one searchable Tools field in the task form.
- **Upload data** — add single files or a whole folder to a project's data from your browser.
- **Delete your account** — request deletion of your account from your profile; tavya confirms what is removed and what is kept.
- **Fullscreen conversation** — read an agent's conversation in fullscreen, and press Escape to leave it.
- **A new name** — the product is now called tavya, and its home page follows your light or dark theme.

## August 2026

- **Plans** — hosted plans set how many agents run at once and how much storage you get; manage yours in Plan & billing.
- **Setup guide** — a new organization gets a guide through connecting accounts, creating a project and running a first task.
- **GitHub App** — connect GitHub by installing tavya's GitHub App on the repositories your agents may work on.
- **Responder** — choose who answers an agent's questions while it works: you, another person, or an agent.
- **Projects without a repository** — create a project with no repository, for work that is not code.
- **Your own storage** — keep a project's data in tavya's storage, or in an S3 bucket of your own.
- **Work locally** — continue a task on your own machine, with its branch and its agent's conversation.
- **Bring a conversation** — start a task's agent from a Claude Code or Codex conversation that you upload.
- **New data from a task** — when a task produces files worth keeping, adopt them as project data at review.
- **Export your data** — download a JSON archive of your profile, or of a whole organization, from settings.
- **Password store sync** — connect a pass password store kept in Git, and the vault stays in sync with it.
- **Wiki links in tasks** — type [[ in a task to point its agent at a page of the wiki.
- **Project folders** — group an organization's projects into folders, and folders inside folders, in the sidebar.

## July 2026

- **Cloud computers** — each task runs on its own cloud computer, on E2B or Daytona, and pauses while it waits for you.
- **Sub-tasks** — a task can split its work into sub-tasks, each with its own agent, and wait for them to finish.
- **Agent review** — let an agent review a task's result, alone or as one of several review steps.
- **Several attempts** — run the same task several times at once, and keep the attempt you prefer.
- **Several repositories** — a project can hold several repositories, and one task can change them together.
- **GitHub pull requests** — a task's work goes to GitHub as a pull request, and merges when you confirm it.
- **Vault** — store logins, API keys and passkeys, choose which ones each task may use, and approve an agent's requests for more.
- **Cards for agents** — save a virtual card of your own, with a limit, for agents to pay with.
- **Wiki** — every project and organization has a wiki of skills, memories and prompts that agents read and update.
- **OpenCode** — run tasks with OpenCode, as well as with Claude Code and Codex.
- **Images in prompts** — paste or drag images into a task's prompt for the agent to see.
- **Task numbers and links** — every task has a number in its project, and an address you can bookmark.
- **Keyboard navigation** — move around the console and act on tasks without leaving the keyboard.
- **Search** — find tasks by what was said in their conversations, and save a search as a view.
