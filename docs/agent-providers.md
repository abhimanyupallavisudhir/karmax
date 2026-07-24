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
id and the matching `google` or `xai` API-key namespace. The profile's optional
“Credential provider” field handles custom model ids that do not carry a useful
prefix.
