# Schedule tasks and react to events

Schedule Claude Code, Codex or OpenCode tasks with tavya: run a task on a cron schedule, after another task finishes, or when a GitHub event or a webhook arrives.

## Set a trigger

Open **New task**, write the task, and scroll to **Triggers**. Left empty, the task starts now. Otherwise:

| Row | The task starts |
|---|---|
| **After** | when the tasks you pick with **＋ Add a task…** are done |
| **Schedule** | on a cron schedule, in UTC: **Minute**, **Hour**, **Day**, **Month**, **Day of week** |
| **Or once at** | once, at a date and time |
| **On event** | when a matching event arrives |

For every weekday at 09:00 UTC, set **Minute** `0`, **Hour** `9` and **Day of week** `1-5`.

Press **Run task**. A task that waits shows **Waiting for trigger** in the list, with **Run now** to start it early and **✕** to cancel the trigger and keep the task as a draft.

## Repeat it

Turn on **Repeatable** and each start becomes a fresh run: a task of its own, with its own computer, conversation and review. A schedule turns **Repeatable** on, and so does a new event trigger.

A repeatable task's page lists its **Runs** and has **Run again**. The task list's **Scheduled** and **Repeatable** views show what you have set up.

## React to events

Under **On event**, type the event's type, for example `github.issues.labeled`. **＋ Only when…** adds a condition, such as `label.name` is `planned`. Each event starts its own run, and the run receives the event.

Events come from:

- **GitHub**: issues, pull requests, pushes, releases and failed workflows of the project's GitHub repositories.
- **Incoming webhooks**: in the project's **Settings → Events**, press **＋ Webhook**, name it and press **Create**. Copy the **URL**, **Secret** and **Event type** it shows; the secret is not shown again.
- **Chat messages** to a bot you connected ([Chat bots](/docs/chat-bots)).
- **Other tasks**: an agent can emit an event that another task waits for.

A service calls a webhook by posting to its URL with the secret:

```
curl -X POST {{origin}}/api/hooks/<id> \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"service": "api", "error": "timeout"}'
```

**Settings → Events** also lists recent events and what each did.

## Start from a ready-made task

The task list's **Task store** view holds repeatable tasks you can **Install**:

- **Maintain the project wiki**, every week.
- **Update dependencies weekly**, as a tested pull request.
- **Repair failed deploys**, when a GitHub workflow fails after a merge.
- **Build planned issues**, when a GitHub issue is labelled "planned".
- **Triage issues daily** and **Tag tasks daily**.

A started task takes triggers too: **Follow-up triggers** on its **Parameters** tab tell its agent when other tasks finish, at a time, or when something happens.

## What a run costs, and how to stop it

A run is an ordinary task. It uses a cloud computer while it works, charged to your plan's compute or to your own cloud account, and the model you chose, billed by its provider or from your compute. See [Pricing](/pricing).

To keep events in check, choose **Skip while one runs** under the event. An event trigger starts at most 60 runs an hour; more wait.

To stop:

- **One run**: open it and press **■** to stop its agent, or **Cancel** to end the run.
- **A repeatable task**: open it and press **Delete**. Its past runs are kept.
- **A task still waiting**: press **✕** on its row.

## Next

- [Chat bots](/docs/chat-bots): start tasks from Telegram, Slack, Discord or WhatsApp.
- [Let one agent review another](/docs/agent-review): have an agent review each run.
- [Run many agents in parallel](/docs/parallel-agents): what limits how many runs work at once.
