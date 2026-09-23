import { describe, it, expect } from 'vitest';
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_NON_STREAMING_MAX_TOKENS,
  claudeMaxTokens,
  claudeMessagesEffort,
  codexReasoningEffort,
} from '../src/agent/effort.js';
import { defaultModel } from '../src/agent/profiles.js';

describe('reasoning-effort → provider parameter mapping (SPEC §10.5)', () => {
  describe('Claude Messages API (output_config.effort)', () => {
    it('sends effort on models that support the parameter', () => {
      expect(claudeMessagesEffort('claude-fable-5-1', 'max')).toBe('max');
      expect(claudeMessagesEffort('claude-opus-4-8', 'high')).toBe('high');
      expect(claudeMessagesEffort('claude-sonnet-4-6', 'medium')).toBe('medium');
      expect(claudeMessagesEffort('claude-opus-4-8', 'xhigh')).toBe('xhigh');
    });
    it('sends nothing on models that reject the parameter', () => {
      expect(claudeMessagesEffort('claude-sonnet-4-5', 'high')).toBeUndefined();
      expect(claudeMessagesEffort('claude-haiku-4-5', 'high')).toBeUndefined();
    });
    /**
     * The SDK's EffortLevel doc lists the families it knew about when it was
     * written; it is not a registry of every id that will ever exist. An
     * exact-id allowlist is therefore default-deny for anything newer — and this
     * is not a hypothetical about some future model: **`claude-opus-5` is a live
     * id that karmax agents run on today**, and the allowlist silently dropped
     * its requested effort and demoted it to the legacy 8192 output ceiling,
     * with no error anywhere. (The regression was introduced by an edit whose
     * comment asserted those ids "do not exist"; hence the emphasis.) Match on
     * family + generation instead, so a newer generation of a family inherits
     * that family's newest capabilities.
     */
    it('keeps sending effort on newer generations, including the live claude-opus-5', () => {
      expect(claudeMessagesEffort('claude-opus-5', 'max')).toBe('max');
      expect(claudeMessagesEffort('claude-opus-5', 'xhigh')).toBe('xhigh');
      expect(claudeMessagesEffort('claude-opus-6-2', 'xhigh')).toBe('xhigh');
      // Sonnet 4.6 takes the param + max but not xhigh; a *newer* sonnet is
      // assumed to have caught up rather than assumed to be legacy.
      expect(claudeMessagesEffort('claude-sonnet-5', 'max')).toBe('max');
      expect(claudeMessagesEffort('claude-sonnet-5', 'xhigh')).toBe('xhigh');
      // Haiku has never taken the parameter; only a future generation may.
      expect(claudeMessagesEffort('claude-haiku-5', 'high')).toBe('high');
      expect(claudeMessagesEffort('claude-mythos-5', 'max')).toBe('max');
    });
    it('still refuses genuinely old models the SDK would reject', () => {
      // Pre-4.5 Opus, and the legacy `claude-<version>-<family>-<date>` ids,
      // must not be mistaken for a modern generation by the version parse.
      expect(claudeMessagesEffort('claude-opus-4-1-20250805', 'high')).toBeUndefined();
      expect(claudeMessagesEffort('claude-3-opus-20240229', 'max')).toBeUndefined();
      expect(claudeMessagesEffort('claude-3-5-sonnet-20241022', 'max')).toBeUndefined();
      expect(claudeMessagesEffort('claude-3-7-sonnet-20250219', 'xhigh')).toBeUndefined();
      expect(claudeMessagesEffort('claude-2.1', 'high')).toBeUndefined();
      // A dated snapshot of a supported model still resolves to its generation.
      expect(claudeMessagesEffort('claude-sonnet-4-5-20250929', 'high')).toBeUndefined();
      expect(claudeMessagesEffort('claude-opus-4-5-20251101', 'high')).toBe('high');
      expect(claudeMessagesEffort('claude-opus-4-5-20251101', 'xhigh')).toBe('high');
      // An id we cannot parse at all stays conservative — it may not be a
      // Claude model (a third-party-hosted or renamed deployment).
      expect(claudeMessagesEffort('some-unknown-model', 'max')).toBeUndefined();
    });
    it('clamps levels a supporting model cannot take', () => {
      // sonnet-4-6 supports the param + max but not xhigh → clamp to high
      expect(claudeMessagesEffort('claude-sonnet-4-6', 'xhigh')).toBe('high');
      expect(claudeMessagesEffort('claude-sonnet-4-6', 'max')).toBe('max');
      // opus-4-5 supports the param but neither xhigh nor max → clamp both to high
      expect(claudeMessagesEffort('claude-opus-4-5', 'max')).toBe('high');
    });
    it('sends nothing when effort is unset', () => {
      expect(claudeMessagesEffort('claude-opus-4-8', undefined)).toBeUndefined();
    });
  });

  /**
   * The seeded default must be a model that actually exists AND must pass the
   * effort gate: `seedProfiles()` stamps it onto every role on first boot, and a
   * model-less profile on the metered rail falls back to the same constant.
   */
  describe('the Claude default model', () => {
    it('is a real model id, shared by both fallbacks, and effort-capable', () => {
      expect(defaultModel('claude')).toBe(CLAUDE_DEFAULT_MODEL);
      expect(CLAUDE_DEFAULT_MODEL).toBe('claude-sonnet-4-6');
      expect(claudeMessagesEffort(CLAUDE_DEFAULT_MODEL, 'high')).toBe('high');
    });
  });

  /**
   * The Messages rail used to hard-code `max_tokens: 8192` for every model, then
   * pay an extra billed round trip ("Continue.") to recover from the truncation
   * that caused. The rail is non-streaming, so the budget is the model's real
   * ceiling clamped to a value that can't blow the HTTP timeout.
   */
  describe('Claude Messages max_tokens', () => {
    it('raises the budget above the old hard-coded 8192 on current models', () => {
      expect(claudeMaxTokens('claude-sonnet-4-6')).toBeGreaterThan(8192);
      expect(claudeMaxTokens('claude-opus-4-8')).toBeGreaterThan(8192);
      expect(claudeMaxTokens(CLAUDE_DEFAULT_MODEL)).toBe(CLAUDE_NON_STREAMING_MAX_TOKENS);
    });
    it('never exceeds a model output ceiling', () => {
      // Unrecognised model ⇒ keep the conservative legacy budget.
      expect(claudeMaxTokens('some-unknown-model')).toBe(8192);
      expect(claudeMaxTokens(undefined)).toBe(8192);
    });
    it('honours KARMAX_CLAUDE_MAX_TOKENS but still clamps to the ceiling', () => {
      process.env.KARMAX_CLAUDE_MAX_TOKENS = '999999';
      try {
        expect(claudeMaxTokens('claude-sonnet-4-6')).toBe(64_000);
        expect(claudeMaxTokens('claude-opus-4-8')).toBe(128_000);
      } finally {
        delete process.env.KARMAX_CLAUDE_MAX_TOKENS;
      }
    });
    /**
     * Same default-deny trap as the effort gate, on the other axis: an
     * exact-id ceiling table quietly demotes every future model to the legacy
     * 8192, which truncates a long response instead of erroring.
     */
    it('does not demote a newer generation of a known family to the legacy 8192', () => {
      process.env.KARMAX_CLAUDE_MAX_TOKENS = '999999';
      try {
        expect(claudeMaxTokens('claude-opus-5')).toBe(128_000);
        expect(claudeMaxTokens('claude-sonnet-5')).toBe(64_000);
        expect(claudeMaxTokens('claude-mythos-5')).toBe(128_000);
        // Unparseable and genuinely-old ids keep the conservative budget.
        expect(claudeMaxTokens('some-unknown-model')).toBe(8192);
        expect(claudeMaxTokens('claude-3-opus-20240229')).toBe(8192);
        expect(claudeMaxTokens('claude-opus-4-1-20250805')).toBe(8192);
      } finally {
        delete process.env.KARMAX_CLAUDE_MAX_TOKENS;
      }
    });
  });

  describe('OpenAI Responses API (reasoning.effort)', () => {
    it('sends effort only on reasoning models', () => {
      expect(codexReasoningEffort('gpt-5', 'high')).toBe('high');
      expect(codexReasoningEffort('o3-mini', 'low')).toBe('low');
      expect(codexReasoningEffort('gpt-4.1', 'high')).toBeUndefined(); // project default — not a reasoning model
    });
    it('sends xhigh for gpt-5.x (they support it), clamping older reasoning models to high', () => {
      expect(codexReasoningEffort('gpt-5.5', 'xhigh')).toBe('xhigh');
      expect(codexReasoningEffort('gpt-5.4-mini', 'xhigh')).toBe('xhigh');
      expect(codexReasoningEffort('gpt-5.5', 'max')).toBe('xhigh'); // max → the model's top tier
      expect(codexReasoningEffort('o3-mini', 'xhigh')).toBe('high'); // o-series tops out at high
    });
    it('sends nothing when effort is unset', () => {
      expect(codexReasoningEffort('gpt-5', undefined)).toBeUndefined();
    });
  });
});

it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])('preserves explicit reasoning effort for %s', (model) => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    expect(codexReasoningEffort(model, effort)).toBe(effort);
  }
});
