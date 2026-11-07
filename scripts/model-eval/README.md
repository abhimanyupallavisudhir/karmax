# Model evaluation

Which model should tavya's included model be, and what does a task on another
model cost by comparison? This runs real tasks through OpenCode, the release
tavya pins, on OpenRouter, grades each with a hidden test, and records what it
cost at OpenRouter's prices. Its results set `INCLUDED_MODEL_DEFAULT` and
`MEASURED_TASK_USD` in `src/agent/included-model.ts`; the wiki page
`features/included-model` explains the choice.

## Tasks

| Task | What the agent is asked | Graded by |
|---|---|---|
| `k-mail` | a real karmax fix (fcbba67d): MIME headers inside a relay's signature list | the commit's own test |
| `k-pr-inventory` | a real karmax fix (a66b9f91): a pull-request task's ignored-output inventory | the commit's own test |
| `k-title` | a real karmax fix (f8cc9f70): long derived titles end at a word | a unit test of the rule |
| `csv-report` | a CSV report script from scratch | edge-case CSV, exact JSON |
| `todo-api` | a dependency-free JSON API with persistence | HTTP checks, restart |
| `semver-bug` | a user's bug report against a small library (`^0.x` ranges) | 30+ range cases |
| `expense-app` | a phone-friendly web app with fixed element ids | Playwright in Chromium |
| `sheet` | a spreadsheet engine: formulas, ranges, cycles, errors | 40+ cell checks |
| `todo-auth` | accounts on an existing API: hashing, tokens, isolation | HTTP checks, restart |

A karmax task starts from the commit before the fix, without its history; its
grader puts the hidden test in place and runs it.

## Running

```sh
scripts/model-eval/setup.sh      # once per machine: needs sudo
OPENROUTER_API_KEY=… scripts/model-eval/run.py \
  --models deepseek/deepseek-v4.1-flash-1017:max,openai/gpt-6.1-terra:medium --reps 2
scripts/model-eval/summarize.py  # or summarize.py results/2026-11-07.jsonl
```

- **Isolation.** Every run works as the `agent` user, in its own directory under
  `/srv/model-eval`, with nothing of your environment. `setup.sh` makes your
  home directory private: an agent that can read this repository reads the
  graders, and the fixes in git history (the first trial did exactly that).
- **Routing.** Turns go only to providers that keep no prompts, with no 4-bit
  builds, as tavya routes its included model; `--any-provider` lets OpenRouter
  choose.
- **Cost.** About $0.02–0.15 a run; `MODEL_EVAL_BUDGET` (default $20) stops
  launching runs once the key has spent that much. Four runs at a time fit in
  8 GB.
- **Cut off.** A run whose last model call hit OpenCode's output cap.
  `--output-max` raises it (tavya sets 64,000: `OPENCODE_OUTPUT_TOKEN_MAX`).

## Results: 2026-11-07

`results/2026-11-07.jsonl` (148 runs). Cost per run is averaged over the seven
tasks every model ran; "any provider" means OpenRouter chose the provider
(for closed models the price is the same either way).

| Model | Passed | $ per run | Minutes |
|---|---|---|---|
| DeepSeek V4.1 Flash (max), private providers — **the default** | 17/18 | 0.021 | 2.7 |
| DeepSeek V4.1 Flash (max), any provider | 18/18 | 0.017 | 2.6 |
| Claude Haiku 5.5 (high) | 16/18 | 0.017 | 2.9 |
| GPT-6 Luna (max) | 13/14 | 0.021 | 4.7 |
| MiMo-V2.6-Pro | 10/14 | 0.041 | 11.3 |
| GPT-6.1 Terra (medium) | 18/18 | 0.058 | 1.8 |
| GPT-6.1 Terra (high) | 14/14 | 0.080 | 2.4 |
| GPT-6.1 Sol (medium) | 18/18 | 0.107 | 1.9 |

All three DeepSeek and Haiku misses were cut off at OpenCode's 32,000-token
output cap. Raised to 64,000, both passed all 8 runs of the two harder tasks:
Haiku's calls reached 57,498 tokens there, DeepSeek's 17,061.
