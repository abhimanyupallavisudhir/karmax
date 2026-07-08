# PLAN: Image attachments in prompts (paste / ctrl+V)

Investigation + design for letting users paste images into prompt fields (quick-add,
the "⋯ More" task form, and follow-up conversations) and have those images reach the
Do / Merge / Resolve agents. Layered on top of `SPEC.md`.

## Status: IMPLEMENTED

All layers below are built and tested (`npm run typecheck` clean; new tests in
`tests/attachments.test.ts` + `tests/codex-exec.test.ts`). Files changed:

- `src/store/attachments.ts` (new) — content-addressed store + validation.
- `src/config/paths.ts` — `attachments/` dir under `$KARMAX_HOME`.
- `src/domain/types.ts` — `ImageRef`; `images?` on `Message`/`TaskParams`/`TaskInput`.
- `src/gateway/server.ts` — `POST /api/attachments` (bounded raw-body reader) +
  `GET /api/attachments/:id?token=…`; `images` threaded onto the signal route.
- `src/platform/api.ts` — `images` through `createTask`/`queueTask`/`signalTask`.
- `src/workflows/{software-dev,just-do,merge-only}.ts` — initial-prompt images on m0
  (followUp handler already spreads the message, so follow-up images ride along).
- `src/agent/images.ts` (new) — resolve `ImageRef` → Anthropic/OpenAI base64 blocks
  or Codex-CLI temp files. Wired into `src/agent/claude.ts` (Messages API + Agent SDK
  streaming form) and `src/agent/codex.ts` (Responses API + CLI `-i`).
- `web/{app.js,styles.css}` — paste/drag capture + thumbnail chips at all three entry
  points; `<img>` thumbnails in transcripts.

Not done (follow-ups): attachment GC/ref-counting, usage-token accounting for image
tiles, and an opt-in `live-agent` test that sends a real image to a provider.

---

## TL;DR

- **All three providers already support vision.** Claude Messages API and Codex/OpenAI
  Responses API take base64 image content blocks; the Claude Agent SDK takes image
  blocks via `SDKUserMessage.message` (an Anthropic `MessageParam`); and — verified on
  this machine — the **Codex CLI** accepts `-i/--image <FILE>` on *both* `codex exec`
  and `codex exec resume` (the sub-agent report claiming the CLI is text-only is wrong).
- **The bottleneck is entirely internal.** karmax's `Message` type (`{id, role, text, ts}`)
  is text-only, and every layer (gateway → `TaskParams`/`TaskInput` → workflow `msgs[]`
  → `followUp` signal → activity `RunAgentTurnArgs` → adapter) passes only `.text`.
- **The one thing to genuinely worry about: don't put image bytes in Temporal.** The
  prompt travels through workflow *input* and follow-ups through *signals*; both land in
  Temporal **workflow history**, which is replayed forever and has hard payload limits.
  Base64 images inline would blow this up. Store bytes out-of-band (content-addressed on
  disk) and pass only lightweight **references** through the domain types.

## How a prompt flows today (verified)

```
UI (web/app.js)
  quick-add   #new-task            → POST /api/projects/:id/tasks   {title, prompt, workflow}
  ⋯ More form #tf-body [data-field]→ POST /api/projects/:id/tasks   {workflow, params, notes}
  follow-up   .followup-input      → POST /api/tasks/:id/signal     {signal:'followUp', text, role}
        │ api() always sends content-type: application/json, JSON.stringify(body)
        ▼
Gateway (src/gateway/server.ts)
  body(req)                         → JSON.parse only (line 866-875); no multipart
  createTask → api.createTask(...)
  signal     → api.signalTask(token, taskId, signal, text, role)   (line 336)
        ▼
Platform API (src/platform/api.ts)
  createTask: params.prompt = String(resolved.prompt ?? '')        (line 151/162)
  signalTask: msg = {id, role:'user', text: text ?? '', ts:0}      (line 322)  ← text-only
        ▼
Store (src/store/db.ts)   tasks.params TEXT (JSON blob)  — prompt persisted here
        ▼
Workflow (src/workflows/software-dev.ts)  — DETERMINISTIC SANDBOX
  msgs: Message[] = input.prompt ? [{id:'m0', role:'user', text:input.prompt, ts:0}] : []   (line 128)
  setHandler(followUpSignal, (m, role) => target.push({...m, ts:target.length}))            (line 312)
        │ each turn: runAgentTurn activity called with the accumulated msgs[]
        ▼
Activity (src/activities/core.ts)  RunAgentTurnArgs.messages: Message[]  → runTurn(TurnInput)
        ▼
Adapter (src/agent/{claude,codex,mock}.ts)   uses only m.text everywhere
```

Core types (unchanged targets for extension):

```ts
// src/domain/types.ts
interface Message   { id: string; role: 'user'|'agent'|'system'; text: string; ts: number }   // line 100
interface TaskParams{ prompt: string; ... }                                                    // line 70
interface TaskInput { prompt: string; ... }                                                    // line 275
```

There is **no** existing file-upload, multipart, base64, or attachment path anywhere in the
codebase (confirmed by grep). Clean slate.

## Provider capabilities (verified on this box)

| Provider path | Code | Image input mechanism |
|---|---|---|
| Claude **Messages API** | `claude.ts:47` `runMessagesApi` | `content: [{type:'text'...},{type:'image', source:{type:'base64', media_type, data}}]` |
| Claude **Agent SDK** | `claude.ts:118` `runAgentSdk` | `query({prompt})` currently a **string**. Images require the `AsyncIterable<SDKUserMessage>` form, where `message` is an Anthropic `MessageParam` whose `content` carries image blocks. **Must switch off the plain-string prompt.** |
| Codex **Responses API** | `codex.ts:52` | `input:[{role:'user', content:[{type:'input_text'...},{type:'input_image', image_url:'data:...'}]}]` |
| Codex **CLI** | `codex.ts:131` `runCodexExec` | `codex exec -i <FILE> ...` and `codex exec resume <id> -i <FILE> ...` — **file paths**, verified via `--help`. |

Key asymmetry: **Codex CLI wants file paths; the three API/SDK paths want base64.** Whatever
storage we pick, the adapter (which runs inside an *activity* — a non-deterministic side-effect
boundary, so filesystem/encoding is allowed) must materialize the right shape per provider.

## Recommended design

### 1. Storage: content-addressed, out-of-band (the critical decision)

Persist pasted bytes to disk under `KARMAX_HOME`, keyed by SHA-256:

```
$KARMAX_HOME/attachments/<sha256>.<ext>
```

- Content-addressed ⇒ automatic dedup, immutable, cheap to reference.
- Lives outside git worlds/worktrees so it survives world recreation and isn't committed.
- A new gateway endpoint accepts the upload and returns a handle:
  `POST /api/attachments` (raw body or small JSON `{dataUrl}`) → `{id, sha256, mediaType, bytes, width, height}`.
  The UI uploads on paste, *before* task/follow-up submit, so the JSON task/signal payloads
  stay tiny (they carry only the handle).

### 2. Domain type: add references, never bytes

```ts
interface ImageRef {           // NEW
  id: string;                  // == sha256
  mediaType: string;           // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number;
  // NO base64 here — resolved from disk at the activity boundary
}
interface Message {
  id: string; role: 'user'|'agent'|'system'; text: string; ts: number;
  images?: ImageRef[];         // NEW, optional → back-compat, text-only path untouched
}
interface TaskParams { prompt: string; images?: ImageRef[]; ... }   // initial-prompt images
```

`ImageRef` is a handful of bytes, so it flows safely through `TaskInput`, the `followUp`
signal, and workflow `msgs[]`/history. Bytes are fetched only inside the activity.

### 3. Adapter boundary: resolve refs → provider shape (in `src/activities/core.ts` / adapters)

Add one helper that, given `ImageRef[]`, reads `attachments/<id>` and returns either:
- **base64 blocks** for Claude Messages API, Claude Agent SDK (`MessageParam` content), Codex Responses API; or
- **temp file paths** for the Codex CLI (`-i`), writing into the turn's world/temp dir.

Adapter edits:
- `claude.ts` Messages API (l.54-62): build `content` array when `m.images?.length`.
- `claude.ts` Agent SDK (l.171): replace `prompt: userText` with an async generator yielding
  one `SDKUserMessage` whose `message.content` = `[{type:'text'...}, ...imageBlocks]`. (Biggest
  code change; needed for images on *both* initial and resumed SDK turns.)
- `codex.ts` Responses API (l.67-70): add `input_image` blocks.
- `codex.ts` CLI (l.141-161): append `-i <file>` per image (works for `exec` and `exec resume`).
- `mock.ts`: accept and ignore (or echo count) so tests stay green.

### 4. UI: ctrl+V paste at all three entry points (web/app.js, no build step)

A shared `wirePasteImages(textareaEl, store)` helper attached to `#new-task`, the `⋯ More`
prompt field(s) in `#tf-body`, and each `.followup-input`:

```js
el.addEventListener('paste', async (e) => {
  const items = [...(e.clipboardData?.items||[])].filter(i => i.type.startsWith('image/'));
  if (!items.length) return;                     // let normal text paste through
  e.preventDefault();
  for (const it of items) {
    const file = it.getAsFile();
    // client-side guard: size cap + type allowlist
    const meta = await api('/api/attachments', {method:'POST', body: await toJson(file)});
    store.push(meta);                            // render a removable thumbnail chip
  }
});
```

- Render thumbnail chips under the field with an ✕ to remove before send.
- On submit, include `images: store.map(m => m.id)` in the existing JSON payloads
  (`{title, prompt, images}` / `{params:{...,images}}` / `{signal:'followUp', text, images, role}`).
- Also wire `drop` (drag-drop) and a small "attach" button for non-clipboard users — cheap add.
- Render images in the transcript: extend the `.msg` template (app.js ~l.1002) to show
  `<img>` thumbnails from `/api/attachments/:id` when `m.images?.length`.

### 5. Gateway / API plumbing

- `server.ts`: add `POST /api/attachments` (+ `GET /api/attachments/:id` to serve thumbnails,
  auth-checked like every other route). This endpoint is the *only* place that handles bytes.
- `api.signalTask` (l.318): thread an `images` param into the constructed `Message`.
- `api.createTask` / `assembleTaskInput`: carry `params.images` into `TaskInput`.
- `signalTask` gateway hop (`server.ts:336`) passes `b.images` through.

## Things to worry about (the "investigate" ask)

1. **Temporal history bloat / payload limits — the big one.** Initial prompt = workflow
   *input*; every follow-up = a *signal*; both are permanently in workflow history and
   replayed on every workflow-code edit (see CLAUDE.md: editing workflow code replays old
   history). Inline base64 would (a) risk the ~2 MB gRPC payload / 4 MB blob limits, (b)
   bloat history so replays slow down, (c) re-ship the full image to the activity on *every*
   turn since `msgs[]` is resent each turn. **Mitigation = the reference design above.** Only
   `ImageRef` (tens of bytes) ever touches Temporal.

2. **Claude Agent SDK string→stream migration.** The SDK path currently passes a plain
   string `prompt`. Images force the `AsyncIterable<SDKUserMessage>` form. This changes the
   default (and most common, since it's used for Claude-login/subscription) code path — test
   session resume + `--fork-session` still work after the switch. Do it behind a branch:
   keep the string form when `images` is empty.

3. **Codex CLI is initial-prompt vs resume aware.** `exec -i` attaches to the initial prompt;
   `exec resume -i` attaches to the follow-up. The adapter already branches on `resuming`
   (`codex.ts:146`), so route images to the right invocation. Also: images written as temp
   files must live somewhere the codex process (running with `-C <world>`) can read, and be
   cleaned up after the turn.

4. **Validation & abuse.** Enforce server-side: media-type allowlist (png/jpeg/webp/gif — the
   set all providers accept), a per-image size cap (e.g. ≤ 5 MB) and per-message count cap
   (e.g. ≤ 8, providers reject large counts), and reject anything whose bytes don't match an
   image magic-number. `body()` currently reads the whole request into memory unbounded
   (`server.ts:868`) — add a max-bytes guard on the attachments route specifically.

5. **Model/provider capability & cost.** Vision requires a vision-capable model; all current
   Claude and gpt-5/codex models qualify, but the mock and any text-only fallback must not
   choke — degrade gracefully (drop images + note it). Images cost real tokens (tiling); worth
   surfacing in usage accounting (`src/agent/usage.ts`) later, not blocking.

6. **`lastView` / TaskView caching.** `tasks.lastView` and `TaskView.messages/transcripts`
   cache the transcript for the UI. Keep these carrying `ImageRef` (not base64) too, or the
   SQLite row balloons. UI fetches thumbnails lazily via `/api/attachments/:id`.

7. **Persistence lifetime & GC.** Content-addressed files need an eventual cleanup story
   (orphaned when tasks are deleted). Dedup by hash means an attachment may be shared across
   tasks — reference-count or sweep-on-idle rather than delete-with-task.

8. **Security/leakage.** Attachments are user-private; the `GET /api/attachments/:id` route
   must enforce the same session auth as the rest of the gateway, and (ideally) scope access
   to tasks the caller can see. Content-addressed IDs are guessable-resistant (sha256) but
   auth is the real gate. No SSRF surface since bytes come from the client clipboard, not URLs.

## Suggested build order

1. Storage + `POST/GET /api/attachments` + validation (self-contained, testable alone).
2. `ImageRef` on `Message`/`TaskParams`/`TaskInput`; thread through api.ts + signal + workflow
   (pure plumbing, no behavior change when `images` empty).
3. Adapter resolver + per-provider wiring; start with Claude Messages API (simplest), then
   Codex CLI (`-i`), then Codex Responses API, then the Agent SDK stream migration.
4. UI: paste/drop/attach + thumbnail chips + transcript `<img>` rendering at all three entry points.
5. Tests: `store`/`gateway` for the endpoint + validation; `mock` adapter ignores images;
   a `live-agent` case (opt-in) that actually sends an image to Claude/Codex.
