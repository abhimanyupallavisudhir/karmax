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

/** effort to send on the Claude Messages API `output_config`, or undefined. */
export function claudeMessagesEffort(model: string | undefined, effort?: string): Effort | undefined {
  if (!effort || !model) return undefined;
  const m = model.toLowerCase();
  // Models that accept the effort parameter at all (Opus 4.5+, Sonnet 4.6+, Fable/Mythos 5).
  if (!/opus-4-(5|6|7|8)|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(m)) return undefined;
  const xhighOk = /opus-4-(7|8)|sonnet-5|fable-5|mythos-5/.test(m);
  const maxOk = /opus-4-(6|7|8)|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(m);
  let e = effort as Effort;
  if (e === 'xhigh' && !xhighOk) e = 'high';
  if (e === 'max' && !maxOk) e = 'high';
  return e;
}

/** Reasoning effort for Codex — sent on the Responses API `reasoning.effort` and
 *  the `codex exec` `-c model_reasoning_effort`. Only reasoning models accept it
 *  (non-reasoning models like gpt-4.1/gpt-4o don't). gpt-5.x accepts xhigh; older
 *  reasoning models clamp xhigh/max → high. */
export function codexReasoningEffort(model: string | undefined, effort?: string): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (!effort || !model) return undefined;
  const m = model.toLowerCase();
  const isReasoning = /^(o1|o3|o4|gpt-5|codex)/.test(m) || m.includes('reasoning');
  if (!isReasoning) return undefined;
  const xhighOk = /^gpt-5/.test(m); // gpt-5.x support xhigh; o-series top out at high
  if (effort === 'xhigh' || effort === 'max') return xhighOk ? 'xhigh' : 'high';
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  return undefined;
}
