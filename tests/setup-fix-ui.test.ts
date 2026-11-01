import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/** The console on an organization page, its settings at `/org/settings`. */
async function console_() {
  const ui = await consolePage({ path: '/org/workspace' });
  await ui.run(`S.organizations = [{ id: 'o', name: 'Org', slug: 'org' }]; S.organizationId = 'o'`);
  return ui;
}

describe('what a person does about a task that cannot start', () => {
  it('names a missing agent account and computer as links to their settings', async () => {
    const ui = await console_();
    const gaps = await ui.run<any[]>(`readinessGaps({ agents: [{ provider: 'claude', ready: false }, { provider: 'claude', model: 'x', ready: false },
      { provider: 'codex', ready: true }], compute: { ready: false } })`);
    expect(gaps.map((gap) => [gap.label, gap.href])).toEqual([
      ['Add a Claude account', '/org/settings#settings-agents'], ['Connect a computer', '/org/settings#settings-computers']]);
    // tavya's computers out of credit: the plan is the way, and the reason is one hover away.
    const credit = await ui.run<any[]>(`readinessGaps({ agents: [], compute: { ready: false, outOfCredit: 'Out of compute: spent.' } })`);
    expect(credit).toEqual([{ label: 'Get compute', href: '/org/settings#settings-plan', tip: 'Out of compute: spent.' }]);
    // Ready, or unknown (the readiness call failed): nothing to say.
    expect(await ui.run(`readinessGaps({ agents: [{ provider: 'claude', ready: true }], compute: { ready: true } })`)).toEqual([]);
    expect(await ui.run(`readinessGaps(null)`)).toEqual([]);
    await ui.close();
  });

  it('offers the setting that unblocks a stopped or waiting task', async () => {
    const ui = await console_();
    const fix = (text: string) => ui.run<any>(`setupFix(${JSON.stringify(text)})`);
    expect(await fix('No computer is connected: connect one under Settings → Computers.'))
      .toEqual({ label: 'Connect a computer', href: '/org/settings#settings-computers' });
    expect(await fix('infrastructure: Out of compute: tavya\'s computers come with a paid plan. Choose one in Plan & billing, or connect your own E2B account in Settings → Computers.'))
      .toEqual({ label: 'Get compute', href: '/org/settings#settings-plan' });
    expect(await fix('No claude credential — add one, or stop this agent'))
      .toEqual({ label: 'Manage accounts', href: '/org/settings#settings-agents' });
    expect(await fix('GitHub PR identity is not connected for user_1. Connect GitHub on your profile'))
      .toEqual({ label: 'Connect GitHub', href: '/profile' });
    expect(await fix('merge failed: conflict')).toBeNull();

    // A task stopped on it shows the fix beside the plain reason.
    await ui.run(`document.getElementById('main').innerHTML = taskErrorHtml('No computer is connected: connect one under Settings → Computers.')`);
    expect(await ui.page.locator('#main a.setup-fix').getAttribute('href')).toBe('/org/settings#settings-computers');
    // A task waiting for a credential says which, the way Settings names it, with the fix.
    await ui.run(`document.getElementById('main').innerHTML = conversationWaitNotice({ taskId: 't',
      waitingFor: { kind: 'account', detail: 'No claude credential — add one, or stop this agent' } })`);
    expect(await ui.page.locator('#main .wait-notice').innerText()).toContain('No Claude account — add one, or stop this agent');
    expect(await ui.page.locator('#main .wait-notice a.setup-fix').innerText()).toBe('Manage accounts');
    await ui.close();
  });
});
