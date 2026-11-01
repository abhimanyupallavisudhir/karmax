import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// Provider "Any" (wiki features/compute-routing): the Computer block offers it
// first, its sizes reach as far as some account the organization can use,
// what it reaches is one hover away, and a region is asked only of it.
// Rendered into a container of its own, which the console's routing never redraws.
const FIXTURE = `window.fixture = () => document.getElementById('fixture')
  || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'fixture' }));`;
const CONNECTIONS = `[
  { provider: 'e2b', enabled: true, credentialConfigured: true, status: 'ready',
    limits: { cpu: 8, memoryMb: 8192, diskGb: 29, source: {} }, features: { desktop: true, allowlist: true } },
  { provider: 'hetzner', enabled: true, credentialConfigured: true, managed: true,
    limits: { cpu: 4, memoryMb: 8192, diskGb: 200, source: {} }, features: { desktop: false, allowlist: false } },
  { provider: 'aws', enabled: true, credentialConfigured: true, managed: true,
    limits: { cpu: 16, memoryMb: 65536, diskGb: 2048, source: {} }, features: { desktop: false, allowlist: false } },
]`;

it('offers Any first, with what it reaches, its largest sizes and a region', async () => {
  const ui = await consolePage();
  await ui.run(FIXTURE);
  await ui.run(`
    S.meta = { ...(S.meta || {}), hosted: true };
    S.worldProviderConnections = ${CONNECTIONS};
    fixture().innerHTML = computerBlockHtml('computer', undefined, { provider: 'any', flavor: 'headless', network: { unrestricted: true } });
  `);
  const block = ui.page.locator('#fixture .computer-field');
  expect(await block.locator('.cf-provider option').allTextContents()).toEqual(['Any', 'E2B', 'Hetzner', 'AWS']);
  expect(await block.locator('.cf-provider').inputValue()).toBe('any');
  // What Any reaches is one hover away, the organization's own account first.
  const reach = block.locator('.cf-reach');
  expect(await reach.isVisible()).toBe(true);
  expect(await reach.locator('[title]').getAttribute('title'))
    .toBe('Any: E2B (yours), Hetzner, AWS. Runs on the first that fits and has room: your own accounts first, then the cheapest. A full one gives way to the next.');
  // Sizes reach the largest any account allows, and say which.
  expect(await block.locator('.cf-cpu').getAttribute('max')).toBe('16');
  expect(await block.locator('.cf-disk').getAttribute('max')).toBe('2048');
  expect(await block.locator('.cf-disk').evaluate((input) => input.closest('label')!.title)).toBe('Up to 2048 GB (AWS)');
  // Desktop is there because E2B has one; the region only for Any.
  await block.locator('summary').click();
  expect(await block.locator('.cf-flavor').isVisible()).toBe(true);
  expect(await block.locator('.cf-region').isVisible()).toBe(true);
  await block.locator('.cf-region').selectOption('eu');
  await block.locator('.cf-disk').fill('500');
  expect(await ui.run(`computerOverride(document.querySelector('#fixture .computer-field'))`)).toEqual({ diskGb: 500, region: 'eu' });

  // A named provider pins it: no reach, no region, its own ceiling.
  await block.locator('.cf-provider').selectOption('e2b');
  expect(await reach.isVisible()).toBe(false);
  expect(await block.locator('.cf-region').isVisible()).toBe(false);
  expect(await block.locator('.cf-disk').getAttribute('max')).toBe('29');
  expect(await ui.run(`computerOverride(document.querySelector('#fixture .computer-field'))`)).toEqual({ provider: 'e2b', diskGb: 500 });
  expect(await ui.run(`computerSummary({ provider: 'any', cpu: 4, region: 'eu' })`)).toBe('Any · 4 CPU · EU');
  expect(ui.errors).toEqual([]);
  await ui.close();
});

it('shows where a task runs, and Settings → Computers what Any reaches', async () => {
  const ui = await consolePage();
  await ui.run(FIXTURE);
  const chip = await ui.run<{ text: string; title: string }>(`(() => {
    fixture().innerHTML = runsOnChip({ runsOn: { provider: 'aws', managed: true,
      machine: { cpu: 2, memoryMb: 4096, diskGb: 100 }, routed: 'cheapest that fits; Hetzner was full' } });
    const el = document.querySelector('.runs-on');
    return { text: el.textContent, title: el.title };
  })()`);
  expect(chip.text).toBe('AWS · 2 CPU · 4 GB · 100 GB disk');
  expect(chip.title).toMatch(/^Runs on .*’s AWS, from this organization’s compute\. Chosen by Any: cheapest that fits; Hetzner was full\.$/);
  expect(await ui.run(`runsOnChip({})`)).toBe('');

  const row = await ui.run(`(() => {
    fixture().innerHTML = computersMarkup(${CONNECTIONS});
    const any = document.querySelector('.computer-any');
    return { first: document.querySelector('.computer-providers').firstElementChild === any, reach: any.querySelector('.computer-reach').textContent,
      limits: any.querySelector('.computer-limits').textContent };
  })()`);
  expect(row).toEqual({ first: true, reach: 'E2B (yours), Hetzner, AWS', limits: '≤ 16 CPU · 64 GB · 2048 GB disk' });
  expect(ui.errors).toEqual([]);
  await ui.close();
});

// An organization moving to managed compute (wiki features/managed-compute):
// its own account, switched off, keeps its row; what that means is one hover away.
it('says a switched-off own account leaves new computers to tavya\'s', async () => {
  const ui = await consolePage();
  await ui.run(FIXTURE);
  const row = await ui.run<{ chip: string; title: string; reach: string }>(`(() => {
    fixture().innerHTML = computersMarkup([
      { provider: 'hetzner', enabled: false, credentialConfigured: true, status: 'ready', limits: { cpu: 16, source: {} } },
      { provider: 'hetzner', enabled: true, credentialConfigured: true, managed: true, limits: { cpu: 10, source: {} } },
    ]);
    const chip = document.querySelector('.computer-provider[data-provider="hetzner"] .chip');
    return { chip: chip.textContent, title: chip.title, reach: document.querySelector('.computer-reach').textContent };
  })()`);
  expect(row.chip).toBe('Off');
  expect(row.title).toMatch(/^New computers run on .*’s Hetzner account, charged to this organization’s monthly compute\. Ones already on yours stay there until their tasks end\.$/);
  expect(row.reach).toBe('Hetzner');
  expect(ui.errors).toEqual([]);
  await ui.close();
});
