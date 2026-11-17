# Coding harness and model-provider support

Karmax deliberately distinguishes a **coding harness** from a **model
provider**. A harness owns the agent loop, tools, sessions, permissions, and
structured progress. A model provider owns the model endpoint, subscription, or
API key. Conflating the two made “OpenCode with Kimi” impossible to represent
cleanly.

## Admission bar

A first-class harness must expose a documented, versioned, machine protocol
that can provide all of the semantics Karmax depends on:

- verified terminal success (transport closure is not success);
- persistent session identity and documented resume;
- native session fork. Transcript replay is not equivalent and is not sufficient
  for admitting a new first-class harness;
- structured assistant, reasoning, tool, and plan updates;
- cancellation and permission handling;
- image prompts and per-session MCP;
- an official way to isolate subscription/config state.

Provider stdout intended for people is not an integration API. We do not scrape
a TUI, depend on undocumented local databases, or spoof a client identity.

## Evaluated harnesses (July 2026)

| Harness | Official automation surface | Decision |
| --- | --- | --- |
| Claude Code | Claude Agent SDK | Native adapter retained. |
| Codex | app-server | Native adapter retained. |
| OpenCode | ACP, and a documented OpenAPI server/SDK | First-class via ACP v1 plus its capability-negotiated native fork method. It is the preferred general-model harness. |
| Kimi Code | `kimi acp`; documented `KIMI_CODE_HOME`; device-code login | **Not enabled as a harness.** Its current ACP capability matrix omits `session/fork`, which is a required Karmax semantic. Kimi models remain available through OpenCode. |
| Grok Build | `grok agent stdio` ACP; documented `GROK_HOME` and device login | **Not enabled as a harness.** Its current ACP initialization advertises load but not stable fork; it also omits image and standard model/effort configuration capabilities. xAI models remain available through OpenCode. |
| Cursor | Headless CLI with `stream-json` and a terminal result record | Deferred. It is suitable for batch scripts, but does not document a bidirectional app-server/SDK/ACP control plane with capability negotiation, per-session MCP, permission RPC, and native fork. Parsing its CLI stream would be a lower-quality adapter. |
| ForgeCode | Piped CLI and broad/custom model-provider configuration | Deferred. It is an attractive general harness, but no documented ACP/app-server/SDK control plane was found. Add it when one exists rather than binding Karmax to human CLI output. |
| Google Antigravity | Official CLI plus a Python SDK currently at v0.1 preview | Deferred until the SDK contract is stable and exposes the session/control parity above. Google/Gemini models are available now through OpenCode, without coupling Karmax to a preview SDK. |

Primary references:

- ACP stable protocol: <https://agentclientprotocol.com/protocol/v1/overview>
- ACP official TypeScript SDK: <https://github.com/agentclientprotocol/typescript-sdk>
- OpenCode ACP/server/provider docs: <https://opencode.ai/docs/acp/>,
  <https://opencode.ai/docs/server/>, <https://opencode.ai/docs/providers/>
- Kimi Code ACP/data/model docs:
  <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp>,
  <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command>,
  <https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html>,
  <https://www.kimi.com/code/docs/en/>
- Grok Build docs: <https://docs.x.ai/build/overview>,
  <https://docs.x.ai/build/cli/headless-scripting>,
  <https://docs.x.ai/build/settings/reference>
- Cursor headless contract: <https://docs.cursor.com/en/cli/headless>,
  <https://docs.cursor.com/en/cli/reference/output-format>
- ForgeCode providers: <https://forgecode.dev/docs/custom-providers/>
- Antigravity surfaces/SDK: <https://www.antigravity.google/docs/home>

ACP's core v1 surface is stable, while the `session/fork` RFD is still formally
marked Draft. OpenCode nevertheless ships official fork support (added in
v1.1.30), and the official ACP SDK exposes the negotiated method. Karmax treats
that capability as mandatory: every OpenCode initialization must advertise
native fork, resume/load, and image prompts or the adapter rejects the installed
version with an update error. It never silently degrades an admitted OpenCode
installation to transcript replay.

## What the ACP adapter guarantees

Karmax uses the official `@agentclientprotocol/sdk` stable entry point (ACP v1),
not experimental v2. At process startup it negotiates capabilities. It then:

1. creates, resumes/loads, or forks the native session using only advertised
   methods;
2. passes the Karmax platform MCP and workflow MCP servers in the session
   request;
3. selects model and thought level through advertised session config options;
4. sends text and images using ACP content blocks;
5. translates structured message, reasoning, tool, and plan updates to Karmax's
   durable activity timeline;
6. resolves tool permissions automatically because the selected Karmax world is
   the execution boundary;
7. propagates Temporal cancellation through `session/cancel` and process
   custody; and
8. accepts success only after ACP returns `stopReason: end_turn`.

ACP v1 has no standard “inject another user message into a prompt already in
flight” method. Such a follow-up is therefore retained by Karmax's delivered
message boundary and handled in the next turn; it is never dropped. If ACP adds
a negotiated steering capability, the generic adapter can adopt it for every
ACP harness together.

## Credentials and Kimi

The Accounts UI supports isolated subscription homes for Claude, Codex, and
OpenCode. OpenCode subscription login is deliberately limited to auth flows its
official CLI can select non-interactively with the documented
`auth login --provider … --method …` interface. The UI currently offers xAI's
SuperGrok/Grok-or-X-Premium OAuth flows. ChatGPT subscriptions continue through
Karmax's native Codex login: OpenCode's current source and provider guide
disagree on that auth method's exact label, so Karmax does not hard-code it.
GitHub Copilot's flow asks an additional interactive deployment question, so it
is not exposed until OpenCode offers a stable non-interactive answer for that
prompt.
API-key namespaces include Kimi, xAI, Google, OpenAI,
Anthropic, Moonshot AI, OpenRouter, Groq, Mistral, and DeepSeek.

Project resources and granted vault environment secrets belong to **work
commands**, not to the coding harness's runtime. Adding `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CODEX_API_KEY`, `NODE_OPTIONS`, or any other project variable
cannot change Tavya's model authentication or process startup. They remain
available under their original names to the agent's shell commands, including
application builds and tests.

The separation covers Claude SDK SessionStart shell hooks, Codex app-server
thread shell policy (start/resume/fork), the legacy Codex exec profile, OpenCode's
native `shell.env` plugin and ACP terminals, and the direct API adapters' Bash
tool. Remote harness bootstrap/spawn bypasses the project's environment wrapper;
work tools keep it. Private temporary export/plugin/profile files are removed
at turn end; project secret values are not put in process arguments.

Credentials/Logins order determines the first enabled, compatible, available
account. A login before an API credential prefers the subscription; reversing
the enabled order prefers metered API access. A task/project override can change
the effective order, and unavailable accounts may fall through to the next
eligible entry. Project secrets do not participate in this selection.

Standalone Claude Code does prefer `ANTHROPIC_API_KEY` from its environment over
a saved subscription. Tavya prevents that ambient override after selecting a
login. An explicitly selected API credential still uses the metered adapter.

References: [Claude SessionStart environment hooks](https://code.claude.com/docs/en/hooks#sessionstart),
[OpenCode shell environment hooks](https://opencode.ai/docs/plugins/).

For the requested Kimi design workflow, use:

- **OpenCode harness + Kimi Code API key:**
  choose `opencode`, model `kimi/k3` or `kimi/kimi-for-coding`, then register and
  enable a `kimi` API key. Karmax supplies OpenCode's documented provider config
  in-memory with `https://api.kimi.com/coding/v1`, retaining OpenCode's real
  client identity. The key is resolved from the encrypted vault just in time.

This provides Kimi model access, not use of a Kimi Code consumer subscription.
The latter remains unavailable until the native harness meets the fork
requirement. Likewise, Google models use an API key or Vertex credentials;
Karmax does not represent a Google consumer subscription as portable model API
access.

For Gemini or Grok models through OpenCode, use a `google/...` or `xai/...` model
id and the matching `google` or `xai` API-key credential. Model credentials are
enabled and ordered only in the general Credentials list at organization,
project, or task scope. A recognized model prefix narrows that ordered list to
matching keys (while OpenCode subscription homes remain eligible). For an
unprefixed or custom model id, Karmax leases the highest-priority compatible
credential and uses that credential's provider namespace when configuring
OpenCode. Profiles and task parameters do not have a second “Credential
provider” setting.


## November 11, 2026 Codex upgrade audit

Codex is now **0.167.1** (from 0.167.0; the only stable release in between). Its
release notes are empty ("Full Changelog"). The compare holds two cherry-picks
(#59832, #60040) and the version bump. Read both, diffed the generated app-server
protocol, and compared the model slugs and effort levels compiled into both
binaries.

- **Nothing tavya uses changed.** The only change is `incremental_tools_legacy`,
  a new feature that is under development, off by default, and since #60040 only
  for the `amazon-bedrock` providers. With it, regular Responses requests declare
  tools in history the way Responses Lite already does. The app-server protocol
  generates identically (761 files). The models and effort levels are the same.
  So there is no adapter change.
- **The watcher had no reason to start this run.** Its payload has no `reasons`.
  The "When to upgrade" policy (task #868) reached only the wiki: master's
  `scripts/agent-cli-releases.mjs` still emits every release. Task #868's agent
  was asked to land it (task #915).
- **panagent: `additional_tools`.** Codex records the tool catalog it declared as
  an `additional_tools` response item, on models that send tools incrementally.
  0.167.0 already did this on GPT-6.1 Sol and Terra, though not on GPT-5.5. Every
  converted GPT-6.1 rollout warned `codex_item_not_represented`. panagent now skips
  the item silently, like `ghost_snapshot`: whichever harness continues the
  conversation declares its own tools.
- Verified: typecheck; the agent suites and the real-binary suites (Codex lineage,
  imported ids, foreign provider, native MCP, models, harness compatibility);
  panagent's pinned-Codex test on 0.167.1; real `codex exec` turns on GPT-5.5
  (also on 0.167.0, the same), GPT-6.1 Sol and Terra, and a resumed one; and the
  `live-providers` app-server tests (a turn and a mid-turn `turn/steer`, 2 passed)
  on the real 0.167.1 app-server. Every new rollout converts without a warning
  beyond the usual target-specific ones.

## November 10, 2026 Claude Code upgrade audit

Claude Agent SDK is now **0.3.322** (Claude Code **2.1.322**, from 0.3.319 /
2.1.319). 2.1.320 was never released (no tag and no npm package; the SDK changelog
names a 0.3.320 that npm also lacks), so the range is 2.1.321 and 2.1.322. The
watcher started this run because 2.1.321 added a model. Read both changelogs,
diffed `sdk.d.ts` (it changed only in comments), and compared the model ids,
effort strings and message/record types compiled into both binaries.

- **New model: Claude Fable 5.2** (`claude-fable-5-2`, 2.1.321): the new default
  Fable, 1M context natively, 128K output, $8/$40 per Mtok, cache writes $10 and
  reads $0.20 (`tier_8_40_cache_read_0_20` in the binary). tavya now offers it
  (`CLAUDE_MODEL_PRESETS`, the console's offline list) and prices it on its own
  (`src/scheduling/costs.ts`; Fable 5.1 keeps $10/$50). Its effort levels and
  output cap fall out of `effort.ts`'s family/generation rule unchanged. The
  binary also carries `claude-mythos-5-2` (same tier) without announcing it, as
  with Mythos 5.1: it is not offered.
- **Saved Fable 5.1 picks move to `fable`** (2.1.321): this affects only the CLI's
  own saved setting. tavya passes the exact model id, so `claude-fable-5-1` stays
  5.1.
- **No new effort level, and no new transcript record type**: the
  `"last-wins"` metadata table is unchanged. New message types are
  `system/ui_notify` and `ui_notify_cancel`, which mods (`$.ui.notify`) push to a
  headless host. tavya runs no mods and ignores unknown system subtypes.
  `progress` frames gain `connector_file_progress` data.
- **`claude -p` NFS fix** (2.1.321): losing transcript lines to a full NFS
  export or used-up quota now exits 1 with an error, in text and json output only.
  tavya drives stream-json through the SDK. Its own disk-full wordings
  (`isDiskFullMessage`) are byte-identical in both binaries.
- Unchanged for tavya: the SDK's `canUseTool` `decisionReason` and hook fixes;
  `resume` reading `initialize` during boot (resume and fork are re-proven by
  `harness-compatibility`); queued subagent reports sharing one model call in
  **auto** mode (tavya runs `bypassPermissions`); `AskUserQuestion` refusing an
  `afkTimeoutMs` input (tavya never sets it); headless sessions reloading mods in
  `.claude/skills` on change; MCP OAuth no longer sending secrets across hosts on
  a redirect (a security fix, though not one in a GitHub advisory); the TLS
  `EPROTO` mid-reply fix.
- Verified: typecheck; the agent suites (366 passed), `harness-compatibility` on
  the real 2.1.322 binary (tools, effort, resume, fork, metering incl.
  sub-agents, mid-turn replay); the live Claude turns: Messages API, Agent SDK on
  a subscription, native fork, the permission seam and a whole `live-agent` task.
  Results were the same as on 2.1.319: with `ANTHROPIC_API_KEY` set, native fork
  fails only on the documented Messages-API fallback. The real `/usage` panel
  still parses. panagent's tests passed with its native Claude tests on 2.1.322,
  and 11 real 2.1.322 sessions converted without a warning.
- Live check after landing (cefb4dce deployed 04:22 UTC, Deploy #688): nothing
  newly fails. Live `claude` #17 (`claude-permission`, 2 passed), `agent` #18
  (1 passed) and `e2b` #19 (7 passed) matched the 2.1.319 runs (#13–#15). This
  task's own production turn, resumed on the stale E2B template, ran SDK 0.3.322
  and 2.1.322 from `~/.npm/_npx/…/claude-code` beside the template's Codex
  0.153.4. `karmax_control` and the browser MCP both worked, and a capability
  granted while the task waited (`github:actions:write`) reached the turn's
  token. Its session (54 records from 2.1.319, 261 from 2.1.322) converted
  without a warning in panagent and in karmax's vendored copy (byte-identical).
  The task form on tavya.io lists Claude Fable 5.2 (`claude-fable-5-2`,
  auto…max) above Fable 5.1, and the `fable` alias now reads "Fable 5.2".
  Production's `app.js` is byte-identical to master's. Not new: of the 30
  metadata types in the binary's record table (the same in 2.1.319 and 2.1.322),
  panagent names 12 and would warn on the other 18 (`tag`, `pr-link`,
  `worktree-state`, `content-replacement`, `relocated`, `fork-context-ref`, …)
  if a session wrote them. None of tavya's sessions has written them so far.
  They are deliberately not silenced in bulk, because `content-replacement`,
  `relocated` and `fork-context-ref` may change what the conversation is.

## November 7, 2026 Claude Code upgrade audit

Claude Agent SDK is now **0.3.319** (Claude Code **2.1.319**, from 0.3.318 /
2.1.318; the only release in between). Read both changelogs, diffed `sdk.d.ts`,
and compared the model ids, effort levels and message/record types compiled into
both binaries.

- **No new model or effort level.** Both binaries carry the same `claude-*` ids
  and the same effort strings.
- **`session_writes_lost` only after a clean exit** (0.3.319). A run that ends on
  an error result now gets only the stderr line. tavya fails a turn on its error
  result before that message could arrive, so nothing changes; the SDK's own exit
  error now carries the run's error text instead of "exited with code 1".
- **MCP tasks** (2.1.319) run in the background only with
  `CLAUDE_AUTO_BACKGROUND_TASKS=1` in SDK sessions; tavya does not set it, so MCP
  tool calls (`karmax_control`, the browser) still answer inside the call.
- **`permissions.denyInsteadOfPrompting`** (new setting) also bypasses
  `canUseTool`. tavya never sets it, but a login whose managed policy sets it
  *and* disables bypass would deny tool calls instead of reaching tavya's
  approver — the same class of policy as `disableBypassPermissionsMode`, which a
  host cannot override.
- **Transcripts**: no new record types. `tools-used` (after a turn that called
  tools; already written by 2.1.318) was missing from panagent's silent set, so
  every converted session with a tool call warned; it is now skipped silently.
- Unchanged for tavya: the new optional `set_has_subscribers` control request;
  `mcp_call`'s `check_permissions`; a home holding both `.claude.json` and the
  legacy `.config.json` now prints a stderr notice (tavya's homes write only
  `.claude.json`); `/usage` gains spend lines only behind a Claude apps gateway
  (the real 2.1.319 panel still parses); auto-mode and Bash permission-rule
  changes (tavya runs `bypassPermissions` with a `canUseTool` approver).
- Verified: typecheck; the agent suites and `harness-compatibility` (real binary:
  tools, effort, resume, fork, metering, mid-turn replay); panagent's tests and a
  conversion of real 2.1.319 sessions without warnings; the live Claude turns
  (Messages API, Agent SDK on a subscription, native fork, the permission seam,
  a whole `live-agent` task) with the same results as on 2.1.318.
- Live check after landing (7b9bdb63 deployed 06:47 UTC): Live `claude` #13
  (`claude-permission`, 2 passed), `agent` #14 (1 passed) and `e2b` #15 (7 passed) matched
  the 2.1.318 runs. A resumed production turn on the stale E2B template ran
  2.1.319 from `~/.npm/_npx/…/claude-code` beside the template's Codex 0.153.4,
  with `karmax_control`, the browser MCP and a permission request working. Its
  session held `isolation-latch` records (`{side, sessionId}`, re-stamped on
  resume; in 2.1.318's record table too, first seen in a real session here),
  which panagent warned on; it is now skipped silently.

## November 6, 2026 Codex upgrade audit

Codex is now **0.167.0** (from 0.166.0; the only stable release in between; now
0.167.1, above).
Read the release notes and the linked PRs, diffed the generated app-server
protocol and `codex-rs/features/src/lib.rs` at both tags, and compared the model
slugs and effort levels compiled into both binaries.

- **No new model or effort level.** Both binaries carry the same slugs
  (`gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, …) and efforts; the server's
  catalog for 0.167.0 lists the same models tavya already offers. `ultra` (an
  automatic-delegation mode) is still outside tavya's effort schema, as before.
- **Protocol changes are additive.** `CommandExecutionApprovalKind` gains
  `humanCommand` (sent only to a client that declares `requiredHumanApproval`;
  tavya does not, and auto-approves every approval request anyway);
  `thread/section/changed` is a new notification (ignored); audio input may be a
  `fileId`; OTel requirements gain `log_sse_deltas`. `CodexErrorInfo` is
  unchanged, so the quota/login classification stands.
- **Resume across providers is a TUI change only** (#58202: the picker lists every
  provider's chats and opens a mismatched one read-only). The app-server still
  refuses a resume under another provider; tavya keeps forking imports
  (`tests/codex-foreign-provider.test.ts` passes on 0.167.0).
- **Rollouts are unchanged.** #58166 ("rollout recording … explicit") concerns the
  separate rollout-*trace* recorder, not session rollouts; user-message events
  gain optional `audio_references`/`audio_order` fields that older readers
  ignore. Rollout compression stays off by default.
- **Feature defaults:** `deferred_tool_world_state` is now on (deferred MCP tool
  namespaces are described in the developer `<tools>` context instead of the
  `tool_search` description) — a prompt-shape change only. Everything else new is
  off or TUI-only.
- Verified: typecheck; the agent suites and the real-binary suites (Codex
  lineage, imported ids, foreign provider, native MCP, models, harness
  compatibility); panagent's native Codex test on 0.167.0; real `codex exec` turns
  on GPT-6.1 Sol and Terra with an API key, plus a resumed one; and the
  `live-providers` app-server tests (a turn and a mid-turn `turn/steer`) on the
  real 0.167.0 app-server, run with an API-key `auth.json` in `CODEX_HOME`.

## November 5, 2026 harness upgrade audit

Claude Agent SDK is now **0.3.318** (Claude Code **2.1.318**, from 0.3.281 / 2.1.281)
and Codex **0.166.0** (from 0.162.1; now 0.167.1, above). Reviewed every release's notes in between and
the SDK changelog; diffed the generated Codex app-server protocol.

- **New models are selectable.** Claude Sonnet 5.5 (`claude-sonnet-5-5`, 2.1.284)
  and Haiku 5.5 (`claude-haiku-5-5`, 2.1.293) are the CLI's new `sonnet` and
  `haiku`; both take every effort level (the CLI's own picker lists
  low–max), and both exact ids are offline presets beside Opus 5.5 and Fable 5.1.
  Codex adds GPT-6.1 Terra (`gpt-6.1-terra`, 0.165) to its catalog and the
  offline list. No new effort level; Ultracode became a separate toggle
  (2.1.284) and tavya does not use it.
- **A full disk is said in words.** Since 2.1.301 a login refresh that cannot
  write fails with `invalid_request` and "the disk that holds the Claude Code
  config directory … is full" (it was `authentication_failed`, "Please run
  /login", which looked like a dead login), and since 2.1.309 a full temp volume
  prints "Disk full: …". `isDiskFullMessage` recognises both, so such a turn is
  "Out of disk". Since 2.1.317 a turn whose transcript could not be saved still
  succeeds and is followed by a `session_writes_lost` message; the adapter fails
  that turn as a full disk instead of reporting success over a truncated session.
- **Transcripts record each API request** (2.1.300: `api-request`,
  `api-request-shape`, `api-request-blob`, also `session-owner`, `atis-latch`,
  `cost-state`). panagent skips them silently; before, a converted session
  carried one "unrecognized record" warning per request.
- **Codex resumes a thread only under its saved provider** (0.166:
  `modelProviderMismatch`; 0.162 resumed anyway). tavya runs Codex on `openai`,
  writes imports as `openai`, and forks (never resumes) an imported or uploaded
  session; a fork takes tavya's provider, so an upload from someone's Ollama or
  Azure Codex still works (`tests/codex-foreign-provider.test.ts`). panagent's
  `--install` now saves under the destination home's provider.
- Unchanged for tavya: an omitted `permissionMode` now follows Claude Code's
  own default (0.3.286, 0.3.302) — tavya always sends `bypassPermissions` with
  a `canUseTool` approver; fork subagents are on by default in SDK sessions
  (2.1.302); `run_in_background` commands are bounded by their `timeout`
  (default 30 min, max 2 h) in unattended sessions (2.1.285, 2.1.288) — durable
  work belongs in `start_job` anyway; the `/usage` panel keeps its line format
  (verified against the real 2.1.318 output) and limit messages say "5-hour
  limit" (2.1.312), which `classifyLimitError` already reads as the 5h window;
  the cold-resume quota prompt (2.1.304) is a dialog kind an SDK host must opt
  into, and tavya declares none; options are passed as `--flag=value` (0.3.295),
  and `remoteAgentCommand` only looks for `--print`/`-p`. Sessions started on
  2.1.286 or earlier may lose earlier thinking when resumed (2.1.318 removed that
  fix): a one-time prompt-cache miss for tasks in flight at deploy.
- Codex protocol changes are additive: `CodexErrorInfo` gains `modelNotFound`
  and `policyCapacityUnavailable` (neither is a login or quota failure),
  `ThreadItem` gains lifecycle timestamps, `ThreadUsage.nativeUsageUsdMicros`.
  Rollout compression stays off by default (`local_thread_store_compression`),
  so rollouts are still plain `.jsonl`.
- Verified: the real-binary suites (Claude resume/fork/tools/metering/mid-turn
  replay, Codex lineage/import/native MCP) pass on the new binaries; real turns on
  Claude Code 2.1.318 (subscription, native fork, Sonnet 5.5, Haiku 5.5 at
  xhigh) and Codex 0.166.0 (GPT-6.1 Sol and Terra with an API key).

## October 12, 2026 Codex upgrade audit

Codex became **0.162.1** (from 0.156.1; now 0.166.0, above). With a ChatGPT login OpenAI refuses a
model that the Codex client does not offer: a task set to `gpt-6.1-sol` failed
with `400 … The 'gpt-6.1-sol' model is not supported when using Codex with a
ChatGPT account`. On 0.156.1 the account's `model/list` did not include it either.
GPT-6.1 Sol shipped on 2026-09-29, and Codex 0.161.0 added it (it is also the new
default); 0.162.1 discovers it without credentials (`tests/models.test.ts`).

- **The Compare models chart only offers models the Codex catalog lists.** It
  used to map every OpenAI benchmark row to Codex, so it offered a model that was
  newer than the pinned Codex. Now OpenAI rows need the organization's Codex
  catalog (the account's discovery, else the offline list), like every vendor
  except Anthropic.
- Reviewed 0.157.0–0.162.1 release notes and diffed the generated app-server
  protocol (`codex app-server generate-ts`). The changes Karmax touches are
  additive: new `CodexErrorInfo` values (`flexUnavailable`, `tooManyDenials`,
  open-ended strings; the limit/credential values Karmax classifies are
  unchanged), optional `parentTurnId`/`rootTurnId` on `turn/start` and
  `Turn.rootTurnId`, sub-agent `model`/`reasoningEffort` on thread items, and
  `Turn.error` also set for interrupted turns (the adapter already reads it for
  any non-completed status). Resume now includes the latest committed history,
  and SQLite corruption is detected at startup. The real-binary lineage, resume,
  fork, usage and history tests pass unchanged.
- Codex logs `Codex could not find bubblewrap on PATH` at ERROR level, in colour,
  even though Karmax runs it without Codex's sandbox (`dangerFullAccess`) and
  Codex falls back to its bundled `bwrap`. The browser image and VM provisioning
  now install `bubblewrap`, and failure messages strip terminal escape codes from
  the stderr tail.

## September 23, 2026 harness upgrade audit

The shipped versions were Codex **0.156.1** (now 0.166.0, above) and Claude Agent SDK **0.3.281** (now 0.3.318)
(paired with Claude Code **2.1.281**; see the September 24 note below). Both dependencies are exact pins: later
harness changes require another compatibility review. The browser image pins
match; existing images use the version-checked remote launcher fallback.

- Codex 0.156.1 introduces `gpt-6-sol` and `gpt-6-luna`. The native catalog also
  contains `gpt-6-astra`; it does not contain `gpt-6-terra`. GPT-5.6 Terra remains
  selectable. Account discovery stays authoritative, with current models added
  to the offline fallback. GPT-6 low/medium/high/xhigh/max effort now reaches
  all three execution paths instead of being silently discarded. Browser fallback
  models and effort controls agree with the server. Upstream `ultra` is excluded
  from the picker because it is outside Karmax's existing task effort schema;
  this upgrade does not introduce a new automatic-delegation mode.
- Claude Code 2.1.280 introduces `claude-opus-5-5`, now the upstream Opus alias
  target. The exact id is also a fallback preset so partial SDK discovery cannot
  hide it. Existing explicit profile model choices are preserved. Upstream
  `default`/`opus` aliases continue to follow the provider's choices.
- Reviewed Codex 0.154–0.156.1 release notes: the canonical JSON decoder fix is
  retained; `mcp-server` was removed (Karmax uses `app-server`); resume/fork
  permission preservation, worktree defaults, model-catalog refresh, asynchronous
  input and event changes are covered by adapter and real-binary lineage tests.
  No rollout migration or source-history rewrite is needed for this upgrade.
- Reviewed Claude SDK 0.3.260–0.3.280 and CLI 2.1.260–2.1.280: resumed cost and
  `modelUsage` totals are now cumulative (Karmax reads result `usage`, not those
  totals); background completions can have empty zero-turn results (the adapter
  keeps stdin alive while tracked work remains); SDK MCP servers remain awaited
  despite deferred startup for other servers. Per-model saved effort defaults
  changed, but Karmax passes effort explicitly. Plan-mode writes now use
  `canUseTool`; existing permission handling stays in force. In-process MCP
  entries must be supplied by the SDK host, as Karmax already does. The removed
  Monitor `persistent` input is not used. Task-list tools are no longer defaults
  on newer models; Karmax's own platform task tools remain supplied through MCP.
- September 24 (task #348): SDK 0.3.280 / CLI 2.1.280 dropped SDK MCP servers
  when resuming a session whose previous harness died with a `run_in_background`
  shell still running, so every `karmax_control` tool (`open_pr`,
  `create_review_info`, …) was unavailable for the whole resumed turn. 0.3.281
  keeps them. On that path the CLI also emits an empty `result` before it handles
  the resumed prompt, sometimes followed by an `idle`. The adapter therefore ends
  a turn on `session_state_changed: idle`
  (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`) only after the CLI has echoed the
  uuid of every prompt it was sent (`user_message_uuids`); for a producer that
  never echoes, a result with `num_turns > 0` counts as the answer. Covered by `tests/harness-compatibility.test.ts` (local
  fixture) and `scripts/verify-claude-resume-controls.ts` (live).
- OpenCode is an operator-installed optional harness, not a shipped dependency
  or browser-image package. It discovers models through `opencode models` and
  negotiates ACP capabilities at startup. Its catalog comes from Models.dev;
  there is no Karmax model allowlist to update. No OpenCode/ACP dependency bump
  is required for these native Claude/Codex releases. Kimi and Grok remain
  disabled as native harnesses under the existing admission policy.

Verification uses real pinned binaries against local model HTTP fixtures,
including Claude SDK MCP tool execution, explicit Opus effort, resume and fork;
Codex model discovery, nested forks, decimal-tail history, stale cloud-home
copies and exports; and adapter permission, cancellation, terminal-result and
credential-isolation regressions. These checks incur no model charges. They do
not prove subscription entitlement or a deployed Tavya rollout.

Sources: [Codex releases](https://github.com/openai/codex/releases),
[Codex 0.156.1 catalog](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/models-manager/models.json),
[Claude SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md),
[Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md),
[OpenCode models](https://opencode.ai/docs/models/).
