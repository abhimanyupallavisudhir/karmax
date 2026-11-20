# Ask evaluation: which model can be tavya's Ask agent

An **Ask** (sidebar → Ask, wiki `features/computerless-tasks`) is a task with Computer: None. Its agent has only
tavya's platform tools (`COMPUTERLESS_TOOL_SCHEMAS`, 65 tools) and runs host-side in the worker. This evaluation
measures which models can actually *use* those tools on Ask-style requests, and at what cost and latency. The
coding evaluation in `scripts/model-eval` measured something else (coding in a sandbox).

Results and the recommendation are in the wiki: `features/included-model` § Ask: which model.

## What runs

Production's own path, end to end:

- **Real Temporal, worker, activities, store and gateway** (`tests/helpers/harness.ts`, with `apiAuthorization`
  so the API and worker hold the authorization service as `src/main.ts` wires them).
- **The Ask is created as the Ask box creates it**: `POST /api/projects/<Assistant>/tasks` `{workflow: software-dev,
  ownAuthority: true, params: {prompt, computer: {provider: none}}}`, by the organization's owner over the gateway,
  plus `agent:do` = `opencode` / `openrouter/<model>` / effort (the model the organization's Task defaults would name).
  It therefore holds back the irreversible capabilities like any Ask.
- **The included-model rail of a hosted installation**: the store is hosted and the included model is on, so each
  turn gets the organization's own OpenRouter key and `INCLUDED_MODEL_OPTIONS` (zero data retention, no 4-bit
  builds), and runs through `runChatCompletionsTurn` → `readChatCompletion`, as on tavya.io. The organizations are on
  the `individual` plan (the included model needs a paid plan).
- **`openrouter-proxy.ts`** sits at `KARMAX_OPENROUTER_API_URL`. It answers OpenRouter's *management* API itself
  (no management key needed: each organization's key is `sk-eval-<org>`), swaps that key for the real one and passes
  every model request through unchanged, measuring each round (time to first byte, first token, first visible
  text, tokens, cached tokens, OpenRouter's reported `usage.cost`, else `/generation`, the serving provider, tool
  calls and the tool results sent back). It forwards only the Ask under test: a task the agent creates that would run
  a model of its own is refused (counted as `refusedChildRequests`), so it costs nothing. It stops at `--budget`.

## The organization

Seeded identically for every (model, run) — one organization each, so one model's actions never touch another's:
projects **Website**, **Data pipeline** (with a repository) and **Assistant** (where Asks go); mock-agent tasks in
several stages: one asking a question (Needs input), several in Review, one paused (timer), two failed (escalated:
a Postgres password error, a full disk), a low-priority task, a parent waiting on a sub-task that asks its parent
which S3 bucket to use; a wiki runbook (`runbooks/deploy`); an uptime alert in Website's event inbox.

The sub-task's parent has the worktree world: when the 2026-11-19 results were measured a computerless task could
not create a sub-task (`spawnSubTasks` snapshotted its world with `git`; fixed in 4e00b915), and later runs keep the
same seed so they compare. `--variant identity` (the prompt names the Ask's task, project and organization) measured
what 4e00b915 since does for every Ask; it is now redundant.

## The questions (`scenarios.ts`)

Each graded from the platform's state afterwards; only answers-as-such are graded on the reply's facts.

| id | asks | passes when |
|---|---|---|
| `waiting-for+reply` | "What is task #N in Website waiting for?" then, **as a follow-up in the same conversation**, "Tell it to keep serving them under /blog." | the first reply states the question (redirect /blog → /posts); a message saying keep /blog reached that task |
| `failed-this-week` | "Which of my tasks failed this week, and why?" | both failed tasks and both causes named |
| `wiki-summary` | "Find the wiki page about how we deploy … and summarise it" | ≥ 2 of its 3 facts (Tue/Thu, rollback, Priya) |
| `raise-priority` | "Raise the priority of the October analytics backfill to high." | that task's priority ≥ high |
| `start-on-computer` | "Start a task in Data pipeline to benchmark the CSV importer on a machine with 4 CPUs and 8 GB" | one such task, `computer` not none, cpu 4, memory 8 GB; started, or held for approval *and the reply says so* |
| `weekly-draft` | "Make a draft task in Website that checks for broken links every Monday at 9am." | a draft with a `schedule` trigger, cron on Mondays at 9 (or the reply states the time zone) |
| `tell-me-when-done` | "Tell me when task #N in Website finishes." | the Ask has a follow-up trigger on that task |
| `answer-subtask` | "The S3 upload sub-task … is asking me something. Tell it to use acme-exports-prod." | a message with the bucket reached the sub-task (or its parent) |
| `cancel` | "Cancel the newsletter archive import" | that task cancelled, nothing else |
| `delete-held-back` | "Delete the 'Try out Tailwind v5' task" | not deleted (task:delete is held back) and the agent asked for it (request_permission) or said it needs approval |
| `find-create-follow` | find the Stripe webhook task, start a task in the same project to write integration tests, tell me when it is done | the task exists, says what to test, started (or held and said so), and the Ask follows it |
| `inbox-events` | "Did anything come into the Website project's event inbox today?" | the checkout uptime alert reported |
| `secret-form` | "Save our Mailgun API key as a secret for the Website project." | a ```form with a `secret` field whose `save` writes `/api/projects/<Website>/secrets` (in the reply or an ask) |
| `rename-project` | "Rename the Data pipeline project to 'ETL'." (no dedicated tool: `platform_request`) | the project is named ETL |

## Running it

```bash
# once per machine: the project's install commands (npm ci …)
OPENROUTER_KEY=sk-or-… npx tsx scripts/ask-eval/run.ts \
  --models deepseek/deepseek-v4.1-flash-1017:max,z-ai/glm-5.3:high --runs 2 \
  [--scenarios wiki-summary,cancel] [--concurrency 6] [--budget 15] [--out scripts/ask-eval/results/<date>.jsonl]
python3 -I scripts/ask-eval/summarize.py scripts/ask-eval/results/<date>.jsonl --markdown
```

A model must have a zero-data-retention endpoint on OpenRouter (otherwise every request is refused with "No
endpoints found matching your data policy"); check with one request carrying `INCLUDED_MODEL_OPTIONS`. Effort `max`
and `high` both send OpenRouter `reasoning.effort: high` (`reasoningBody` in `src/agent/computerless.ts`).

Each line of the jsonl is one Ask: pass/note, the reply, every tool call (arguments abridged), tool errors, unknown
tools, bad JSON, tasks it created (draft, computer, attenuated), cost, tokens, cached tokens, providers, and per
turn the time to first token / first visible text / end of turn, from the moment the Ask was created.
`results/system-prompt.txt` is the system prompt the Ask agent got.
