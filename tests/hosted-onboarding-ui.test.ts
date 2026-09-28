import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, signedIn, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

type Status = Record<string, any>;
const status = (overrides: Status = {}): Status => ({
  organizationId: 'o', visible: true, display: 'expanded', complete: false, replay: false,
  completedRequired: 2, totalRequired: 4,
  steps: { github: { complete: true }, agentLogin: { complete: false }, e2b: { complete: true }, optional: {},
    paidPlan: { complete: false }, project: { complete: false } },
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
    expect(await steps.locator('.onboarding-step-title').allInnerTexts()).toEqual([
      'Connect GitHub', 'Add agent logins', 'Add an E2B or Daytona API key',
      'Connect apps and payment cards\nOPTIONAL', 'Buy paid plan\nOPTIONAL', 'Create your first project', // chip is upper-cased by CSS
    ]);
    expect(await steps.nth(3).innerText()).toContain('This never blocks setup.');
    expect(await steps.nth(4).innerText()).toContain('This never blocks setup.');
    expect(await guide(ui).locator('.onboarding-foot').innerText()).toContain('Optional items do not count toward completion.');
    // Completed steps show a tick instead of their number.
    expect(await steps.locator('.onboarding-check').allInnerTexts()).toEqual(['✓', '2', '✓', '4', '5', '6']);
    await ui.close();
  });

  it('links each step to its real settings section and opens the project flow in place', async () => {
    const ui = await hosted();
    const actions = await guide(ui).locator('.onboarding-step a.btn').evaluateAll((links) =>
      links.map((link) => [link.textContent?.trim(), link.getAttribute('href')]));
    expect(actions.map(([, href]) => href)).toEqual(['/org/settings#settings-code', '/org/settings#settings-agents',
      '/org/settings#settings-compute', '/org/settings#settings-payments', '/org/settings#settings-plan']);
    expect(actions[2]![0]).toBe('Manage E2B/Daytona'); // a completed step offers management, not setup
    await guide(ui).locator('.onboarding-step a[href$="#settings-agents"]').click();
    await expect.poll(() => ui.page.evaluate(() => `${location.pathname}${location.hash}`)).toBe('/org/settings#settings-agents');
    await guide(ui).locator('#onboarding-new-project').click();
    await ui.page.locator('#modal-root .new-project-dialog').waitFor();
    await ui.close();
  });

  it('gives the optional apps-and-cards step a single action', async () => {
    const ui = await hosted();
    const optional = guide(ui).locator('.onboarding-step').nth(3);
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
    await ui.run(`promptText = async () => 'New'; createOrganization()`);
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
    let completed = 2;
    const ui = await hosted({ onboarding: (call) => {
      if (call.method === 'PUT') display = call.body.display;
      return status({ display, visible: display !== 'closed', completedRequired: completed });
    } });
    const progress = guide(ui).getByRole('progressbar');
    expect(await progress.getAttribute('aria-valuenow')).toBe('2');
    expect(await progress.getAttribute('aria-label')).toBe('2 of 4 required setup steps complete');
    // Progress made elsewhere (a GitHub connection in another tab) shows up without a reload.
    completed = 3;
    await expect.poll(() => progress.getAttribute('aria-valuenow'), { timeout: 8_000 }).toBe('3');

    await guide(ui).getByRole('button', { name: 'Minimize setup guide' }).click();
    const reopen = guide(ui).getByRole('button', { name: 'Open setup guide' });
    await reopen.waitFor();
    expect(await reopen.innerText()).toContain('3 of 4 required steps');
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
        return { right: innerWidth - rect.right, width: rect.width };
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
