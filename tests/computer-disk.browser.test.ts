import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

const e2b = { provider: 'e2b', enabled: true, credentialConfigured: true,
  limits: { cpu: 8, memoryMb: 8192, diskGb: 29, source: { cpu: 'provider', memoryMb: 'provider', diskGb: 'provider' } } };
const daytona = { provider: 'daytona', enabled: true, credentialConfigured: true,
  limits: { cpu: 4, memoryMb: 8192, diskGb: 10, source: { cpu: 'default', memoryMb: 'default', diskGb: 'default' } } };

// compute-disk item 1: the form offers what the account can give, before a machine is made.
it('caps the Computer block at the account\'s own limits, and says so on hover', async () => {
  const ui = await consolePage();
  await ui.run(`
    S.worldProviderConnections = ${JSON.stringify([e2b, daytona])};
    document.getElementById('main').innerHTML = computerBlockHtml('computer', { diskGb: 29 }, { provider: 'e2b', cpu: 2, memoryMb: 2048 });
  `);
  const block = ui.page.locator('.computer-field');
  const attr = (selector: string, name: string) => block.locator(selector).getAttribute(name);
  expect(await attr('.cf-disk', 'max')).toBe('29');
  expect(await attr('.cf-cpu', 'max')).toBe('8');
  expect(await attr('.cf-memory', 'max')).toBe('8');
  // Disk is always the machine's total; an empty field means the provider's default.
  expect(await attr('.cf-disk', 'placeholder')).toBe('22');
  expect(await block.locator('.cf-disk').evaluate((input) => input.closest('label')!.title)).toBe('This E2B account allows up to 29 GB');
  await block.locator('.cf-disk').fill('40');
  expect(await block.locator('.cf-disk').evaluate((input) => input.matches(':invalid'))).toBe(true);
  // Another provider, other limits: a documented default says it is one.
  await block.locator('.cf-provider').selectOption('daytona');
  expect(await attr('.cf-disk', 'max')).toBe('10');
  expect(await attr('.cf-disk', 'placeholder')).toBe('8');
  expect(await block.locator('.cf-disk').evaluate((input) => input.closest('label')!.title))
    .toBe('Daytona allows up to 10 GB unless its support raised the limit');
  expect(ui.errors).toEqual([]);
  await ui.close();
});

// compute-disk item 3: a compact usage indicator, details on hover.
it('shows the task computer\'s disk in use, warning near full', async () => {
  const ui = await consolePage();
  const meter = async (usage: unknown) => {
    await ui.run(`document.getElementById('main').innerHTML = diskMeter({ usage: ${JSON.stringify(usage)} })`);
    return ui.page.locator('#main .disk-meter');
  };
  let shown = await meter({ at: Date.now() - 120_000, provider: 'e2b', disk: { usedMb: 17_700, totalMb: 22_528 },
    memory: { usedMb: 900, totalMb: 2048 }, maxDiskGb: 29 });
  expect(await shown.textContent()).toBe('Disk 17/22 GB');
  expect(await shown.getAttribute('title')).toBe('17.3 of 22 GB disk used · memory 0.9 of 2 GB · measured 2 min ago. This E2B account allows up to 29 GB of disk.');
  expect(await shown.evaluate((node) => node.classList.contains('warn'))).toBe(false);
  shown = await meter({ at: Date.now(), provider: 'e2b', disk: { usedMb: 21_000, totalMb: 22_528 }, maxDiskGb: 29 });
  expect(await shown.evaluate((node) => node.classList.contains('warn'))).toBe(true);
  expect(await meter(undefined).then((node) => node.count())).toBe(0);
  expect(ui.errors).toEqual([]);
  await ui.close();
});

// compute-disk item 5: a full disk is a clear state with a one-click fix.
it('shows Out of disk with Bigger disk up to the ceiling, and explains a disabled one at it', async () => {
  const ui = await consolePage({ api: ({ method, path }) => method === 'POST' && path === '/api/tasks/t/bigger-disk'
    ? { diskGb: 29, maxDiskGb: 29, applied: ['computer'] } : { taskId: 't' } });
  const render = (totalMb: number) => ui.run(`
    window.__view = { taskId: 't', workflow: 'software-dev', stage: 'do', status: 'blocked', outOfDisk: true,
      error: 'Out of disk: this task\\'s computer filled its disk.', waitingFor: { kind: 'human', reason: 'error' },
      actions: [{ name: 'retry', kind: 'signal', label: 'Retry', enabled: true }],
      usage: { at: Date.now(), provider: 'e2b', disk: { usedMb: ${totalMb}, totalMb: ${totalMb} }, maxDiskGb: 29 } };
    document.getElementById('main').innerHTML = '<div id="tp-foot">' + taskActions(window.__view) + '</div>' + stageIndicator(window.__view, 't');
    wireActions(window.__view);
  `);
  await render(22_528);
  expect(await ui.page.locator('#main .chip').textContent()).toBe('Out of disk');
  const bigger = ui.page.getByRole('button', { name: 'Bigger disk' });
  expect(await bigger.isEnabled()).toBe(true);
  expect(await bigger.getAttribute('title')).toBe('Grow the disk from 22 to 29 GB');
  await bigger.click();
  await expect.poll(() => ui.calls.find((call) => call.path === '/api/tasks/t/bigger-disk')).toMatchObject({ method: 'POST', body: {} });
  await render(29_696);
  expect(await bigger.isDisabled()).toBe(true);
  expect(await bigger.getAttribute('title')).toBe('Already the largest disk this E2B account allows (29 GB). Free space in the terminal.');
  expect(ui.errors).toEqual([]);
  await ui.close();
});
