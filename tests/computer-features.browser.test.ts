import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/** The Computer block shows only what the chosen provider can do: Fly.io and
 * Hetzner have no desktop and no outbound allowlist, so those rows disappear,
 * and a block on such a provider stores headless and normal internet even when
 * the organization's default asks for more (it would be refused at creation). */
it('shows desktop and allowlist only for providers that have them', async () => {
  const ui = await consolePage();
  await ui.run(`
    S.worldProviderConnections = [
      { provider: 'e2b', enabled: true, credentialConfigured: true, features: { desktop: true, allowlist: true } },
      { provider: 'hetzner', enabled: true, credentialConfigured: true, features: { desktop: false, allowlist: false } },
    ];
    document.getElementById('main').innerHTML = computerBlockHtml('computer', undefined,
      { provider: 'e2b', flavor: 'desktop', network: { unrestricted: false, allowDomains: ['pypi.org'] } });
  `);
  const block = ui.page.locator('.computer-field');
  await block.locator('summary').click();
  const shown = () => block.evaluate((box) => {
    const hidden = (element: unknown) => (element as { hidden: boolean }).hidden;
    return {
      flavor: !hidden(box.querySelector('.cf-flavor')!.closest('label')),
      network: !hidden(box.querySelector('.cf-network')!.closest('label')),
      allowlist: !hidden(box.querySelector('.cf-allowlist')),
    };
  });
  expect(await shown()).toEqual({ flavor: true, network: true, allowlist: true });

  await block.locator('.cf-provider').selectOption('hetzner');
  expect(await shown()).toEqual({ flavor: false, network: false, allowlist: false });
  expect(await ui.run(`computerOverride(document.querySelector('.computer-field'))`))
    .toEqual({ provider: 'hetzner', flavor: 'headless', network: { unrestricted: true } });

  // Back on E2B, the inherited desktop and allowlist apply again.
  await block.locator('.cf-provider').selectOption('e2b');
  expect(await shown()).toEqual({ flavor: true, network: true, allowlist: true });
  expect(await ui.run(`computerOverride(document.querySelector('.computer-field'))`)).toEqual({});
  expect(ui.errors).toEqual([]);
  await ui.close();
});

/** Outbound network has three choices (owner, 2026-10-29): full internet,
 * "basic internet is enough" — offered only where it changes where Any may run
 * the task, i.e. when Any reaches an account with basic internet (Daytona's
 * Tiers 1–2) — and an allowlist. Settings marks such an account. */
it('offers "Basic internet is enough" when Any reaches a basic-internet account, and marks that account', async () => {
  const ui = await consolePage();
  await ui.run(`
    S.meta = { ...S.meta, hosted: true };
    S.worldProviderConnections = [
      { provider: 'hetzner', enabled: true, credentialConfigured: true, managed: true, features: { desktop: false, allowlist: false, internet: 'full' } },
      { provider: 'daytona', enabled: true, credentialConfigured: true, managed: true, features: { desktop: true, allowlist: false, internet: 'basic' } },
    ];
    document.getElementById('main').innerHTML = computerBlockHtml('computer', undefined, { provider: 'any', flavor: 'headless' })
      + '<div id="computers">' + computersMarkup(S.worldProviderConnections) + '</div>';
  `);
  const block = ui.page.locator('.computer-field');
  await block.locator('summary').click();
  const offered = () => block.evaluate((box) => {
    const select = box.querySelector('.cf-network') as unknown as { closest(s: string): { hidden: boolean }; options: ArrayLike<{ hidden: boolean; textContent: string | null }> };
    return { shown: !select.closest('label')!.hidden, options: Array.from(select.options).filter((option) => !option.hidden).map((option) => option.textContent) };
  });
  expect(await offered()).toEqual({ shown: true, options: ['Full internet', 'Basic internet is enough'] });
  await block.locator('.cf-network').selectOption('basic');
  expect(await ui.run(`computerOverride(document.querySelector('.computer-field'))`)).toEqual({ network: { unrestricted: true, basic: true } });
  expect(await ui.page.locator('#computers [data-provider="daytona"] .computer-basic').textContent()).toBe('Basic internet');
  expect(await ui.page.locator('#computers [data-provider="hetzner"] .computer-basic').count()).toBe(0);

  // A named provider gives the internet its account has: nothing to choose.
  await block.locator('.cf-provider').selectOption('hetzner');
  expect((await offered()).shown).toBe(false);
  expect(await ui.run(`computerOverride(document.querySelector('.computer-field'))`))
    .toEqual({ provider: 'hetzner' });
  expect(ui.errors).toEqual([]);
  await ui.close();
});
