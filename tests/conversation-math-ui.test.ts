import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// The TeX button beside each agent message with math flips the one Appearance
// preference, so every conversation (and the next visit) follows the last click.
describe('conversation TeX button', () => {
  it('toggles the global math preference for every conversation', async () => {
    const ui = await consolePage();
    await ui.run(`
      S.taskTab = 'checkin';
      const v = { taskId: 't1' };
      window.renderTaskPage = () => {
        $('#main').innerHTML = ['do', 'merge'].map((role) =>
          '<div data-agent="' + role + '">' + explainMessageAffordance({ sourceKey: 'message:1', conversationRole: role, message: { text: 'Area: $x^2$' } }, v) + '</div>').join('');
        wireExplainMessages(v);
      };
      renderTaskPage();
    `);
    const pressed = () => ui.page.locator('.tex-toggle').evaluateAll((els: any[]) => els.map((el) => el.getAttribute('aria-pressed')));
    const preference = () => ui.run<string | null>("localStorage.getItem('karmax-mathjax')");
    expect(await pressed()).toEqual(['true', 'true']);
    await ui.page.locator('[data-agent="merge"] .tex-toggle').click();
    expect(await preference()).toBe('0');
    expect(await pressed()).toEqual(['false', 'false']);
    expect(await ui.page.evaluate(() => (globalThis as any).document.activeElement?.closest('[data-agent]')?.getAttribute('data-agent'))).toBe('merge');
    await ui.page.locator('[data-agent="do"] .tex-toggle').click();
    expect(await preference()).toBe('1');
    expect(await pressed()).toEqual(['true', 'true']);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('is offered only beside messages with math to typeset', async () => {
    const ui = await consolePage();
    const toggles = await ui.run<number[]>(`['Costs $5 and $10, see the README.', 'Area: $x^2$', 'Sum: $$a+b$$', 'Use \\\\(x\\\\) here']
      .map((text) => (explainMessageAffordance({ sourceKey: 'message:1', conversationRole: 'do', message: { text } }, { taskId: 't1' })
        .match(/tex-toggle/g) || []).length)`);
    expect(toggles).toEqual([0, 1, 1, 1]);
    await ui.close();
  });
});
