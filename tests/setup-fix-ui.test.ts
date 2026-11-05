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
    // tavya's computers out of credit: more compute on the plan, or one's own account; the reason is one hover away.
    const credit = await ui.run<any[]>(`readinessGaps({ agents: [], compute: { ready: false, need: 'credit', outOfCredit: 'Out of compute: spent.' } })`);
    expect(credit.map((gap) => [gap.label, gap.href, gap.tip])).toEqual([
      ['Add compute', '/org/settings#settings-plan', 'Out of compute: spent.'],
      ['Use your own account', '/org/settings#settings-computers', expect.stringContaining('your own')]]);
    // Never bought a plan nor connected a computer: either one, said so.
    const none = await ui.run<any[]>(`readinessGaps({ agents: [], compute: { ready: false, need: 'plan', outOfCredit: 'Out of compute: a paid plan.' } })`);
    expect(none.map((gap) => [gap.label, gap.href])).toEqual([
      ['Choose a plan', '/org/settings#settings-plan'], ['Connect your own computer', '/org/settings#settings-computers']]);
    expect(none[0].tip).toMatch(/come with Individual or Team/);
    // Full storage does not stop a task, but nothing new it makes is kept: a warning, not a blocker.
    const full = await ui.run<any[]>(`readinessGaps({ agents: [], compute: { ready: true }, storage: { full: true, usedBytes: 6 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3 } })`);
    expect(full).toEqual([{ label: 'Add storage', href: '/org/settings#settings-plan', warn: true,
      tip: 'Storage is full (6 GB of 5 GB). New project data isn’t saved until you free some or add a 100 GB pack.' }]);
    expect(await ui.run(`readinessNoticeHtml(readinessGaps({ agents: [], compute: { ready: true }, storage: { full: true, usedBytes: 1, quotaBytes: 1 } }))`))
      .toMatch(/Storage is full:<\/span> <a/);
    const both = await ui.run<string>(`readinessNoticeHtml(readinessGaps({ agents: [], compute: { ready: false, need: 'plan' }, storage: { full: true, usedBytes: 1, quotaBytes: 1 } }))`);
    expect(both.replace(/<[^>]+>/g, '')).toBe('!Can’t start yet: Choose a plan·Connect your own computer·Storage is full: Add storage');
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
    const noPlan = 'infrastructure: Out of compute: tavya\'s computers come with a paid plan. Choose one in Plan & billing, or connect your own E2B account in Settings → Computers.';
    expect(await fix(noPlan)).toEqual({ label: 'Choose a plan', href: '/org/settings#settings-plan' });
    const fixes = (text: string) => ui.run<any[]>(`setupFixes(${JSON.stringify(text)})`);
    expect(await fixes(noPlan)).toEqual([{ label: 'Choose a plan', href: '/org/settings#settings-plan' },
      { label: 'Use your own account', href: '/org/settings#settings-computers' }]);
    const spent = 'Out of compute: this month\'s $10.00 of compute is used up. Add a $10 pack or turn on auto top-up in Plan & billing, or connect your own E2B account in Settings → Computers. It renews on 2026-12-01.';
    expect(await fixes(spent)).toEqual([{ label: 'Add compute', href: '/org/settings#settings-plan' },
      { label: 'Use your own account', href: '/org/settings#settings-computers' }]);
    // tavya's computers are all busy: one's own account starts it now.
    expect(await fixes('Every computer this task can use is full (tavya\'s E2B: All 20 of tavya\'s E2B computers are in use). Waiting for one to free up.'))
      .toEqual([{ label: 'Use your own account', href: '/org/settings#settings-computers' }]);
    // Storage full, wherever it is said.
    expect(await fixes('Publishing data failed: storage quota exceeded (the organization\'s storage is full)'))
      .toEqual([{ label: 'Add storage', href: '/org/settings#settings-plan' }]);
    expect(await ui.run(`plainError('managed storage quota exceeded (6442450944 bytes requested, 5368709120 byte limit)')`))
      .toBe('Your organization’s storage is full. Free some space, or add a 100 GB pack in Plan & billing.');
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

    // Out of compute: one line saying what happened, the ways out as buttons, the whole reason on hover.
    await ui.run(`document.getElementById('main').innerHTML = conversationWaitNotice({ taskId: 't', status: 'waiting',
      waitingFor: { kind: 'retry', summary: 'Out of compute', until: Date.now() + 60_000, detail: ${JSON.stringify(spent)} } })`);
    const notice = ui.page.locator('#main .wait-notice');
    expect(await notice.innerText()).toMatch(/^Out of compute, trying at .+ · This month’s \$10\.00 of compute is used up\.\s*Add compute\s*Use your own account$/);
    expect(await notice.getAttribute('title')).toBe(spent);
    expect(await notice.locator('a.setup-fix').evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
      .toEqual(['/org/settings#settings-plan', '/org/settings#settings-computers']);
    await ui.run(`document.getElementById('main').innerHTML = conversationWaitNotice({ taskId: 't', status: 'waiting',
      waitingFor: { kind: 'retry', summary: 'Out of compute', until: Date.now() + 60_000, detail: ${JSON.stringify(noPlan)} } })`);
    expect(await notice.innerText()).toMatch(/· tavya’s computers come with a paid plan\.\s*Choose a plan\s*Use your own account$/);

    // An error toast about full storage carries the way out.
    await ui.run(`toast('managed storage quota exceeded (1 bytes requested, 1 byte limit)', true)`);
    expect(await ui.page.locator('.toast .toast-action').last().getAttribute('href')).toBe('/org/settings#settings-plan');
    await ui.close();
  });
});
