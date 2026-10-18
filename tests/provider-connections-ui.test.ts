import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn, type ApiHandler } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

const month = Date.UTC(2026, 8, 1);

/** Organization settings, open at the section holding `selector`. */
async function organization(selector: string, api: ApiHandler, hostLocal = true) {
  const ui = await consolePage({ path: '/org/settings', api: signedIn(async (call) => (await api(call)) ?? emptySettings(call),
    { meta: { hostLocal } }) });
  await ui.run('boot()');
  await ui.page.locator(selector).first().waitFor({ state: 'attached' });
  const id = await ui.page.locator(selector).first().evaluate((element) => element.closest('section.settings-pane')!.dataset.pane);
  await ui.page.locator(`.settings-nav a[href="#${id}"]`).click();
  return ui;
}
const usageApi = (usage: Record<string, unknown>): ApiHandler => ({ path }) => path === '/api/organizations/o/usage'
  ? { costMicros: 1_750_000, incurredCostMicros: 1_000_000, estimatedCostMicros: 750_000, activeReservationsMicros: 250_000,
    events: 3, from: month, ...usage }
  : undefined;

describe('organization Computers and usage UI', () => {
  const connected = [{ provider: 'e2b', status: 'ready', enabled: true, credentialConfigured: true, config: { template: 'my-template' } },
    { provider: 'daytona', status: 'error', enabled: true, credentialConfigured: true, lastError: 'Daytona connection failed: 401', config: {} }];

  it('lists each cloud computer with its state, an edit dialog and a test', async () => {
    const ui = await organization('#org-computers .computer-provider', ({ method, path }) => path === '/api/organizations/o/world-providers'
      ? connected : method === 'POST' && path.endsWith('/test') ? {} : undefined);
    const rows = ui.page.locator('#org-computers .computer-provider');
    expect(await rows.evaluateAll((elements) => elements.map((row) => [row.querySelector('b')!.textContent, row.querySelector('.chip')!.textContent])))
      .toEqual([['E2B', 'connected'], ['Daytona', 'failing'], ['Fly.io', 'not connected'], ['Hetzner', 'not connected']]);
    expect(await rows.nth(1).locator('.chip').getAttribute('title')).toBe('Daytona connection failed: 401');
    await rows.nth(0).getByRole('button', { name: 'Test' }).click();
    await expect.poll(() => ui.calls.some((call) => call.method === 'POST' && call.path === '/api/organizations/o/world-providers/e2b/test')).toBe(true);
    // The dialog: a key that stays unless replaced, and the provider templates under Advanced.
    await rows.nth(0).getByRole('button', { name: 'Edit E2B' }).click();
    const dialog = ui.page.locator('.computer-dialog');
    expect(await dialog.locator('.computer-key').getAttribute('placeholder')).toBe('Blank to leave unchanged');
    expect(await dialog.locator('.computer-advanced').evaluate((element) => (element as unknown as { open: boolean }).open)).toBe(false);
    expect(await dialog.locator('[data-config="template"]').inputValue()).toBe('my-template');
    // No guardrails, runner pools or execution policy remain on this page.
    expect(await ui.page.locator('#usage-policy-save, #runner-create, #org-execution-save').count()).toBe(0);
    await ui.close();
  });

  it('connects a provider: saves the key, then verifies it', async () => {
    const ui = await organization('#org-computers .computer-provider', ({ method, path }) => method === 'PUT' || method === 'POST' ? {} : undefined);
    const daytona = ui.page.locator('#org-computers [data-provider="daytona"]');
    expect(await daytona.locator('.chip').textContent()).toBe('not connected');
    await daytona.getByRole('button', { name: 'Connect' }).click();
    const dialog = ui.page.locator('.computer-dialog');
    expect(await dialog.locator('.computer-key').getAttribute('placeholder')).toBe('Required');
    await dialog.locator('.computer-key').fill('dtn-key');
    await dialog.locator('.computer-advanced > summary').click();
    await dialog.locator('[data-config="snapshot"]').fill('big-snapshot');
    await dialog.getByRole('button', { name: 'Connect' }).click();
    await expect.poll(() => ui.calls.filter((call) => call.path.startsWith('/api/organizations/o/world-providers/daytona')).map((call) => call.method))
      .toEqual(['PUT', 'POST']);
    expect(ui.calls.find((call) => call.method === 'PUT')!.body).toMatchObject({ apiKey: 'dtn-key', config: { snapshot: 'big-snapshot', image: '' } });
    await ui.close();
  });

  it('connects a VM provider with its region', async () => {
    const ui = await organization('#org-computers .computer-provider', ({ method }) => method === 'PUT' || method === 'POST' ? {} : undefined);
    await ui.page.locator('#org-computers [data-provider="fly"] .computer-connect').click();
    const dialog = ui.page.locator('.computer-dialog');
    await dialog.locator('.computer-key').fill('FlyV1 fm2_key');
    await dialog.locator('.computer-advanced > summary').click();
    expect(await dialog.locator('[data-config]').evaluateAll((inputs) => inputs.map((input) => input.getAttribute('data-config'))))
      .toEqual(['region', 'organization', 'image']);
    await dialog.locator('[data-config="region"]').fill('ams');
    await dialog.getByRole('button', { name: 'Connect' }).click();
    await expect.poll(() => ui.calls.filter((call) => call.path.startsWith('/api/organizations/o/world-providers/fly')).map((call) => call.method))
      .toEqual(['PUT', 'POST']);
    expect(ui.calls.find((call) => call.method === 'PUT')!.body).toMatchObject({ apiKey: 'FlyV1 fm2_key', config: { region: 'ams' } });
    await ui.close();
  });

  // UI-43: a rejected save changed nothing, so the dialog keeps what was typed.
  it('keeps the typed key and settings when saving a provider fails', async () => {
    for (const [provider, field, value] of [['e2b', 'template', 'my-template'], ['daytona', 'snapshot', 'my-snapshot']] as const) {
      const ui = await organization('#org-computers .computer-provider', ({ method, path }) => method === 'PUT'
        && path === `/api/organizations/o/world-providers/${provider}` ? { status: 400, json: { error: 'API key rejected by provider' } } : undefined);
      await ui.page.locator(`#org-computers [data-provider="${provider}"] .computer-connect`).click();
      const dialog = ui.page.locator('.computer-dialog');
      await dialog.locator('.computer-key').fill('sk-typed-key');
      await dialog.locator('.computer-advanced > summary').click();
      await dialog.locator(`[data-config="${field}"]`).fill(value);
      await dialog.locator('.computer-save').click();
      await expect.poll(() => ui.toasts()).toContain('API key rejected by provider');
      expect(await dialog.locator('.computer-key').inputValue()).toBe('sk-typed-key');
      expect(await dialog.locator(`[data-config="${field}"]`).inputValue()).toBe(value);
      await ui.close();
    }
  });

  // compute-disk item 1: each connection's real limits, and Advanced for what its API cannot tell.
  it('shows each connection\'s limits on its row, and lets Advanced set them', async () => {
    const limited = [{ ...connected[0], limits: { cpu: 8, memoryMb: 8192, diskGb: 29, checkedAt: Date.UTC(2026, 9, 10),
      source: { cpu: 'provider', memoryMb: 'provider', diskGb: 'provider' } } },
    { ...connected[1], config: { limits: { diskGb: 50 } }, limits: { cpu: 4, memoryMb: 8192, diskGb: 30,
      source: { cpu: 'default', memoryMb: 'default', diskGb: 'provider' } } }];
    const ui = await organization('#org-computers .computer-provider', ({ method, path }) => path === '/api/organizations/o/world-providers'
      ? limited : method === 'PUT' || method === 'POST' ? {} : undefined);
    const rows = ui.page.locator('#org-computers .computer-provider');
    expect(await rows.nth(0).locator('.computer-limits').textContent()).toBe('≤ 8 CPU · 8 GB · 29 GB disk');
    expect(await rows.nth(1).locator('.computer-limits').textContent()).toBe('≤ 4 CPU · 8 GB · 30 GB disk');
    await rows.nth(1).getByRole('button', { name: 'Edit Daytona' }).click();
    const dialog = ui.page.locator('.computer-dialog');
    await dialog.locator('.computer-advanced > summary').click();
    // What a person entered shows as entered; what the provider said is the placeholder.
    expect(await dialog.locator('[data-limit="diskGb"]').inputValue()).toBe('50');
    expect(await dialog.locator('[data-limit="cpu"]').getAttribute('placeholder')).toBe('4');
    await dialog.locator('[data-limit="cpu"]').fill('8');
    await dialog.locator('[data-limit="memoryMb"]').fill('16');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => ui.calls.find((call) => call.method === 'PUT')?.body?.config?.limits).toEqual({ cpu: 8, memoryMb: 16_384, diskGb: 50 });
    await ui.close();
  });

  // Plan & billing shows what the plan includes and uses; an organization's own
  // provider bill is not a plan fact (it read "Usage $1.75" and confused owners).
  it('shows the plan\'s limits under Plan & billing, not the organization\'s own provider bill', async () => {
    const entitlements = { deployment: 'hosted', plan: 'free', planName: 'Free', currentMonthlyPriceCents: 0, maxMembers: 1,
      currentMemberCount: 1, maxActiveAgentRuns: 5, storageQuotaBytes: 5 * 1024 ** 3, includedStorageBytes: 5 * 1024 ** 3,
      storageUsedBytes: 1024 ** 3, storagePackBytes: 100 * 1024 ** 3, compute: null };
    const ui = await organization('#org-plan .plan-limits', (call) => call.path === '/api/organizations/o/entitlements' ? entitlements : usageApi({})(call));
    expect(await ui.page.locator('#org-plan .plan-limits').evaluate((element) => element.closest('.settings-pane')!.getAttribute('data-pane'))).toBe('settings-plan');
    expect(await ui.page.locator('#org-plan .plan-limits').innerText()).toMatch(/Storage[\s\S]*1 GB\s+of 5 GB/);
    expect(await ui.page.locator('#org-usage').count()).toBe(0);
    expect(await ui.page.locator('#org-plan').innerText()).not.toContain('$1.75');
    expect(ui.calls.some((call) => call.path === '/api/organizations/o/usage')).toBe(false);
    await ui.close();
  });
});
