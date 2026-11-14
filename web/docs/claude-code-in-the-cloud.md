# Run Claude Code in the cloud

Run Claude Code in the cloud with tavya: each task is Claude Code on its own cloud computer with your repositories, and it keeps working when your laptop is closed.

## What you get

tavya runs Claude Code for you. Each task gets:

- **Its own cloud computer**, with the project's repositories, a terminal and a browser.
- **A conversation.** Claude Code says what it is doing. Reply at any time from any browser, your phone's included, and it reads your message as it works.
- **A review.** The finished work waits for you to read and confirm before it merges.

The computer is in the cloud, so the task goes on when you close your laptop.

## Set it up

1. [Sign up](/signup). Your first organization gets $5 of free compute for 14 days, which pays for tavya's computers.
2. Connect Claude. In the organization's **Settings → Agents**, under **Add an account**, use one of the two rows:
   - **API key**: choose **Anthropic**, name it, paste the key and press **Add**.
   - **Subscription**: choose **Claude Code**, give the account a name, press **Connect**, and sign in with your own Claude plan.

   Either way Anthropic bills the model, not tavya. If you connect nothing, tasks start on tavya's included model, paid from your compute.
3. Create a project: press **+** next to **Projects** in the sidebar and name it. To work on GitHub repositories, connect GitHub first under **Settings → Projects**. Without it, tavya hosts the repository.
4. Press **New task** (or **N**) and say what you want. Under **Agent**, check that the model field shows a Claude model. Press **Ctrl+Enter** (**⌘+Enter** on a Mac).
5. Follow along. When Claude Code needs a decision, a password or a permission, the task shows **Needs input**. **■** stops it.
6. When the task reaches **Review**, read the changes, then **Confirm** to merge, or reply with what to change.

## From your terminal

Inside a project's folder, the [tavya CLI](/docs/cli) starts and follows tasks:

```
tavya task new "Fix the login bug"
tavya task logs 42 -f
```

## Choose the computer

The **Computer** block of the task form sets the provider and the size: CPU, memory and disk. Leave the provider on **Any** and tavya uses the first computer that fits and has room: your own accounts first, then its own by price. You can grow a computer while its task runs.

To run on your own cloud account, connect E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud under **Settings → Computers**. Your tasks then run there at the provider's price, with nothing added.

## What carries over

Every task starts with the project's repositories, wiki, data and secrets, including the files Git ignores. The wiki holds skills and memories that agents read before working and update as they learn, so a new task starts with what earlier ones wrote down.

## How this differs from Claude Code on the web

Anthropic offers its own cloud sessions, Claude Code on the web. They are included in Claude plans and run on Anthropic's computers. tavya is a separate product that runs Claude Code on computers you choose. It adds one task list across Claude Code, Codex and open models, review by another agent or a person, sub-tasks, triggers, a vault and budgets, and the option of your own cloud account.

## Next

- [Getting started](/docs): the same steps in more detail.
- [Cloud computers](/docs/computers): the providers compared, and how to connect your own account.
- [Run many agents in parallel](/docs/parallel-agents): several tasks at once.
- [Let one agent review another](/docs/agent-review): have Codex review Claude Code's work.
