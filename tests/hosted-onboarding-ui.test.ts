import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, signedIn, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

type Status = Record<string, any>;
const status = (overrides: Status = {}): Status => ({
  organizationId: 'o', visible: true, display: 'expanded', complete: false, replay: false,
  completedRequired: 2, totalRequired: 4,
  steps: { github: { complete: true }, agentLogin: { complete: false },
    compute: { complete: true, managed: false, own: true }, optional: {}, project: { complete: false } },
  ...overrides,
});

/** A hosted console on its organization page, answering onboarding reads and writes with `onboarding`. */
async function hosted(options: { hosted?: boolean; onboarding?: (call: ApiCall) => Status | undefined;
  viewport?: { width: number; height: number } } = {}) {
  const ui = await consolePage({ path: '/org/workspace', viewport: options.viewport, api: signedIn((call) => {
    if (call.path.startsWith('/api/user/onboarding')) return options.onboarding?.(call) ?? status();
    return undefined;
  }, { meta: { hosted: options.hosted ?? true } }) });
  await ui.run('boot()');
  await ui.page.locator('#rail').waitFor();
  return ui;
}
const guide = (ui: Awaited<ReturnType<typeof consolePage>>) => ui.page.locator('#hosted-onboarding');
const writes = (ui: Awaited<ReturnType<typeof consolePage>>) =>
  ui.calls.filter((call) => call.method === 'PUT' && call.path.startsWith('/api/user/onboarding')).map((call) => call.body);

describe('hosted onboarding UI', () => {
  it('renders the required sequence, with the optional items visibly non-blocking', async () => {
    const ui = await hosted();
    const steps = guide(ui).locator('.onboarding-step');
    await steps.first().waitFor();
    // GitHub is required; only apps and cards are optional.
    expect(await steps.locator('.onboarding-step-title').allInnerTexts()).toEqual([
      'Add agent logins', 'Get computers for your agents', 'Create your first project',
      'Connect GitHub', 'Connect apps and payment cards\nOptional', // sentence case, like every label
    ]);
    expect(await steps.nth(4).innerText()).toContain('This never blocks setup.');
    expect(await guide(ui).locator('.onboarding-foot').innerText()).toContain('Optional items do not count toward completion.');
    // Completed steps show a tick instead of their number.
    expect(await steps.locator('.onboarding-check').allInnerTexts()).toEqual(['1', '✓', '3', '✓', '5']);
    await ui.close();
  });

  it('offers a paid plan or the organization’s own compute as two ways to finish one required step', async () => {
    let compute = { complete: false, managed: false, own: false };
    const ui = await hosted({ onboarding: () => status({ steps: { ...status().steps, compute } }) });
    const step = guide(ui).locator('.onboarding-step').nth(1);
    await step.waitFor();
    expect(await step.locator('.onboarding-optional').count()).toBe(0); // required, neither option is "optional"
    const options = step.locator('.onboarding-option');
    expect(await options.locator('b').allInnerTexts()).toEqual(['Buy a paid plan', 'Connect your own compute']);
    expect((await step.locator('.onboarding-or').innerText()).toLowerCase()).toBe('or');
    expect(await options.locator('a.btn').evaluateAll((links) => links.map((link) => [link.textContent?.trim(), link.getAttribute('href')])))
      .toEqual([['View plans', '/org/settings#settings-plan'], ['Connect', '/org/settings#settings-computers']]);
    expect(await step.locator('.onboarding-check').innerText()).toBe('2');

    // Either option alone completes the step; the one taken is ticked and offers management.
    compute = { complete: true, managed: true, own: false };
    await expect.poll(() => step.locator('.onboarding-check').innerText(), { timeout: 8_000 }).toBe('✓');
    expect(await options.evaluateAll((rows) => rows.map((row) => row.classList.contains('complete')))).toEqual([true, false]);
    expect(await options.locator('a.btn').allInnerTexts()).toEqual(['Manage plan', 'Connect']);
    await ui.close();
  });

  it('heads the steps with the free trial, which finishes none of them', async () => {
    const endsAt = new Date(2026, 10, 27, 12).getTime();
    let trial: Status | undefined = { creditMicros: 5_000_000, endsAt, agents: true };
    const ui = await hosted({ onboarding: () => status({ completedRequired: 1, ...(trial ? { trial } : {}), steps: { ...status().steps,
      compute: { complete: false, managed: false, own: false } } }) });
    await guide(ui).locator('.onboarding-trial').waitFor();
    expect(await guide(ui).locator('.onboarding-trial').innerText()).toBe('Free trial: $5 of compute and agents included until Nov 27.');
    expect(await guide(ui).locator('.onboarding-intro').innerText()).toBe('For the full experience:');
    const step = guide(ui).locator('.onboarding-step').nth(1);
    expect(await step.locator('.onboarding-check').innerText()).toBe('2');
    expect(await step.locator('.onboarding-option.complete').count()).toBe(0);
    expect(await step.locator('.onboarding-option small').first().innerText()).toMatch(/^Includes .+’s computers$/) // no trial date on the plan;
    // Without the included model, only compute is included; without a trial, the usual intro.
    trial = { creditMicros: 5_000_000, endsAt, agents: false };
    await expect.poll(() => guide(ui).locator('.onboarding-trial').innerText(), { timeout: 8_000 }).toBe('Free trial: $5 of compute included until Nov 27.');
    trial = undefined;
    await expect.poll(() => guide(ui).locator('.onboarding-trial').count(), { timeout: 8_000 }).toBe(0);
    expect(await guide(ui).locator('.onboarding-intro').innerText()).toMatch(/^A few real connections/);
    await ui.close();
  });

  it('links each step to its real settings section and opens the project flow in place', async () => {
    const ui = await hosted();
    const actions = await guide(ui).locator('.onboarding-step a.btn').evaluateAll((links) =>
      links.map((link) => [link.textContent?.trim(), link.getAttribute('href')]));
    expect(actions.map(([, href]) => href)).toEqual(['/org/settings#settings-agents', '/org/settings#settings-plan',
      '/org/settings#settings-computers', '/org/settings#settings-code', '/org/settings#settings-payments']);
    expect(actions[2]![0]).toBe('Manage'); // a completed option offers management, not setup
    await guide(ui).locator('.onboarding-step a[href$="#settings-agents"]').click();
    await expect.poll(() => ui.run<string>('location.pathname + location.hash')).toBe('/org/settings#settings-agents');
    await guide(ui).locator('#onboarding-new-project').click();
    await ui.page.locator('#modal-root .new-project-dialog').waitFor();
    await ui.close();
  });

  it('gives the optional apps-and-cards step a single action', async () => {
    const ui = await hosted();
    const optional = guide(ui).locator('.onboarding-step').nth(4);
    const actions = optional.locator('.btn');
    expect(await actions.count()).toBe(1);
    expect(await actions.getAttribute('href')).toBe('/org/settings#settings-payments');
    expect(await optional.locator('.onboarding-actions').count()).toBe(0);
    await ui.close();
  });

  it('shows the newly created organization’s onboarding as soon as it is created', async () => {
    let created = false;
    const ui = await consolePage({ path: '/org/workspace', api: signedIn((call) => {
      if (call.method === 'POST' && call.path === '/api/organizations') { created = true; return { id: 'n', name: 'New', slug: 'new' }; }
      if (call.method === 'GET' && call.path === '/api/organizations')
        return [{ id: 'o', name: 'Organization', slug: 'org' }, ...(created ? [{ id: 'n', name: 'New', slug: 'new' }] : [])];
      if (call.path.startsWith('/api/user/onboarding'))
        return call.path.includes('organizationId=n') ? status({ organizationId: 'n' }) : status({ visible: false });
      return undefined;
    }, { meta: { hosted: true } }) });
    await ui.run('boot()');
    await ui.page.locator('#rail').waitFor();
    expect(await guide(ui).isHidden()).toBe(true);
    // With its autonomy switch the name prompt answers { value, checked }.
    await ui.run(`promptText = async () => ({ value: 'New', checked: false }); createOrganization()`);
    // Visible before the four-second poll could have fetched it.
    await guide(ui).locator('.onboarding-card').waitFor({ timeout: 2_000 });
    expect(await guide(ui).locator('#onboarding-title').textContent()).toContain('Set up');
    await ui.close();
  });

  it('is hosted-only, server-persisted, live-refreshed, minimizable and accessible', async () => {
    const selfHosted = await hosted({ hosted: false });
    expect(await guide(selfHosted).isHidden()).toBe(true);
    expect(selfHosted.calls.some((call) => call.path.startsWith('/api/user/onboarding'))).toBe(false);
    await selfHosted.close();

    let display = 'expanded';
    let completed = 1;
    const ui = await hosted({ onboarding: (call) => {
      if (call.method === 'PUT') display = call.body.display;
      return status({ display, visible: display !== 'closed', completedRequired: completed });
    } });
    const progress = guide(ui).getByRole('progressbar');
    expect(await progress.getAttribute('aria-valuenow')).toBe('1');
    expect(await progress.getAttribute('aria-label')).toBe('1 of 4 required setup steps complete');
    // Progress made elsewhere (an agent login added in another tab) shows up without a reload.
    completed = 2;
    await expect.poll(() => progress.getAttribute('aria-valuenow'), { timeout: 8_000 }).toBe('2');

    await guide(ui).getByRole('button', { name: 'Minimize setup guide' }).click();
    const reopen = guide(ui).getByRole('button', { name: 'Open setup guide' });
    await reopen.waitFor();
    expect(await reopen.innerText()).toContain('2 of 4 required steps');
    await reopen.click();
    await guide(ui).getByRole('button', { name: 'Close setup guide' }).click();
    await expect.poll(() => guide(ui).isHidden()).toBe(true);
    expect(writes(ui)).toEqual([{ display: 'minimized', finishReplay: false }, { display: 'expanded', finishReplay: false },
      { display: 'closed', finishReplay: false }]);
    await ui.close();
  });

  it('keeps clear of a narrow screen\'s edges', async () => {
    const offset = async (width: number) => {
      const ui = await hosted({ viewport: { width, height: 800 } });
      const box = await guide(ui).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { right: (globalThis as any).innerWidth - rect.right, width: rect.width };
      });
      await ui.close();
      return box;
    };
    expect(await offset(1200)).toEqual({ right: 22, width: 390 });
    const narrow = await offset(360);
    expect(narrow.right).toBe(14);
    expect(narrow.width).toBe(332); // never wider than the screen minus its margins
  });

  it('keeps window controls together in the header, not a Minimize button in the footer', async () => {
    const ui = await hosted({ onboarding: () => status({ replay: true, completedRequired: 4 }) });
    const controls = await guide(ui).locator('.onboarding-head button').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label')));
    expect(controls).toEqual(['Minimize setup guide', 'Close setup guide']);
    expect(await guide(ui).locator('.onboarding-head button svg').count()).toBe(2);
    const foot = guide(ui).locator('.onboarding-foot');
    expect(await foot.getByRole('button').allInnerTexts()).toEqual(['Done']);
    await foot.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => writes(ui)).toEqual([{ display: 'expanded', finishReplay: true }]);
    await ui.close();
  });
});
