/**
 * Reasoning-effort → provider-parameter mapping (SPEC §10.5). The `effort` field
 * on an agent profile only has runtime effect once it's sent to the provider:
 *   - Claude Messages API: `output_config: { effort }` (GA, no beta header).
 *   - Claude Agent SDK: an `effort` option (the SDK silently downgrades for
 *     models that don't support it, so it needs no gating here).
 *   - OpenAI Responses API: `reasoning: { effort }` — reasoning models only.
 *
 * Both API surfaces are model-gated: the effort parameter (or the xhigh/max
 * levels) errors on models that don't support it. These helpers return `undefined`
 * (send nothing) for non-reasoning models and clamp levels a supporting model
 * can't take. Codex facts are from the CLI's own models_cache: gpt-5.x (5.5,
 * 5.4-mini) support low/medium/high/xhigh; older reasoning models top out at high.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * The single Claude default model id, shared by `defaultModel('claude')` (which
 * `seedProfiles()` stamps onto every role on first boot) and the Messages-API
 * rail's fallback for a profile with no model. It lives in this leaf module
 * precisely so those two cannot drift: they previously named `claude-sonnet-5`
 * (a model id that has never existed — the installed SDK names sonnet-4-6,
 * opus-4-6/4-8 and fable-5) and `claude-sonnet-4-5` (real, but not effort-capable,
 * so a model-less profile silently lost its reasoning effort on the metered rail).
 * Anything set here MUST satisfy `claudeMessagesEffort()` below.
 */
export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Family + generation parsed out of a Claude model id, or `undefined` when the
 * id is not a modern `claude-<family>-<major>[-<minor>][-<date>]` name.
 *
 * WHY parse rather than list exact ids. Both tables below (effort levels and
 * output ceilings) are gates on capabilities that arrived with a *generation*
 * of a family and are never withdrawn from later ones. An exact-id allowlist
 * therefore encodes "unknown id → assume legacy", which is the wrong side of
 * the trade-off: the failure is silent and permanent on both axes. This already
 * happened — an edit removed the `opus-5`/`sonnet-5` arms on the stated grounds
 * that "those ids do not exist", when `claude-opus-5` is in fact a live id that
 * karmax agents run on. The allowlist then dropped its requested effort with no
 * error and quietly demoted it to the 8192 ceiling the rail used to hard-code —
 * a truncated response, blamed on the model. Note the shape of that mistake: an
 * id absent from the SDK's illustrative list was read as an id that does not
 * exist. The opposite default,
 * "unknown id → assume modern", fails loudly and only in the narrow window
 * where we guess wrong on a brand-new id: the API rejects the effort level,
 * which is visible and fixable. So: recognise the family, compare generations,
 * and let anything newer than the newest *known-incapable* member inherit.
 *
 * The parse is deliberately narrow so the "modern" default cannot capture an
 * old model. Ids from Claude 3.x and earlier put the version FIRST
 * (`claude-3-5-sonnet-20241022`, `claude-2.1`) — those are rejected outright,
 * both because they predate every capability here and because the trailing
 * date would otherwise parse as an enormous generation number. An id we cannot
 * parse at all (a third-party-hosted or renamed deployment) keeps the
 * conservative treatment: no effort, legacy ceiling.
 */
type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
function claudeGeneration(model: string | undefined): { family: ClaudeFamily; gen: number } | undefined {
  const m = (model ?? '').toLowerCase();
  if (/claude-\d/.test(m)) return undefined; // legacy `claude-<version>-<family>` naming
  // `claude-mythos-preview` carries no version; it is the Mythos 5 preview.
  if (m.includes('mythos-preview')) return { family: 'mythos', gen: 5000 };
  const parsed = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(m);
  if (!parsed) return undefined;
  // major*1000 + minor keeps 4.8 < 5.0 while leaving room for two-digit minors.
  return { family: parsed[1] as ClaudeFamily, gen: Number(parsed[2]) * 1000 + Number(parsed[3] ?? 0) };
}

/**
 * Per-model output-token ceilings (Anthropic's published `max_tokens` caps).
 * Sonnet 4.6 / Sonnet 4.5 / Haiku 4.5 cap at 64K; the Opus 4.5+ and Fable/Mythos
 * 5 families at 128K — and, per `claudeGeneration()` above, so does any later
 * generation of those families. Anything older or unrecognised keeps the
 * conservative 8192 the Messages rail used to hard-code for everyone.
 */
function claudeOutputCeiling(model: string | undefined): number {
  const v = claudeGeneration(model);
  if (!v) return 8192;
  if (v.family === 'fable' || v.family === 'mythos') return v.gen >= 5000 ? 128_000 : 8192;
  if (v.family === 'opus') return v.gen >= 4005 ? 128_000 : 8192; // Opus 4.5+
  return v.gen >= 4005 ? 64_000 : 8192; // Sonnet 4.5+ / Haiku 4.5+
}

/**
 * `max_tokens` for the **non-streaming** Messages rail (`src/agent/claude.ts`).
 *
 * The old hard-coded 8192 truncated a whole rewritten file mid-response, and the
 * loop then paid an extra billed round trip ("Continue.") to recover from the cut
 * it had caused. But the model ceilings above (64K/128K) are only safely
 * reachable when streaming: Anthropic's own guidance is that a non-streaming
 * request much above ~16K risks an HTTP/SDK timeout before the response lands.
 * So take the model's real ceiling and clamp it to a non-streaming-safe budget —
 * double the old value on every current model, with no timeout exposure. If the
 * rail ever moves to streaming, drop the clamp (not the table).
 *
 * `KARMAX_CLAUDE_MAX_TOKENS` overrides it, still clamped by the model ceiling.
 */
export const CLAUDE_NON_STREAMING_MAX_TOKENS = 16_000;
export function claudeMaxTokens(model: string | undefined): number {
  const ceiling = claudeOutputCeiling(model);
  const override = Number(process.env.KARMAX_CLAUDE_MAX_TOKENS);
  const wanted = Number.isFinite(override) && override > 0 ? override : CLAUDE_NON_STREAMING_MAX_TOKENS;
  return Math.min(ceiling, wanted);
}

/** effort to send on the Claude Messages API `output_config`, or undefined. */
export function claudeMessagesEffort(model: string | undefined, effort?: string): Effort | undefined {
  if (!effort || !model) return undefined;
  const v = claudeGeneration(model);
  if (!v) return undefined;
  // Facts are taken from the installed @anthropic-ai/claude-agent-sdk's own
  // EffortLevel docs: the parameter is accepted by Opus 4.5+, Sonnet 4.6 and
  // Fable 5; `xhigh` by Fable 5 and Opus 4.7+; `max` by Fable 5, Opus 4.6+ and
  // Sonnet 4.6. That list is illustrative of what exists today, NOT an
  // exhaustive registry — so each threshold below sits one generation above
  // the newest member the SDK is known to REJECT, and any later generation of
  // the family inherits the capability (see `claudeGeneration()` for why an
  // exact-id allowlist is the wrong default here). Haiku and pre-4.6 Sonnet
  // have never taken the parameter at all, hence their 5000 floors: today's
  // ids stay correctly excluded, a future one is assumed to have caught up.
  const floors: Record<ClaudeFamily, { effort: number; max: number; xhigh: number }> = {
    opus: { effort: 4005, max: 4006, xhigh: 4007 }, // 4.5 / 4.6 / 4.7
    sonnet: { effort: 4006, max: 4006, xhigh: 5000 }, // 4.6; no sonnet takes xhigh yet
    haiku: { effort: 5000, max: 5000, xhigh: 5000 }, // 4.5 rejects the parameter
    fable: { effort: 5000, max: 5000, xhigh: 5000 },
    mythos: { effort: 5000, max: 5000, xhigh: 5000 },
  };
  const floor = floors[v.family];
  if (v.gen < floor.effort) return undefined;
  const xhighOk = v.gen >= floor.xhigh;
  const maxOk = v.gen >= floor.max;
  let e = effort as Effort;
  if (e === 'xhigh' && !xhighOk) e = 'high';
  if (e === 'max' && !maxOk) e = 'high';
  return e;
}

/** Reasoning effort for Codex — sent on the Responses API `reasoning.effort` and
 *  the `codex exec` `-c model_reasoning_effort`. Only reasoning models accept it
 *  (non-reasoning models like gpt-4.1/gpt-4o don't). gpt-5.x accepts xhigh; older
 *  reasoning models clamp xhigh/max → high. */
export function codexReasoningEffort(model: string | undefined, effort?: string): Effort | undefined {
  if (!effort || !model) return undefined;
  const m = model.toLowerCase();
  // GPT-6 supports max without the downgrade required by older Codex models.
  if (/^gpt-6(?:-|$)/.test(m)) {
    return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort as Effort : undefined;
  }
  const isReasoning = /^(o1|o3|o4|gpt-5|codex)/.test(m) || m.includes('reasoning');
  if (!isReasoning) return undefined;
  const xhighOk = /^gpt-5/.test(m); // gpt-5.x support xhigh; o-series top out at high
  if (effort === 'xhigh' || effort === 'max') return xhighOk ? 'xhigh' : 'high';
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  return undefined;
}
