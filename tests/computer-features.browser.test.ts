import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/** The Computer block shows only what the chosen provider can do: Fly.io and
 * Hetzner have no desktop and no outbound allowlist, so those choices
 * disappear, and a block on such a provider stores headless and Full internet
 * even when the organization's default asks for more (it would be refused). */
it('shows desktop and allowlist only for providers that have them', async () => {
  const ui = await consolePage();
  await ui.run(`
    S.worldProviderConnections = [
      { provider: 'e2b', enabled: true, credentialConfigured: true, features: { desktop: true, internet: 'full', allowlist: true } },
      { provider: 'hetzner', enabled: true, credentialConfigured: true, features: { desktop: false, internet: 'full', allowlist: false } },
      { provider: 'daytona', enabled: true, credentialConfigured: true, features: { desktop: true, internet: 'basic', allowlist: false } },
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
      network: [...box.querySelectorAll('.cf-network option')].filter((option) => !hidden(option)).map((option) => (option as unknown as { value: string }).value),
      allowlist: !hidden(box.querySelector('.cf-allowlist')),
    };
  });
  expect(await shown()).toEqual({ flavor: true, network: ['full', 'basic', 'allowlist'], allowlist: true });

  await block.locator('.cf-provider').selectOption('hetzner');
  expect(await shown()).toEqual({ flavor: false, network: ['full', 'basic'], allowlist: false });
  expect(await ui.run(`computerOverride(document.querySelector('.computer-field'))`))
    .toEqual({ provider: 'hetzner', flavor: 'headless', network: { unrestricted: true } });

  // A Daytona Tier 1–2 account reaches only essential services: Basic it is.
  await block.locator('.cf-provider').selectOption('daytona');
  expect(await shown()).toEqual({ flavor: true, network: ['basic'], allowlist: false });
  expect(await ui.run(`computerOverride(document.querySelector('.computer-field'))`))
    .toEqual({ provider: 'daytona', network: { basic: true } });

  // Back on E2B, the inherited desktop and allowlist apply again.
  await block.locator('.cf-provider').selectOption('e2b');
  expect(await shown()).toEqual({ flavor: true, network: ['full', 'basic', 'allowlist'], allowlist: true });
  expect(await ui.run(`computerOverride(document.querySelector('.computer-field'))`)).toEqual({});
  // A choice made by hand comes back too.
  await block.locator('.cf-network').selectOption('basic');
  await block.locator('.cf-provider').selectOption('daytona');
  await block.locator('.cf-provider').selectOption('hetzner');
  expect(await block.locator('.cf-network').inputValue()).toBe('basic');
  expect(ui.errors).toEqual([]);
  await ui.close();
});
