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
  const shown = () => block.evaluate((box) => ({
    flavor: !box.querySelector('.cf-flavor')!.closest('label')!.hidden,
    network: !box.querySelector('.cf-network')!.closest('label')!.hidden,
    allowlist: !(box.querySelector('.cf-allowlist') as HTMLElement).hidden,
  }));
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
