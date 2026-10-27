import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// Errors read as what happened and what to do; the exact text stays one hover
// (toasts) or one click (a task's error) away, for whoever reports it.
describe('plain-language errors', () => {
  it('error toasts say what to do, keeping the exact text on hover', async () => {
    const ui = await consolePage();
    const raw = 'missing capability review:approve in project "Web" (proj_abc) of organization "Acme" (org_1). Your authorization there is Developer; Project maintainer and above have it. Ask for it with request_permission (capabilities: ["review:approve"]).';
    await ui.run(`toast(${JSON.stringify(raw)}, true); toast('Saved')`);
    const toasts = ui.page.locator('.toast > span');
    expect(await toasts.allInnerTexts()).toEqual(['You don’t have permission to approve work here. Ask an admin to make you a Project maintainer.', 'Saved']);
    expect(await toasts.first().getAttribute('title')).toBe(raw);
    expect(await toasts.last().getAttribute('title')).toBe(null);
    await ui.close();
  });

  it('a task’s error is a plain sentence with its details folded', async () => {
    const ui = await consolePage();
    await ui.run(`$('#main').innerHTML = conversationError({ error: 'Activity task failed → Sandbox is probably not running anymore (envd 502)' })`);
    const box = ui.page.locator('#main .msg.error');
    expect(await box.locator('.role').textContent()).toBe('Something went wrong');
    expect(await box.locator('.msg-text').innerText()).toBe('The task’s computer stopped responding. Retry usually fixes this.');
    expect(await box.locator('details pre').isVisible()).toBe(false);
    await box.getByText('Details').click();
    expect(await box.locator('details pre').innerText()).toBe('Activity task failed → Sandbox is probably not running anymore (envd 502)');
    await ui.close();
  });
});
