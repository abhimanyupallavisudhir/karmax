import { describe, it, expect } from 'vitest';
import { claudeMessagesEffort, codexReasoningEffort } from '../src/agent/effort.js';

describe('reasoning-effort → provider parameter mapping (SPEC §10.5)', () => {
  describe('Claude Messages API (output_config.effort)', () => {
    it('sends effort on models that support the parameter', () => {
      expect(claudeMessagesEffort('claude-opus-4-8', 'high')).toBe('high');
      expect(claudeMessagesEffort('claude-sonnet-4-6', 'medium')).toBe('medium');
      expect(claudeMessagesEffort('claude-opus-4-8', 'xhigh')).toBe('xhigh');
    });
    it('sends nothing on models that reject the parameter (incl. the default)', () => {
      expect(claudeMessagesEffort('claude-sonnet-4-5', 'high')).toBeUndefined(); // project default
      expect(claudeMessagesEffort('claude-haiku-4-5', 'high')).toBeUndefined();
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
