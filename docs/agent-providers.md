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


## September 23, 2026 harness upgrade audit

The shipped versions are Codex **0.156.1** and Claude Agent SDK **0.3.280**
(paired with Claude Code **2.1.280**). Both dependencies are exact pins: later
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
