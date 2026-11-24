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
    // tavya's computers out of credits: more credits on the plan, or one's own account; the reason is one hover away.
    const credit = await ui.run<any[]>(`readinessGaps({ agents: [], compute: { ready: false, need: 'credit', outOfCredit: 'Out of credits: spent.' } })`);
    expect(credit.map((gap) => [gap.label, gap.href, gap.tip])).toEqual([
      ['Add credits', '/org/settings#settings-plan', 'Out of credits: spent.'],
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
      tip: expect.stringMatching(/^openai\/gpt-6\.1-sol runs on your compute credit at about 7\.9 times what a task on the included model costs\./) }]);
    expect((await ui.run<string>(`readinessNoticeHtml(readinessGaps({ agents: [{ provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol', ready: true, cost: 12.4 }],
      compute: { ready: true }, storage: { full: true, usedBytes: 1, quotaBytes: 1 } }))`)).replace(/<[^>]+>/g, ''))
      .toBe('!On your credit: costs 12× the included model·Storage is full: Add storage');
    // Without a computer, a Claude Code login is ready (its CLI runs in a small cloud computer): no notice at all.
    expect(await ui.run(`readinessGaps({ agents: [{ provider: 'claude', ready: true, sandbox: true }], compute: { ready: true, none: true } })`)).toEqual([]);
    // With nowhere to run it, the fix is a computer, never "Pick another model"; the honest reason is one hover away.
    const noCompute = await ui.run<any[]>(`readinessGaps({ agents: [{ provider: 'claude', ready: false, need: { provider: 'claude',
      computerless: 'A Claude Code login replies from a small cloud computer, and this organization has none it can use.', computerlessFix: 'computer' } }],
      compute: { ready: true, none: true } })`);
    expect(noCompute).toEqual([{ label: 'Connect a computer', href: '/org/settings#settings-computers', tip: expect.stringMatching(/small cloud computer/) }]);
    const noKey = await ui.run<any[]>(`readinessGaps({ agents: [{ provider: 'opencode', model: 'google/gemini-3-pro', ready: false,
      need: { provider: 'google', computerless: "can't run without a computer", computerlessFix: 'model' } }], compute: { ready: true, none: true } })`);
    expect(noKey.map((gap) => gap.label)).toEqual(['Pick another model']);
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
    const noPlan = 'infrastructure: Out of credits: tavya\'s computers come with a paid plan. Choose one in Plan & billing (https://tavya.test/org/settings#settings-plan), or connect your own E2B account in Settings → Computers.';
    expect(await fix(noPlan)).toEqual({ label: 'Choose a plan', href: '/org/settings#settings-plan' });
    const fixes = (text: string) => ui.run<any[]>(`setupFixes(${JSON.stringify(text)})`);
    expect(await fixes(noPlan)).toEqual([{ label: 'Choose a plan', href: '/org/settings#settings-plan' },
      { label: 'Use your own account', href: '/org/settings#settings-computers' }]);
    const spent = 'Out of credits: this month\'s $10.00 of tavya credits is used up. Add credits or turn on auto top-up in Plan & billing (https://tavya.test/org/settings#settings-plan), or connect your own E2B account in Settings → Computers. They renew on 2026-12-01.';
    expect(await fixes(spent)).toEqual([{ label: 'Add credits', href: '/org/settings#settings-plan' },
      { label: 'Use your own account', href: '/org/settings#settings-computers' }]);
    // The organization the message names is the one to top up, whichever is open.
    expect(await fixes(spent.replace('tavya.test/org/', 'tavya.test/acme/'))).toContainEqual({ label: 'Add credits', href: '/acme/settings#settings-plan' });
    // Said before credits were named so: still understood.
    expect(await fixes('Out of compute: this month\'s $10.00 of compute is used up. Add a $10 pack or turn on auto top-up in Plan & billing, or connect your own E2B account in Settings → Computers. It renews on 2026-12-01.'))
      .toContainEqual({ label: 'Add credits', href: '/org/settings#settings-plan' });
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
    expect(await fix('Free allows 1 organization user, but this organization has 2. Remove 1 member in Settings → People & authorization, or restore Team in Plan & billing, to start another agent run.'))
      .toEqual({ label: 'Change plan', href: '/org/settings#settings-plan' });
    expect(await fix('CPU can be at most 2 on the Free plan: choose a plan in Plan & billing for a bigger one'))
      .toEqual({ label: 'Choose a plan', href: '/org/settings#settings-plan' });
    // The free trial, and the included model, which draws on the same credit (its alternative is a login of one's own).
    expect(await fixes('Out of credits: your $5.00 free trial is used up. Choose a plan in Plan & billing (/org/settings#settings-plan), or connect your own E2B account in Settings → Computers.'))
      .toEqual([{ label: 'Choose a plan', href: '/org/settings#settings-plan' }, { label: 'Use your own account', href: '/org/settings#settings-computers' }]);
    expect(await fixes('Out of credits: this month\'s $5.00 of tavya credits is used up. Add credits or turn on auto top-up in Plan & billing (/org/settings#settings-plan), or connect your own agent login or API key in Settings → Agents. They renew on 2026-12-01.'))
      .toEqual([{ label: 'Add credits', href: '/org/settings#settings-plan' }, { label: 'Use your own login', href: '/org/settings#settings-agents' }]);
    // A generation refused for its price: add credits there.
    expect(await fixes('Out of credits: this video on google/veo-3.1 would cost up to $6.40 of tavya credits; $5.00 is left. Choose a cheaper model, a shorter or smaller one, or add credits or turn on auto top-up in Plan & billing (/org/settings#settings-plan).'))
      .toEqual([{ label: 'Add credits', href: '/org/settings#settings-plan' }]);
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

    // Out of credits: one line saying what happened, the ways out as buttons, the whole reason on hover.
    await ui.run(`document.getElementById('main').innerHTML = conversationWaitNotice({ taskId: 't', status: 'waiting',
      waitingFor: { kind: 'retry', summary: 'Out of credits', until: Date.now() + 60_000, detail: ${JSON.stringify(spent)} } })`);
    const notice = ui.page.locator('#main .wait-notice');
    expect(await notice.innerText()).toMatch(/^Out of credits, trying at .+ · This month’s \$10\.00 of tavya credits is used up\.\s*Add credits\s*Use your own account$/);
    expect(await notice.getAttribute('title')).toBe(spent);
    expect(await notice.locator('a.setup-fix').evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
      .toEqual(['/org/settings#settings-plan', '/org/settings#settings-computers']);
    await ui.run(`document.getElementById('main').innerHTML = conversationWaitNotice({ taskId: 't', status: 'waiting',
      waitingFor: { kind: 'retry', summary: 'Out of credits', until: Date.now() + 60_000, detail: ${JSON.stringify(noPlan)} } })`);
    expect(await notice.innerText()).toMatch(/· tavya’s computers come with a paid plan\.\s*Choose a plan\s*Use your own account$/);

    // An error toast about full storage carries the way out.
    await ui.run(`toast('managed storage quota exceeded (1 bytes requested, 1 byte limit)', true)`);
    expect(await ui.page.locator('.toast .toast-action').last().getAttribute('href')).toBe('/org/settings#settings-plan');
    await ui.close();
  });

  it('takes a GitHub write refusal to where it is approved (tavya-error 40d814688b2054c8)', async () => {
    const ui = await console_();
    const refused = 'Activity task failed → GitHub refused to let tavya write to radnyees/personal. The tavya GitHub App now requests Contents: read and write, '
      + 'but radnyees has not approved it. Approve the updated App permission at https://github.com/settings/installations/42, then retry the task. '
      + 'GitHub said: Write access to repository not granted.';
    expect(await ui.run<any[]>(`setupFixes(${JSON.stringify(refused)})`)).toEqual([
      { label: 'Approve on GitHub', href: 'https://github.com/settings/installations/42', external: true },
      { label: 'GitHub settings', href: '/org/settings#settings-code' }]);
    // The same for the Workflows permission, past the operator's App settings to the owner's approval.
    expect(await ui.run<any[]>(`setupFixes(${JSON.stringify('GitHub App workflow permission required for acme/app. The installation operator must grant the tavya GitHub App '
      + 'Workflows: read and write at https://github.com/settings/apps/tavya/permissions. Then the owner of acme must approve the updated App permission at '
      + 'https://github.com/organizations/acme/settings/installations/7. Retry the task after both steps.')})`))
      .toEqual([{ label: 'Approve on GitHub', href: 'https://github.com/organizations/acme/settings/installations/7', external: true },
        { label: 'GitHub settings', href: '/org/settings#settings-code' }]);
    // Without GitHub's address: where tavya's GitHub connection is managed.
    expect(await ui.run<any[]>(`setupFixes('GitHub refused to let tavya write to acme/app. Check it on GitHub and in organization settings → GitHub, then retry the task.')`))
      .toEqual([{ label: 'GitHub settings', href: '/org/settings#settings-code' }]);
    // On GitHub, so a new tab, never the console's own navigation.
    await ui.run(`document.getElementById('main').innerHTML = taskErrorHtml(${JSON.stringify(refused)})`);
    expect(await ui.page.locator('#main a.setup-fix').first().evaluate((link) =>
      [link.textContent, link.getAttribute('href'), link.getAttribute('target'), link.hasAttribute('data-spa')]))
      .toEqual(['Approve on GitHub', 'https://github.com/settings/installations/42', '_blank', false]);
    await ui.run(`toast(${JSON.stringify(refused)}, true)`);
    expect(await ui.page.locator('.toast .toast-action').last().evaluate((link) => [link.getAttribute('target'), link.hasAttribute('data-spa')]))
      .toEqual(['_blank', false]);
    await ui.close();
  });

  it('links every settings place an error names, and the waits people met on tavya.io (2026-11-14)', async () => {
    const ui = await console_();
    await ui.run(`S.projects = [{ id: 'p', name: 'Web', slug: 'web', organizationId: 'o' }]`);
    const fixes = (text: string) => ui.run<any[]>(`setupFixes(${JSON.stringify(text)}, 'p')`);
    // A project whose tasks open pull requests, on repositories not on GitHub (formerly a policy dump).
    const remote = 'Activity task failed → This project\'s tasks open GitHub pull requests, but none of this task\'s repositories is on GitHub. '
      + 'In Project settings → Task defaults, set Remote policy to "Push after merging", or move the repositories to GitHub; then press Retry.';
    expect(await fixes(remote)).toEqual([{ label: 'Task defaults', href: '/org/web/settings#project-defaults' }]);
    // Waiting its turn, or for room, on tavya's computers: one's own account starts it now.
    for (const wait of ['3 tasks are waiting ahead of this one for tavya\'s Hetzner Cloud computers; waiting its turn.',
      'A task is waiting ahead of this one for tavya\'s Fly.io computers; waiting its turn.',
      'tavya\'s Hetzner Cloud computers\' disks take 980 of their 1024 GB (parked ones too); waiting for room.'])
      expect(await fixes(wait)).toEqual([{ label: 'Use your own account', href: '/org/settings#settings-computers' }]);
    // A login's quota is spent: another login runs it now.
    expect(await fixes('Out of quota until a login resets')).toEqual([{ label: 'Add a login', href: '/org/settings#account-add', title: expect.any(String) }]);
    // Any place a message names, in the order it names them, once each.
    expect(await fixes('Build it in Project settings → Environment for faster worlds')).toEqual([{ label: 'Project settings', href: '/org/web/settings' }]);
    expect(await fixes('Set it up in Settings → Environment.')).toEqual([{ label: 'Environment', href: '/org/web/settings#project-environment' }]);
    expect(await fixes('Reconnect GitHub on your profile, then Retry.')).toEqual([{ label: 'Connect GitHub', href: '/profile' }]);
    expect(await fixes('Ask an admin to change this in organization settings.')).toEqual([{ label: 'Organization settings', href: '/org/settings' }]);
    expect(await ui.run<any[]>(`setupFixes('Change it in project settings.')`)).toEqual([]);
    // Shown on a stopped task, with no "Press Retry" in place of the fix.
    await ui.run(`document.getElementById('main').innerHTML = taskErrorHtml(${JSON.stringify(remote)}, 'p')`);
    expect(await ui.page.locator('#main a.setup-fix').evaluate((link) => [link.textContent, link.getAttribute('href')]))
      .toEqual(['Task defaults', '/org/web/settings#project-defaults']);
    expect(await ui.page.locator('#main .msg-text').innerText()).not.toContain('Press Retry to try again. Press Retry');
    await ui.close();
  });

  it('links every limit on a model login to adding another one, with its provider chosen (owner, 2026-11-24)', async () => {
    const ui = await console_();
    await ui.run(`S.projects = [{ id: 'p', name: 'Web', slug: 'web', organizationId: 'o' }];
      S.tasks = [{ id: 't', num: 7, projectId: 'p', title: 'Task' }]`);
    const notice = (waitingFor: object) => ui.run<string>(`(() => {
      document.getElementById('main').innerHTML = conversationWaitNotice({ taskId: 't', projectId: 'p', status: 'waiting', waitingFor: ${JSON.stringify(waitingFor)} });
      const link = document.querySelector('#main .wait-notice a.setup-fix');
      return link ? [document.querySelector('#main .wait-notice').innerText, link.textContent, link.getAttribute('href'), link.title] : null;
    })()`);
    // Claude's quota is used up: the notice says until when, and where to connect another subscription.
    const quota = await notice({ kind: 'account', provider: 'claude', reason: 'quota', earliestResetAt: Date.now() + 3_600_000, detail: 'Out of quota until a login resets' });
    expect(quota).toEqual([expect.stringMatching(/^Waiting for Claude quota until .+Add a login$/), 'Add a login',
      '/org/settings?add=claude#account-add', 'Connect another Claude subscription or API key: work uses it while this one is used up']);
    // Every login busy, and a view from before the coordinator gave a reason.
    expect((await notice({ kind: 'account', provider: 'codex', reason: 'slot', detail: 'Every allowed login is running all it may' }))?.slice(1, 3))
      .toEqual(['Add a login', '/org/settings?add=codex#account-add']);
    expect((await notice({ kind: 'account', detail: 'Provider usage limit reached; the task resumes automatically when quota resets' }))?.slice(1, 3))
      .toEqual(['Add a login', '/org/settings#account-add']);
    // A key-based model: the key's vendor is chosen.
    expect((await notice({ kind: 'account', provider: 'openrouter', reason: 'quota' }))?.[2]).toBe('/org/settings?add=openrouter#account-add');
    // Planning is a moment away: nothing to do.
    expect(await notice({ kind: 'account', provider: 'claude', reason: 'planning' })).toBeNull();
    // A wait for one of tavya's machines: one's own account starts it now.
    expect((await notice({ kind: 'retry', summary: 'Waiting for a machine', until: Date.now() + 60_000,
      detail: 'Every computer this task can use is full (tavya\'s E2B: All 20 of tavya\'s E2B computers are in use). Waiting for one to free up.' }))?.slice(1, 3))
      .toEqual(['Use your own account', '/org/settings#settings-computers']);

    const fixes = (text: string) => ui.run<any[]>(`setupFixes(${JSON.stringify(text)}, 'p', 't')`);
    // A task stopped by a subscription's limit, and the waits' own words.
    for (const text of ['agent-limit: You\'ve hit your session limit · resets 3:45pm', 'Claude usage limit reached', 'Waiting for a free Claude login'])
      expect((await fixes(text))[0]).toMatchObject({ label: 'Add a login' });
    expect((await fixes('Waiting for Claude quota until 3:00 PM'))[0].href).toBe('/org/settings?add=claude#account-add');
    // An API key out of money: topped up at its provider (a new tab), or replaced here.
    expect(await fixes('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'))
      .toEqual([{ label: 'Add Anthropic credits', href: 'https://platform.claude.com/settings/billing', external: true },
        { label: 'Manage accounts', href: '/org/settings#settings-agents' }]);
    expect((await fixes('429 insufficient_quota: You exceeded your current quota'))[0].label).toBe('Add OpenAI credits');
    expect((await fixes('openrouter/anthropic/claude-sonnet-5: 402 This request requires more credits'))[0].label).toBe('Add OpenRouter credits');
    // GitHub's rate limit is not a model login's.
    expect(await fixes('GitHub API 403: API rate limit exceeded')).toEqual([]);
    // The task's computer ran out of memory: a bigger one, in its Parameters.
    expect(await fixes('exited with code -1 — the sandbox used 2.0 of 2.0 GB; a command in the sandbox likely used more memory than it has.'))
      .toEqual([{ label: 'Bigger computer', href: '/org/web/tasks/7/parameters' }]);
    expect(await fixes('Or choose a bigger computer in Parameters.')).toEqual([{ label: 'Parameters', href: '/org/web/tasks/7/parameters' }]);
    // Shown on the stopped task, in plain words.
    await ui.run(`document.getElementById('main').innerHTML = taskErrorHtml('Your credit balance is too low to access the Anthropic API.', 'p', 't')`);
    expect(await ui.page.locator('#main .msg-text').innerText()).toMatch(/^The AI account is out of credit\..*Add Anthropic credits\s*Manage accounts$/);

    // A plan's limit is not a model's, though it names Plan & billing.
    await ui.run(`document.getElementById('main').innerHTML = taskErrorHtml('Free allows 1 organization user, but this organization has 2. Remove 1 member in Settings → People & authorization, or restore Team in Plan & billing, to start another agent run.', 'p', 't')`);
    expect(await ui.page.locator('#main .msg-text').innerText()).toMatch(/^Free allows 1 organization user.*Change plan\s*Members$/s);

    // An error shown in place of what failed to load links its fix too.
    expect(await ui.run(`inlineErrorHtml(new Error('managed storage quota exceeded (1 bytes requested, 1 byte limit)'))`))
      .toContain('href="/org/settings#settings-plan"');

    // Places messages name, and a provider's own page they give (a new tab).
    expect(await fixes('Reconnect this account in Settings → Connected apps before using it'))
      .toEqual([{ label: 'Connected apps', href: '/org/settings#settings-connections' }]);
    expect(await fixes('Account access expired; reconnect it in Project settings → Connected apps'))
      .toEqual([{ label: 'Connected apps', href: '/org/web/settings#project-connections' }]);
    expect(await fixes('Free allows 1 organization user, but this organization has 2. Remove 1 member in Settings → People & authorization, or restore Team in Plan & billing, to start another agent run.'))
      .toEqual([{ label: 'Change plan', href: '/org/settings#settings-plan' }, { label: 'Members', href: '/org/settings#settings-people' }]);
    expect(await fixes('This Fly.io organization is on its free trial, which stops every machine after 5 minutes. Add a payment method at https://fly.io/dashboard/acme/billing.'))
      .toEqual([{ label: 'Open fly.io', href: 'https://fly.io/dashboard/acme/billing', external: true }]);
    expect(await fixes('Custom network rules require Daytona Tier 3 or higher. Upgrade Daytona at https://app.daytona.io/dashboard, or choose Full internet for this task\'s Computer in Parameters.'))
      .toEqual([{ label: 'Parameters', href: '/org/web/tasks/7/parameters' }, { label: 'Open daytona.io', href: 'https://app.daytona.io/dashboard', external: true }]);
    // An operator's places, for an operator only.
    expect(await fixes('Gemini is not offered on this installation: an operator turns it on in Installation → Managed compute')).toEqual([]);
    await ui.run(`S.installationAccess = true`);
    expect(await fixes('Gemini is not offered on this installation: an operator turns it on in Installation → Managed compute'))
      .toEqual([{ label: 'Managed compute', href: '/installation#installation-compute' }]);
    await ui.run(`S.installationAccess = false`);
    // tavya's own address is linked by its name; documentation is no fix.
    expect(await fixes('Add credits in Plan & billing (https://tavya.io/org/settings#settings-plan).')).toEqual([{ label: 'Plan & billing', href: '/org/settings#settings-plan' }]);
    expect(await fixes('GitHub API 422: {"message":"Validation Failed","documentation_url":"https://docs.github.com/rest/pulls"}')).toEqual([]);

    // The Queues page: work whose every login is used up offers another.
    await ui.run(`S.agentWork = { organizationId: 'o', running: [], waiting: [{ taskId: 't', root: 't', projectId: 'p', num: 7, title: 'Task',
      priority: 'medium', turnId: 'u', status: 'quota', until: Date.now() + 3_600_000 }] };
      document.getElementById('main').innerHTML = agentWorkPanel()`);
    expect(await ui.page.locator('#main .work-tree a.setup-fix').evaluate((link) => [link.textContent, link.getAttribute('href')]))
      .toEqual(['Add a login', '/org/settings#account-add']);

    // Following the link chooses the provider on the add form, once.
    await ui.run(`history.replaceState(null, '', '/org/settings?add=claude#account-add');
      document.getElementById('main').innerHTML = agentAccountsCard(); applyAddAccountHint()`);
    expect(await ui.run(`[document.getElementById('login-provider').value, document.activeElement.id, location.search, location.hash]`))
      .toEqual(['claude', 'login-name', '', '#account-add']);
    await ui.run(`history.replaceState(null, '', '/org/settings?add=openrouter#account-add');
      document.getElementById('main').innerHTML = agentAccountsCard(); applyAddAccountHint()`);
    expect(await ui.run(`[document.getElementById('acct-provider').value, document.activeElement.id]`)).toEqual(['openrouter', 'acct-name']);
    await ui.close();
  });
});
