import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/**
 * The model field: one `harness:model:effort` input in place of separate
 * harness, model and effort controls — typed, or picked from a list ordered by
 * how often and how recently each model is picked, or from a chart of
 * Artificial Analysis benchmarks.
 */
const benchmarks = {
  source: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai/' },
  fetchedAt: 1,
  models: [
    { id: 'a', name: 'Claude Opus 5.5 (High, Default Fallback)', creator: 'Anthropic', intelligence: 53.6, price: 8, cost: 0.1, seconds: 28,
      ref: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
    { id: 'b', name: 'Claude Opus 5.5 (Low, Default Fallback)', creator: 'Anthropic', intelligence: 42.3, price: 8, cost: 0.02, seconds: 11.8,
      ref: { provider: 'claude', model: 'claude-opus-5-5', effort: 'low' } },
    { id: 'c', name: 'GPT-6 Luna (High)', creator: 'OpenAI', intelligence: 32.9, price: 0.2, cost: 0.004, seconds: 16.8,
      ref: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' } },
    { id: 'd', name: 'GPT-6 Sol (Max)', creator: 'OpenAI', intelligence: 47.6, price: 4,
      ref: { provider: 'codex', model: 'gpt-6-sol', effort: 'max' } },
    { id: 'e', name: 'Gemini 3.1 Pro Preview', creator: 'Google', intelligence: 29.7, price: 4.5, cost: 0.03, seconds: 20.8,
      ref: { provider: 'opencode', model: 'google/gemini-3.1-pro-preview' } },
  ],
};

async function agentField(meta: Record<string, unknown> = {}) {
  const ui = await consolePage({ api: ({ path }) => path.startsWith('/api/models/benchmarks') ? benchmarks : undefined });
  await ui.run(`localStorage.clear(); S.meta = ${JSON.stringify(meta)}; S.avatars = []; S.organizationId = 'o1';
    document.getElementById('main').innerHTML = renderAgentField({ role: 'do' }, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, {});
    wireAgentBox(document.querySelector('.agent-field'));
    window.changes = 0; document.querySelector('.agent-field').addEventListener('change', () => window.changes++);`);
  const read = () => ui.run<Record<string, unknown>>(`readAgentSpec(document.querySelector('.agent-field'))`);
  return { ui, read, input: ui.page.locator('.af-ref') };
}

describe('model field', () => {
  it('is one typable harness:model:effort field, shown as name and effort at rest', async () => {
    const { ui, read, input } = await agentField();
    expect(await ui.page.locator('.agent-controls select').count()).toBe(0);
    expect(await input.inputValue()).toBe('claude:claude-opus-5-5:high');
    expect(await ui.page.locator('.mf-face').innerText()).toMatch(/claude\s*Opus 5\.5\s*high/);
    expect(await read()).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });

    // The harness follows from the model; effort and model are optional.
    for (const [typed, spec, shown] of [
      ['gpt-6-sol:max', { provider: 'codex', model: 'gpt-6-sol', effort: 'max' }, 'codex:gpt-6-sol:max'],
      ['opencode:google/gemini-3.1-pro-preview', { provider: 'opencode', model: 'google/gemini-3.1-pro-preview' }, 'opencode:google/gemini-3.1-pro-preview'],
      ['codex:high', { provider: 'codex', effort: 'high' }, 'codex:high'],
      ['claude:my-private-model:low', { provider: 'claude', model: 'my-private-model', effort: 'low' }, 'claude:my-private-model:low'],
    ] as const) {
      await input.fill(typed);
      await ui.page.keyboard.press('Tab');
      await ui.page.waitForFunction(`document.querySelector('.af-ref').value === ${JSON.stringify(shown)}`);
      const value = await read();
      expect(value).toMatchObject(spec);
      if (!('effort' in spec)) expect(value.effort).toBeUndefined();
    }
    expect(await ui.run('window.changes')).toBeGreaterThanOrEqual(4);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('filters by any part as you type, and an effort word selects that effort', async () => {
    const { ui, read, input } = await agentField();
    await input.click();
    expect(await ui.page.locator('.mf-row').count()).toBeGreaterThan(10);
    await input.pressSequentially('opus hi');
    const first = ui.page.locator('.mf-row').first();
    expect(await first.innerText()).toContain('Opus 5.5');
    expect(await first.locator('.mf-effort-chip.on').innerText()).toBe('high');
    await ui.page.keyboard.press('Enter');
    expect(await read()).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });

    // Arrow into the list, step the effort with left/right, Enter picks.
    await input.click();
    await input.fill('');
    await input.pressSequentially('gpt-6-astra');
    await ui.page.keyboard.press('ArrowDown');
    await ui.page.keyboard.press('ArrowRight');
    await ui.page.keyboard.press('ArrowRight');
    await ui.page.keyboard.press('Enter');
    expect(await read()).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', effort: 'medium' });
    await ui.close();
  });

  it('orders models by frecency and remembers the usual effort', async () => {
    const { ui, read, input } = await agentField();
    await input.click();
    const luna = ui.page.locator('.mf-row', { hasText: 'gpt-6-luna' });
    await luna.locator('.mf-effort-chip', { hasText: 'xhigh' }).click();
    expect(await read()).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', effort: 'xhigh' });

    await input.click();
    const rows = ui.page.locator('.mf-row');
    expect(await rows.first().innerText()).toContain('gpt-6-luna');
    expect(await rows.first().locator('.mf-effort-chip.on').innerText()).toBe('xhigh');
    // A pick's weight halves every two weeks: three picks two weeks ago (1.5)
    // outrank one today (1), which outranks one a month ago (0.23).
    await ui.run(`localStorage.setItem('tavya.models', JSON.stringify({
      'codex:gpt-6-luna:xhigh': [Date.now()],
      'claude:claude-fable-5-1:max': [Date.now() - 14 * 864e5, Date.now() - 14 * 864e5, Date.now() - 14 * 864e5],
      'codex:gpt-5.5:': [Date.now() - 30 * 864e5],
    }))`);
    await input.fill('');
    await input.press('Escape');
    await input.click();
    const order = (await rows.allInnerTexts()).slice(0, 3);
    expect(order[0]).toContain('Fable 5.1');
    expect(order[1]).toContain('gpt-6-luna');
    expect(order[2]).toContain('gpt-5.5');
    // A row picks its usual effort; the "auto" chip picks the provider default.
    await rows.first().locator('.mf-row-name').click();
    expect(await read()).toMatchObject({ model: 'claude-fable-5-1', effort: 'max' });
    await input.click();
    await rows.first().locator('.mf-effort-chip', { hasText: 'auto' }).click();
    const spec = await read();
    expect(spec).toMatchObject({ provider: 'claude', model: 'claude-fable-5-1' });
    expect(spec.effort).toBeUndefined();

    // A model typed by hand, absent from the catalog, is offered once it has been used.
    await input.click();
    await input.fill('codex:gpt-7-preview:high');
    await ui.page.keyboard.press('Tab');
    await input.click();
    const typed = ui.page.locator('.mf-row', { hasText: 'gpt-7-preview' });
    expect(await typed.count()).toBe(1);
    expect(await typed.locator('.mf-harness').innerText()).toBe('codex');
    expect(await typed.locator('.mf-effort-chip.on').innerText()).toBe('high');
    await ui.close();
  });

  it('picks a model from a chart of intelligence against cost or time', async () => {
    const plain = await agentField();
    expect(await plain.ui.page.locator('.mf-chart').count()).toBe(0);
    await plain.ui.close();

    const { ui, read } = await agentField({ modelBenchmarks: true });
    await ui.page.locator('.mf-chart').click();
    const points = ui.page.locator('.mc-point');
    await points.first().waitFor();
    // GPT-6 Sol has no speed measurement, so neither its cost per answer nor its time is known.
    expect(await points.count()).toBe(4);
    expect(await ui.page.locator('.mc-missing').innerText()).toContain('1 without cost data');
    expect(await ui.page.locator('.mc-point.current').getAttribute('aria-label')).toContain('Claude Opus 5.5 · high');
    // Frontier by cost is the upper convex hull of the Pareto-optimal points, as plotted:
    // Opus low ($0.02, 42.3) is Pareto-optimal but under the line from Luna high
    // ($0.004, 32.9) to Opus high ($0.10, 53.6) on the log axis; Gemini is dominated.
    expect(await ui.page.locator('.mc-label').allTextContents()).toEqual(['GPT-6 Luna · high', 'Claude Opus 5.5 · high']);
    expect(await ui.page.locator('.mc-frontier').getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+$/);
    expect(await ui.page.locator('.mc-source a').getAttribute('href')).toBe('https://artificialanalysis.ai/');

    await ui.page.getByRole('button', { name: 'Time', exact: true }).click();
    expect(await points.count()).toBe(4);
    expect(await ui.page.locator('.mc-label').allTextContents()).toEqual(['Claude Opus 5.5 · low', 'Claude Opus 5.5 · high']);
    expect(await ui.page.locator('.mc-missing').innerText()).toContain('1 without time data');

    // Hiding a harness recomputes the frontier without it.
    await ui.page.locator('.mc-key[data-harness="claude"]').click();
    expect(await points.count()).toBe(2);
    expect(await ui.page.locator('.mc-label').allTextContents()).toEqual(['GPT-6 Luna · high']);

    await ui.page.locator('.mc-point', { has: ui.page.locator('[data-harness="codex"]') }).first().hover();
    expect(await ui.page.locator('.mc-tip').innerText()).toContain('codex:gpt-6-luna:high');
    await ui.page.locator('.mc-point', { has: ui.page.locator('[data-harness="codex"]') }).first().click();
    expect(await ui.page.locator('.model-chart').count()).toBe(0);
    expect(await read()).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', effort: 'high' });
    expect(await ui.run<string>(`localStorage.getItem('tavya.models')`)).toContain('codex:gpt-6-luna:high');
    expect(ui.calls.filter((call) => call.path.startsWith('/api/models/benchmarks'))).toHaveLength(1);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
