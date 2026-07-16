import { describe, it, expect } from 'vitest';
import { CONFIRM_PROMPT_DEFAULT, renderConfirmPrompt } from '../src/domain/confirm-prompt.js';
import { confirmLayersOf } from '../src/domain/confirm.js';
import { manifest } from '../src/contrib/manifests.js';

describe('renderConfirmPrompt (the per-Review request message)', () => {
  it('falls back to the default template and fills {{prompt}}/{{response}}', () => {
    const out = renderConfirmPrompt(undefined, { prompt: 'Do X', response: 'Did X' });
    expect(out).toContain('Do X');
    expect(out).toContain('Did X');
    expect(out).toContain('confirm_decision'); // the default explains the verdict tool
    expect(out).not.toContain('{{'); // all placeholders resolved
  });

  it('uses a custom template verbatim; unknown placeholders render empty', () => {
    const out = renderConfirmPrompt('Ensure X, Y and Z. {{response}} {{nope}}', { response: 'R' });
    expect(out).toBe('Ensure X, Y and Z. R ');
  });

  it('treats a blank/whitespace template as "use the default"', () => {
    const vals = { prompt: 'P', response: 'R' };
    expect(renderConfirmPrompt('   ', vals)).toBe(renderConfirmPrompt(undefined, vals));
  });

  it('the default template uses exactly the placeholders the form documents', () => {
    expect(CONFIRM_PROMPT_DEFAULT).toContain('{{prompt}}');
    expect(CONFIRM_PROMPT_DEFAULT).toContain('{{response}}');
  });

  it('is pre-filled into the confirmer field of every workflow that has one', () => {
    for (const wf of ['software-dev', 'merge-only']) {
      const f = manifest(wf)?.params.find((p) => p.type === 'confirmer');
      expect(f?.promptDefault).toBe(CONFIRM_PROMPT_DEFAULT);
    }
  });
});

describe('confirmLayersOf (the Review-gate layer sequence)', () => {
  it('passes an explicit layer list through, including [] (auto-confirm)', () => {
    const layers = [{ kind: 'agent' as const, provider: 'mock' as const }, { kind: 'human' as const }];
    expect(confirmLayersOf({ layers })).toBe(layers);
    expect(confirmLayersOf({ layers: [] })).toEqual([]);
    // Explicit layers win over a stale legacy mode riding alongside.
    expect(confirmLayersOf({ layers: [], mode: 'human' })).toEqual([]);
  });

  it('normalizes the legacy single-gate modes', () => {
    expect(confirmLayersOf(undefined)).toEqual([{ kind: 'human', audience: ['@creator'] }]);
    expect(confirmLayersOf({ mode: 'human' })).toEqual([{ kind: 'human', audience: ['@creator'] }]);
    expect(confirmLayersOf({ mode: 'auto' })).toEqual([]);
    expect(confirmLayersOf({ mode: 'agent', provider: 'mock', model: 'm', prompt: 'Check.\n{{response}}' })).toEqual([
      { kind: 'agent', provider: 'mock', model: 'm', prompt: 'Check.\n{{response}}' },
    ]);
  });

  it('maps the legacy goal-task autoConfirm flag to zero layers, unless the config speaks', () => {
    expect(confirmLayersOf(undefined, true)).toEqual([]);
    expect(confirmLayersOf({ mode: 'human' }, true)).toEqual([{ kind: 'human', audience: ['@creator'] }]);
    expect(confirmLayersOf({ layers: [{ kind: 'human' }] }, true)).toEqual([{ kind: 'human' }]);
  });

  it('the built-in confirmer fields default to one human layer', () => {
    for (const wf of ['software-dev', 'merge-only', 'goal']) {
      const f = manifest(wf)?.params.find((p) => p.type === 'confirmer');
      expect(confirmLayersOf(f?.default as any)).toEqual([{ kind: 'human', audience: ['@creator'] }]);
    }
  });
});
