/**
 * Reasoning-effort → provider-parameter mapping (SPEC §10.5). The `effort` field
 * on an agent profile only has runtime effect once it's sent to the provider:
 *   - Claude Messages API: `output_config: { effort }` (GA, no beta header).
 *   - Claude Agent SDK: an `effort` option (the SDK silently downgrades for
 *     models that don't support it, so it needs no gating here).
 *   - OpenAI Responses API: `reasoning: { effort }` — reasoning models only.
 *
 * Both API surfaces are model-gated: the effort parameter (or the xhigh/max
 * levels) errors on models that don't support it — notably the current defaults
 * (claude-sonnet-4-5, gpt-4.1). These helpers return `undefined` (send nothing)
 * for unsupported models and clamp levels a supporting model can't take.
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

/** effort to send on the OpenAI Responses API `reasoning`, or undefined.
 *  Only reasoning models accept it; gpt-4.1 and other non-reasoning models don't. */
export function codexReasoningEffort(model: string | undefined, effort?: string): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  if (!effort || !model) return undefined;
  const m = model.toLowerCase();
  if (!/^(o1|o3|o4|gpt-5|codex)/.test(m) && !m.includes('reasoning')) return undefined;
  if (effort === 'xhigh' || effort === 'max') return 'high'; // Responses effort tops out at high
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  return undefined;
}
