import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn, type ApiHandler } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/** A signed-in console at `path`, answering `api` first and empty settings after. */
async function open(path: string, api: ApiHandler = () => undefined, ready = '#rail') {
  const ui = await consolePage({ path, api: signedIn(async (call) => (await api(call)) ?? emptySettings(call)) });
  await ui.run('window.confirm = () => true; boot()');
  await ui.page.locator(ready).first().waitFor({ state: 'attached' });
  return ui;
}

describe('settings, one row per setting', () => {
  it('chooses the theme from three visible options instead of cycling a toggle', async () => {
    const ui = await open('/profile', () => undefined, '#profile-theme');
    const choice = (label: string) => ui.page.locator('#profile-theme').getByRole('button', { name: label });
    expect(await ui.page.locator('#profile-theme button').allInnerTexts()).toEqual(['System', 'Light', 'Dark']);
    expect(await choice('System').getAttribute('aria-pressed')).toBe('true');
    await choice('Dark').click();
    expect(await ui.run('document.documentElement.getAttribute("data-theme")')).toBe('dark');
    expect(await ui.run('localStorage.getItem("karmax-theme")')).toBe('dark');
    expect(await choice('Dark').getAttribute('aria-pressed')).toBe('true');
    expect(await choice('System').getAttribute('aria-pressed')).toBe('false');
    await choice('System').click();
    expect(await ui.run('document.documentElement.hasAttribute("data-theme")')).toBe(false);
    // Markdown and math are toggles in the same card.
    expect(await ui.page.locator('#profile-preferences input.toggle').count()).toBe(2);
    await ui.close();
  });

  it('lists only workflows that have a version to pin', async () => {
    const workflows = [
      { name: 'agent-queue', versions: ['1.0.0'], latest: '1.0.0', source: 'bundled' },
      { name: 'software-dev', versions: ['1.0.0', '1.1.0'], latest: '1.1.0', source: 'bundled', description: 'Code changes' },
    ];
    const ui = await open('/org/workspace/settings', ({ path }) => path.endsWith('/workflows') ? workflows
      : path.endsWith('/workflow-pins') ? {} : undefined, '.settings-layout');
    await ui.page.locator('.settings-nav a[href="#project-workflows"]').click();
    const pins = ui.page.locator('#wf-pins-list .wf-pin');
    await pins.first().waitFor();
    expect(await pins.evaluateAll((selects) => selects.map((select) => (select as any).dataset.wf))).toEqual(['software-dev']);
    expect(await ui.page.locator('#wf-pins-list b').getAttribute('title')).toBe('Code changes');
    await ui.close();
  });
});
