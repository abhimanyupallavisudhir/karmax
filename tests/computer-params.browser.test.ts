import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/** A running task's Computer in its Parameters tab: it can grow (CPU, memory,
 * disk) and change when it hibernates, but stays the same provider, experience
 * and network — those would be a different computer. */
it('lets a running task resize its computer, and nothing else about it', async () => {
  const ui = await consolePage();
  const render = (editable: string[]) => ui.run(`
    S.tasks = [{ id: 't', projectId: 'p', workflow: 'software-dev', params: { computer: { diskGb: 40 } } }];
    S.schema = [{ name: 'software-dev', params: [{ name: 'computer', type: 'computer', label: 'Computer', scopes: ['task', 'project', 'global'], bind: 'computer', mutable: 'always' }] }];
    S.paramDefaults = { computer: { provider: 'e2b', cpu: 2, memoryMb: 2048, flavor: 'headless', network: { unrestricted: true } } };
    S.worldProviderConnections = [{ provider: 'e2b', enabled: true, credentialConfigured: true }];
    document.getElementById('main').innerHTML = paramsSection({ taskId: 't', workflow: 'software-dev', stage: 'do',
      editableParams: ${JSON.stringify(editable)}, agents: {}, messages: [], participants: [] });
  `);
  await render(['computer']);
  const block = ui.page.locator('#tp-params .tp-computer .computer-field');
  const disabled = () => block.evaluate((box) => Object.fromEntries(['provider', 'cpu', 'memory', 'disk', 'flavor', 'hibernate', 'network']
    .map((key) => [key, box.querySelector(`.cf-${key}`)!.matches(':disabled')])));
  expect(await disabled()).toEqual({ provider: true, cpu: false, memory: false, disk: false, flavor: true, hibernate: false, network: true });
  await block.locator('.cf-disk').fill('50');
  expect(await ui.run(`collectParamEdits(document.getElementById('tp-params'), paramFields({ workflow: 'software-dev', taskId: 't' }))`))
    .toEqual({ computer: { provider: 'e2b', cpu: 2, memoryMb: 2048, diskGb: 50, flavor: 'headless', network: { unrestricted: true } } });
  // Once used up (past the point of no return, or finished), the whole block is frozen.
  await render([]);
  expect(Object.values(await disabled()).every(Boolean)).toBe(true);
  expect(await ui.page.locator('#tp-params .tp-computer .pf-lock').count()).toBe(1);
  expect(ui.errors).toEqual([]);
  await ui.close();
});

// pramana#3: 50 GB was saved while the task waited on a job, and nothing said
// the computer would only move once the task paused with nothing running.
it('marks a size the running computer has not reached yet', async () => {
  const ui = await consolePage();
  const render = (change: unknown) => ui.run(`
    S.tasks = [{ id: 't', projectId: 'p', workflow: 'software-dev', params: { computer: { diskGb: 50 } } }];
    S.schema = [{ name: 'software-dev', params: [{ name: 'computer', type: 'computer', label: 'Computer', scopes: ['task', 'project', 'global'], bind: 'computer', mutable: 'always' }] }];
    S.paramDefaults = { computer: { provider: 'e2b', cpu: 2, memoryMb: 2048, flavor: 'headless', network: { unrestricted: true } } };
    S.worldProviderConnections = [{ provider: 'e2b', enabled: true, credentialConfigured: true }];
    document.getElementById('main').innerHTML = paramsSection({ taskId: 't', workflow: 'software-dev', stage: 'do', status: 'waiting',
      editableParams: ['computer'], agents: {}, messages: [], participants: [], computerChange: ${JSON.stringify(change)} });
  `);
  await render({ from: { cpu: 2, memoryMb: 2048 }, to: { cpu: 2, memoryMb: 2048, diskGb: 50 } });
  const chip = ui.page.locator('#tp-params .tp-computer .computer-pending');
  expect(await chip.textContent()).toBe('Moves at next pause');
  expect(await chip.getAttribute('title'))
    .toBe('Still 2 CPU · 2 GB. Moves to 2 CPU · 2 GB · 50 GB disk when the task next pauses with nothing running.');
  await render(null);
  expect(await chip.count()).toBe(0);
  expect(ui.errors).toEqual([]);
  await ui.close();
});
