import { expect, it } from 'vitest';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { CAPABILITIES } from '../src/platform/capabilities.js';
import { stubGateway } from './helpers/stub-gateway.js';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn } from './helpers/console-page.js';

it('does not advertise or accept the inert safe-mode control (GW-11)', async () => {
  const h = await stubGateway();
  try {
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    for (const method of ['GET', 'POST']) expect((await fetch(`${h.base}/api/safe-mode`, {
      method, headers: { authorization: `Bearer ${token}` },
    })).status).toBe(404);
    expect(JSON.stringify(PLATFORM_API_CATALOG)).not.toContain('/api/safe-mode');
    expect(PLATFORM_API_CATALOG.review).toContain('POST /api/tasks/:taskId/desktop');
    expect(CAPABILITIES).not.toContain('safe-mode:write');
  } finally { await h.close(); }
});

it('offers no safe-mode control in the console', async () => {
  // Installation settings held the toggle; an operator sees every section there.
  const ui = await consolePage({ path: '/installation', api: signedIn((call) =>
    call.path === '/api/settings/installation' ? { canManage: true } : emptySettings(call)) });
  try {
    await ui.run('boot()');
    await ui.page.locator('.settings-layout').waitFor();
    for (const section of await ui.page.locator('.settings-nav a').all()) await section.click();
    expect(await ui.page.locator('.settings-layout').textContent()).not.toMatch(/safe[ -]mode/i);
    expect(ui.calls.filter((call) => call.path.includes('safe-mode'))).toEqual([]);
  } finally { await ui.close(); await closeConsoleBrowser(); }
});
