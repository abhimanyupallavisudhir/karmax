import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn, type ApiHandler } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

type Console = Awaited<ReturnType<typeof consolePage>>;

/** Settings at `path`, answering `api` first and empty settings after. */
async function settings(path: string, api: ApiHandler = () => undefined) {
  const ui = await consolePage({ path, api: signedIn(async (call) => (await api(call)) ?? emptySettings(call)) });
  await ui.run('boot()');
  await ui.page.locator('.settings-layout').waitFor();
  return ui;
}
/** Every section's text, opened one by one from the navigation as a person would. */
async function everySection(ui: Console) {
  for (const link of await ui.page.locator('.settings-nav a').all()) await link.click();
  return ui.page.locator('.settings-layout').textContent();
}

describe('concise settings UI', () => {
  it('uses plain section names without the removed explanatory copy', async () => {
    const removed = [
      'Workspaces you own or have been added to. Select one to switch to it.',
      'Where tasks run, how large each world is, and the monthly ceiling',
      "This organization's logins and API keys.",
      'Connect a Claude, Codex, or explicitly supported OpenCode subscription.',
      'Stored encrypted in the vault; the key is never shown again.',
      'Choose where tasks run, how large each world is, when idle worlds pause',
    ];
    for (const path of ['/org/settings', '/org/workspace/settings']) {
      const ui = await settings(path);
      expect(await ui.page.locator('.settings-nav a').allTextContents()).toEqual(expect.arrayContaining(['Where tasks run', 'Codex/Claude']));
      const text = await everySection(ui);
      for (const copy of removed) expect(text, path).not.toContain(copy);
      await ui.close();
    }
  });

  // The field stays in the schema for old settings and version-pinned tasks.
  it('removes the legacy local-file setting from current workflow forms', async () => {
    const schema = [{ name: 'software-dev', stages: [], params: [
      { name: 'copyGlobs', type: 'list', label: 'Files', scopes: ['project', 'global'], bind: 'project' },
      { name: 'base', type: 'branch', label: 'Base branch', scopes: ['task', 'project', 'global'], bind: 'top' },
    ] }];
    const ui = await settings('/org/workspace/settings', ({ path }) => path.startsWith('/api/schema') ? schema : undefined);
    await everySection(ui);
    expect(await ui.page.locator('[data-field="base"]').count()).toBeGreaterThan(0);
    expect(await ui.page.locator('[data-field="copyGlobs"]').count()).toBe(0);
    await ui.close();
  });

  it('keeps Advanced controls hidden until a server-derived permission check allows them', async () => {
    let grant!: () => void;
    const granted = new Promise<void>((resolve) => { grant = resolve; });
    const ui = await settings('/org/workspace/settings', ({ path }) => path.startsWith('/api/settings/access')
      ? granted.then(() => ({ project: true, projectDelete: true, projectTransfer: true })) : undefined);
    await expect.poll(() => ui.calls.some((call) => call.path === '/api/settings/access?projectId=p')).toBe(true);
    // Even the Advanced section's link waits for the answer.
    const gated = ui.page.locator('[data-settings-access]');
    expect(await gated.count()).toBeGreaterThan(1);
    expect(await gated.evaluateAll((controls) => controls.every((control) => (control as HTMLElement).hidden))).toBe(true);
    grant();
    await ui.page.locator('.settings-nav a[href="#project-advanced"]').click();
    await expect.poll(() => ui.page.locator('#delete-project').isVisible()).toBe(true);
    await ui.close();
  });

  it('does not announce connector success before verified status is returned', async () => {
    let verify!: () => void;
    const verified = new Promise<void>((resolve) => { verify = resolve; });
    const ui = await consolePage({ api: async ({ method, path }) => {
      const pathname = path.split('?')[0]!;
      if (pathname === '/api/vault/items' || pathname === '/api/vault/requests') return [];
      if (pathname === '/api/vault/connectors')
        return [{ name: 'bitwarden', label: 'Bitwarden', available: false, detail: 'Needs a session key', config: {} }];
      if (method === 'POST' && pathname === '/api/vault/connectors/bitwarden/connect')
        return verified.then(() => ({ connector: { name: 'bitwarden', label: 'Bitwarden', available: true } }));
      return undefined;
    } });
    await ui.run(`document.getElementById('main').innerHTML = passwordsCard(); wireVaultCards('o')`);
    const row = ui.page.locator('[data-conn="bitwarden"]');
    await row.locator('.conn-secret').fill('session-key');
    await row.locator('[data-conn-connect]').click();
    await expect.poll(() => ui.calls.some((call) => call.path.startsWith('/api/vault/connectors/bitwarden/connect'))).toBe(true);
    expect(await ui.toasts()).toEqual([]);
    verify();
    await expect.poll(() => ui.toasts()).toEqual(['Bitwarden connected']);
    await ui.close();
  });
});
