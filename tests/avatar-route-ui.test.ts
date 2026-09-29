import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, signedIn } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// UI-41: the open Avatar is part of the page, so it lives in the URL like an
// open task or wiki entry, and a reload, Back or a shared link restores it.
const avatar = (id: string, name: string) => ({
  id, name, purpose: `${name} purpose`, ownerUserId: 'u', prompt: `${name} instructions`, promptVersion: 1,
  enabled: true, effectiveEnabled: true, callable: true, canEdit: true, canDisable: true, authorityMode: 'full',
  authorization: { level: 'full', capabilities: ['*'] }, callableBy: ['@project'], roles: [], runtime: { provider: 'codex' },
});
const avatars = [avatar('av_atlas', 'Atlas'), avatar('av_iris', 'Iris')];

async function console_(path: string) {
  const ui = await consolePage({ path, api: signedIn(({ method, path: route }) => {
    const pathname = route.split('?')[0];
    if (method === 'GET' && pathname === '/api/projects/p/avatars') return { avatars, availability: { effective: true } };
    if (method === 'GET' && pathname === '/api/authorization-requests') return [];
    if (method === 'GET' && pathname === '/api/projects/p/search') return { tasks: [] };
    return undefined;
  }) });
  await ui.run('boot()');
  return ui;
}
const title = (ui: Awaited<ReturnType<typeof consolePage>>) => ui.page.locator('#main .avatar-detail h1');

describe('Avatar detail route', () => {
  it('opens an Avatar from its URL, as after a reload or from a shared link', async () => {
    const ui = await console_('/org/workspace/avatars/av_iris');
    await expect.poll(() => title(ui).textContent()).toBe('Iris');
    await ui.close();
  });

  it('puts the open Avatar in the URL and restores it on Back', async () => {
    const ui = await console_('/org/workspace/avatars');
    await ui.page.locator('.avatar-row[data-avatar="av_atlas"]').click();
    await expect.poll(() => title(ui).textContent()).toBe('Atlas');
    expect(new URL(ui.page.url()).pathname).toBe('/org/workspace/avatars/av_atlas');

    // Leave for another tab, then come Back: the same Avatar is open again.
    await ui.run(`go(projectRoute('p', 'queue'))`);
    await expect.poll(() => title(ui).count()).toBe(0);
    await ui.page.goBack();
    await expect.poll(() => title(ui).textContent()).toBe('Atlas');

    // Back once more returns to the list; the in-page back arrow leads there too.
    await ui.page.goBack();
    await expect.poll(() => ui.page.locator('#main .avatar-row').count()).toBe(2);
    expect(new URL(ui.page.url()).pathname).toBe('/org/workspace/avatars');
    await ui.page.goForward();
    await expect.poll(() => title(ui).textContent()).toBe('Atlas');
    await ui.page.locator('.avatar-back').click();
    await expect.poll(() => ui.page.locator('#main .avatar-row').count()).toBe(2);
    expect(new URL(ui.page.url()).pathname).toBe('/org/workspace/avatars');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
