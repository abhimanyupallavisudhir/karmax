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
    // OpenCode runs on its model's vendor: an OpenRouter key, not an "OpenCode account"; one that is
    // only switched off says where to switch it on.
    await ui.run(`S.projects = [{ id: 'p', name: 'Web', slug: 'web', organizationId: 'o' }]`);
    const vendor = await ui.run<any[]>(`readinessGaps({ agents: [
      { provider: 'opencode', model: 'openrouter/google/gemini-4-argon', ready: false, need: { provider: 'openrouter', off: 'project' } },
      { provider: 'opencode', model: 'openai/gpt-6', ready: false, need: { provider: 'openai' } },
      { provider: 'opencode', model: 'xai/grok-5', ready: false, need: { provider: 'xai', off: 'organization' } }], compute: { ready: true } }, 'p')`);
    expect(vendor.map((gap) => [gap.label, gap.href])).toEqual([
      ['Turn on OpenRouter', '/org/web/settings#project-agents'], ['Add an OpenAI account', '/org/settings#settings-agents'],
      ['Turn on xAI', '/org/settings#settings-agents']]);
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
    expect(full).toEqual([{ label: 'Add storage', href: '/org/settings#settings-plan', warn: true, lead: 'Storage is full:',
      tip: 'Storage is full (6 GB of 5 GB). New project data isn’t saved until you free some or add a 100 GB pack.' }]);
    expect(await ui.run(`readinessNoticeHtml(readinessGaps({ agents: [], compute: { ready: true }, storage: { full: true, usedBytes: 1, quotaBytes: 1 } }))`))
      .toMatch(/Storage is full:<\/span> <a/);
    const both = await ui.run<string>(`readinessNoticeHtml(readinessGaps({ agents: [], compute: { ready: false, need: 'plan' }, storage: { full: true, usedBytes: 1, quotaBytes: 1 } }))`);
    expect(both.replace(/<[^>]+>/g, '')).toBe('!Can’t start yet: Choose a plan·Connect your own computer·Storage is full: Add storage');
    // A model on the compute credit that costs much more than the included one: a warning that says how much, not a blocker.
    const pricey = await ui.run<any[]>(`readinessGaps({ agents: [{ provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol', ready: true, cost: 7.9 },
      { provider: 'opencode', model: 'openrouter/xiaomi/mimo-v2.6-flash', ready: true, cost: 0.4 }], compute: { ready: true } })`);
    expect(pricey).toEqual([{ label: 'costs 7.9× the included model', href: '/org/settings#settings-plan', warn: true, lead: 'On your credit:',
      tip: expect.stringMatching(/^openai\/gpt-6\.1-sol runs on your compute credit at about 7\.9 times the included model’s price a task\./) }]);
    expect((await ui.run<string>(`readinessNoticeHtml(readinessGaps({ agents: [{ provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol', ready: true, cost: 12.4 }],
      compute: { ready: true }, storage: { full: true, usedBytes: 1, quotaBytes: 1 } }))`)).replace(/<[^>]+>/g, ''))
      .toBe('!On your credit: costs 12× the included model·Storage is full: Add storage');
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
    // The plan's own limits link to Plan & billing too.
    expect(await fix('Waiting for Free plan capacity (5 active agent runs)')).toEqual({ label: 'Change plan', href: '/org/settings#settings-plan' });
    expect(await fix('Free allows 1 organization user, but this organization has 2. Remove 1 member or restore Team to start another agent run.'))
      .toEqual({ label: 'Change plan', href: '/org/settings#settings-plan' });
    expect(await fix('CPU can be at most 2 on the Free plan: choose a plan in Plan & billing for a bigger one'))
      .toEqual({ label: 'Choose a plan', href: '/org/settings#settings-plan' });
    // The free trial, and the included model, which draws on the same credit (its alternative is a login of one's own).
    expect(await fixes('Out of compute: your $5.00 free trial is used up. Choose a plan in Plan & billing, or connect your own E2B account in Settings → Computers.'))
      .toEqual([{ label: 'Choose a plan', href: '/org/settings#settings-plan' }, { label: 'Use your own account', href: '/org/settings#settings-computers' }]);
    expect(await fixes('Out of compute: this month\'s $5.00 of compute is used up. Add a $10 pack or turn on auto top-up in Plan & billing, or connect your own agent login or API key in Settings → Agents. It renews on 2026-12-01.'))
      .toEqual([{ label: 'Add compute', href: '/org/settings#settings-plan' }, { label: 'Use your own login', href: '/org/settings#settings-agents' }]);
    expect(await fix('merge failed: conflict')).toBeNull();

    // A task stopped on it shows the fix beside the plain reason.
    await ui.run(`document.getElementById('main').innerHTML = taskErrorHtml('No computer is connected: connect one under Settings → Computers.')`);
    expect(await ui.page.locator('#main a.setup-fix').getAttribute('href')).toBe('/org/settings#settings-computers');
    // A task waiting for a credential says which, the way Settings names it, with the fix.
    await ui.run(`document.getElementById('main').innerHTML = conversationWaitNotice({ taskId: 't',
      waitingFor: { kind: 'account', detail: 'No claude credential — add one, or stop this agent' } })`);
    expect(await ui.page.locator('#main .wait-notice').innerText()).toContain('No Claude account — add one, or stop this agent');
    expect(await ui.page.locator('#main .wait-notice a.setup-fix').innerText()).toBe('Manage accounts');
    // A key that is only switched off: switch it on for the project (a lower scope wins).
    await ui.run(`S.projects = [{ id: 'p', name: 'Web', slug: 'web', organizationId: 'o' }];
      document.getElementById('main').innerHTML = conversationWaitNotice({ taskId: 't', projectId: 'p', waitingFor: { kind: 'account',
        provider: 'openrouter', reason: 'login', detail: 'Your openrouter account is switched off for this task — turn it on, or stop this agent' } })`);
    expect(await ui.page.locator('#main .wait-notice').innerText())
      .toContain('OpenRouter is switched off · Your OpenRouter account is switched off for this task — turn it on, or stop this agent');
    expect(await ui.page.locator('#main .wait-notice a.setup-fix').evaluate((link) => [link.textContent, link.getAttribute('href')]))
      .toEqual(['Turn on', '/org/web/settings#project-agents']);

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
