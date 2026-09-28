import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn, type ApiHandler } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

type Console = Awaited<ReturnType<typeof consolePage>>;
const month = Date.UTC(2026, 8, 1);
const policy = { maxActiveWorlds: 4, effectiveMaxActiveAgentTurns: 4, maxAgentStartsPerMinute: 10, maxRemoteStartsPerMinute: 10 };

/** Organization settings, open at the section holding `selector`. */
async function organization(selector: string, api: ApiHandler, hostLocal = true) {
  const ui = await consolePage({ path: '/org/settings', api: signedIn(async (call) => (await api(call)) ?? emptySettings(call),
    { meta: { hostLocal } }) });
  await ui.run('boot()');
  await ui.page.locator(selector).first().waitFor({ state: 'attached' });
  const id = await ui.page.locator(selector).first().evaluate((element) => (element.closest('section.settings-pane') as HTMLElement).dataset.pane);
  await ui.page.locator(`.settings-nav a[href="#${id}"]`).click();
  return ui;
}
const usageApi = (usage: Record<string, unknown>): ApiHandler => ({ path }) => path === '/api/organizations/o/usage'
  ? { costMicros: 1_750_000, incurredCostMicros: 1_000_000, estimatedCostMicros: 750_000, activeReservationsMicros: 250_000,
    events: 3, from: month, ...usage }
  : path === '/api/organizations/o/usage-policy' ? policy
  : path === '/api/organizations/o/runner-pools' ? [{ id: 'pool', name: 'Pool', provider: 'e2b', capacity: { activeWorlds: 20 } }]
  : undefined;
const usageText = async (ui: Console) => (await ui.page.locator('#org-usage').textContent())!;

describe('organization provider connection UI', () => {
  it('shows the effective built-in E2B headless-template default', async () => {
    const empty = await organization('#org-providers .provider-template', () => undefined);
    const template = empty.page.locator('#org-providers .provider-template');
    expect([await template.inputValue(), await template.getAttribute('placeholder')]).toEqual(['', 'codex']);
    await empty.close();
    const custom = await organization('#org-providers .provider-template', ({ path }) => path === '/api/organizations/o/world-providers'
      ? [{ provider: 'e2b', status: 'connected', enabled: true, config: { template: 'my-template' } }] : undefined);
    expect(await custom.page.locator('#org-providers .provider-template').inputValue()).toBe('my-template');
    await custom.close();
  });

  it('distinguishes incurred, estimated, and reserved usage with monthly reconciliation coverage', async () => {
    const ui = await organization('#org-usage .stat', usageApi({}));
    await ui.page.locator('#org-usage .stat').waitFor();
    expect(await usageText(ui)).toContain('Metered + estimated usage · This month · 3 ledger events');
    expect(await usageText(ui)).toContain('Incurred $1.00 · estimated $0.75 · active managed reservations $0.25');
    await ui.close();

    // Provider reconciliation that only began mid-month narrows the period it vouches for.
    const late = await organization('#org-usage .stat', usageApi({ sync: [{ provider: 'e2b', status: 'ok', at: Date.now(),
      coverageFrom: Date.UTC(2026, 8, 15, 12) }] }));
    await late.page.locator('#org-usage .stat').waitFor();
    expect(await usageText(late)).toMatch(/Metered \+ estimated usage · Since Sep 1[45] · 3 ledger events · synced /);
    await late.close();
    const gap = await organization('#org-usage .stat', usageApi({ sync: [{ provider: 'e2b', status: 'error', gap: true, at: Date.now() }] }));
    await gap.page.locator('#org-usage .stat').waitFor();
    expect(await usageText(gap)).toContain('Metered + estimated usage · Incomplete history · 3 ledger events · sync unavailable');
    await gap.close();
  });

  it('derives hosted remote-world capacity from the plan instead of exposing a second limit', async () => {
    const saved = (ui: Console) => ui.calls.filter((call) => call.method === 'PUT' && call.path === '/api/organizations/o/usage-policy')
      .map((call) => call.body.policy);
    const save = async (ui: Console) => {
      await ui.page.locator('#org-usage summary').click();
      await ui.page.locator('#usage-policy-save').click();
      await expect.poll(() => saved(ui)).toHaveLength(1);
    };
    const withSave: ApiHandler = (call) => call.method === 'PUT' ? {} : usageApi({})(call);

    const hosted = await organization('#org-usage .stat', withSave, false);
    expect(await hosted.page.locator('#org-runners [data-runner="pool"] .chip').textContent()).toBe('e2b · concurrency capacity 4');
    expect(await usageText(hosted)).toContain('Concurrent remote worlds');
    expect(await usageText(hosted)).toContain('Same as agent concurrency: 4');
    expect(await hosted.page.locator('#usage-world-active').count()).toBe(0);
    await save(hosted);
    expect(saved(hosted)[0]).not.toHaveProperty('maxActiveWorlds');
    await hosted.close();

    // A host-local installation owns its machine, so it sets the world limit itself.
    const local = await organization('#org-usage .stat', withSave, true);
    expect(await local.page.locator('#org-runners [data-runner="pool"] .chip').textContent()).toBe('e2b · 20 worlds');
    await local.page.locator('#org-usage summary').click();
    await local.page.locator('#usage-world-active').fill('6');
    await local.page.locator('#usage-policy-save').click();
    await expect.poll(() => saved(local)).toHaveLength(1);
    expect(saved(local)[0]).toMatchObject({ maxActiveWorlds: 6 });
    await local.close();
  });
});
