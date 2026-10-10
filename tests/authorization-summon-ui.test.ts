import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn, type ApiCall, type ApiHandler } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

type Console = Awaited<ReturnType<typeof consolePage>>;

/** What `POST /api/authorization/escalation-targets` answers for a developer
 * asking for Project maintainer in the workspace project. */
const targets = {
  projectId: 'p', authorization: { level: 'maintainer', scope: 'projects', projectIds: ['p'] },
  requestedCapabilities: ['project:edit', 'task:delete', 'review:approve'],
  missingCapabilities: ['project:edit', 'task:delete', 'review:approve'],
  users: [{ id: 'lead', selector: 'user:lead', name: 'Lea Lead', email: 'lea@example.com' },
    { id: 'owner', selector: 'user:owner', name: 'Olu Owner' }],
  teams: [{ id: 'team_core', name: 'Core', slug: 'core', selector: '@team:core', eligibleUserIds: ['lead'] }],
  special: [{ selector: '@maintainers', eligibleUserIds: ['lead', 'owner'] }, { selector: '@superadmins', eligibleUserIds: ['owner'] },
    { selector: '@owners', eligibleUserIds: ['owner'] }, { selector: '@all', eligibleUserIds: ['lead', 'owner'] }],
  avatars: [{ id: 'av_gate', name: 'Gatekeeper', selector: 'avatar:av_gate' }],
  summon: '@maintainers',
};
const gap = { status: 403, json: { error: 'you cannot grant the agent more authorization than you have', code: 'authorization_grant_denied',
  summon: '@maintainers', missingCapabilities: targets.missingCapabilities } };

async function open(api: ApiHandler) {
  const ui = await consolePage({ path: '/org/workspace', api: signedIn(async (call) => (await api(call)) ?? emptySettings(call)) });
  await ui.run('window.confirm = () => true; boot()');
  await ui.page.locator('#rail').first().waitFor({ state: 'attached' });
  return ui;
}
const dialog = (ui: Console) => ui.page.getByRole('dialog');
/** Changes the dialog made (the eligibility lookup is a POST that changes nothing). */
const writes = (ui: Console) => ui.calls.filter((call: ApiCall) => call.method !== 'GET'
  && !call.path.startsWith('/api/authorization/escalation-targets'));

describe('the authorization summon dialog', () => {
  it('is compact: what you cannot grant, whom to alert, someone else, or your own authorization', async () => {
    const ui = await open(({ path }) => path.startsWith('/api/authorization/escalation-targets') ? targets : undefined);
    const choice = ui.run(`chooseAuthorizationGrant('p', ${JSON.stringify(targets.authorization)}, 'task agent')`);
    await expect.poll(() => dialog(ui).getByRole('heading').innerText()).toBe("You can't grant Project maintainer · Workspace");
    // No paragraphs: the explanation is a tooltip, the missing capabilities a disclosure.
    expect(await dialog(ui).locator('p').count()).toBe(0);
    const missing = dialog(ui).getByText('3 missing');
    await missing.click();
    expect(await dialog(ui).locator('.summon-missing .chip').allInnerTexts()).toEqual(targets.missingCapabilities);
    expect(await dialog(ui).locator('.info-dot').getAttribute('title')).toMatch(/approve/i);
    await dialog(ui).getByRole('button', { name: 'Alert @maintainers', exact: true }).click();
    expect(await choice).toMatchObject({ action: 'ask', audience: ['@maintainers'] });
    expect(await dialog(ui).count()).toBe(0);
    await ui.close();
  });

  it('searches people, teams and Avatars who can grant it', async () => {
    const ui = await open(({ path }) => path.startsWith('/api/authorization/escalation-targets') ? targets : undefined);
    const choice = ui.run(`chooseAuthorizationGrant('p', ${JSON.stringify(targets.authorization)}, 'task agent')`);
    const someone = dialog(ui).getByRole('combobox', { name: 'Someone else…' });
    await someone.fill('lea');
    expect(await dialog(ui).getByRole('option').allInnerTexts()).toEqual([expect.stringContaining('Lea Lead')]);
    await dialog(ui).getByRole('option').first().click();
    await someone.fill('gate');
    await dialog(ui).getByRole('option', { name: /Gatekeeper/ }).click();
    await dialog(ui).getByRole('button', { name: 'Send' }).click();
    expect(await choice).toMatchObject({ action: 'ask', audience: ['user:lead', 'avatar:av_gate'] });
    await ui.close();
  });

  it('cuts the grant back to size, or closes without a choice', async () => {
    const ui = await open(({ path }) => path.startsWith('/api/authorization/escalation-targets') ? targets : undefined);
    const limited = ui.run(`chooseAuthorizationGrant('p', ${JSON.stringify(targets.authorization)}, 'Avatar')`);
    await dialog(ui).getByRole('button', { name: 'Use my authorization', exact: true }).click();
    expect(await limited).toEqual({ action: 'limit' });
    const closed = ui.run(`chooseAuthorizationGrant('p', ${JSON.stringify(targets.authorization)}, 'Avatar')`);
    await dialog(ui).waitFor();
    await ui.page.keyboard.press('Escape');
    expect(await closed).toBeNull();
    await ui.close();
  });

  it('cuts a task authorization edit back to size, or asks for it', async () => {
    const values = { authorization: targets.authorization, credentialGrants: [], credentialPolicies: {} };
    const ui = await open(({ method, path, body }) => {
      if (path.startsWith('/api/authorization/escalation-targets')) return targets;
      if (method === 'PATCH' && path === '/api/tasks/t1/authorization') return body.acceptAttenuation ? { id: 't1', params: {} } : gap;
      if (method === 'POST' && path.startsWith('/api/authorization-requests')) return { id: 'areq' };
      return undefined;
    });
    const limited = ui.run(`saveTaskAuthorization('t1', 'p', ${JSON.stringify(values)})`);
    await dialog(ui).getByRole('button', { name: 'Use my authorization', exact: true }).click();
    expect(await limited).toEqual({ id: 't1', params: {} });
    const asked = ui.run(`saveTaskAuthorization('t1', 'p', ${JSON.stringify(values)})`);
    await dialog(ui).getByRole('button', { name: 'Alert @maintainers', exact: true }).click();
    expect(await asked).toBeNull();
    expect(writes(ui).map((call) => `${call.method} ${call.path.split('?')[0]}`)).toEqual(['PATCH /api/tasks/t1/authorization',
      'PATCH /api/tasks/t1/authorization', 'PATCH /api/tasks/t1/authorization', 'POST /api/authorization-requests']);
    expect(writes(ui)[1]!.body).toMatchObject({ acceptAttenuation: true });
    expect(writes(ui)[3]!.body).toMatchObject({ target: { kind: 'task', taskId: 't1' }, audience: ['@maintainers'] });
    await ui.close();
  });

  it('offers the level audiences wherever an audience is chosen', async () => {
    const ui = await open(() => undefined);
    const options = await ui.run<Array<{ value: string; label: string }>>('humanAudienceOptions()');
    expect(options).toEqual(expect.arrayContaining([{ value: '@maintainers', label: 'Project maintainers' },
      { value: '@admins', label: 'Administrators' }, { value: '@superadmins', label: 'Super-administrators' }]));
    await ui.close();
  });

  it('sends a task form that asks too much to the summoned level', async () => {
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }],
      stages: [{ key: 'do', label: 'Working' }] }];
    const ui = await open(({ method, path, body }) => {
      if (path === '/api/schema') return schema;
      if (path.startsWith('/api/authorization/escalation-targets')) return targets;
      if (method === 'POST' && path === '/api/projects/p/tasks') return body.draft ? { id: 'task_draft', projectId: 'p', params: {} } : gap;
      if (method === 'POST' && path.startsWith('/api/authorization-requests')) return { id: 'areq', status: 'pending' };
      return undefined;
    });
    await ui.run(`openTaskForm('software-dev')`);
    await ui.page.locator('#tf-page').waitFor();
    await ui.page.locator('#tf-page textarea').first().fill('Rename the settings page');
    await ui.page.locator('#tf-queue').click();
    await dialog(ui).getByRole('button', { name: 'Alert @maintainers', exact: true }).click();
    await expect.poll(() => writes(ui).map((call) => `${call.method} ${call.path.split('?')[0]}`)).toEqual([
      'POST /api/projects/p/tasks', 'POST /api/projects/p/tasks', 'POST /api/authorization-requests']);
    const [, draft, request] = writes(ui);
    expect(draft!.body).toMatchObject({ draft: true, allowAttenuation: true });
    expect(request!.body).toMatchObject({ audience: ['@maintainers'], target: { kind: 'task', taskId: 'task_draft', queueAfterApproval: true } });
    await ui.close();
  });

  it('names a vault credential you cannot grant and asks for it with the task', async () => {
    const cap = 'use-credential:item:vi_stripe';
    const credentialTargets = { ...targets, authorization: { level: 'developer', scope: 'projects', projectIds: ['p'] },
      requestedCapabilities: [cap], missingCapabilities: [cap], credentials: [{ capability: cap, label: 'Stripe dashboard' }],
      special: [{ selector: '@admins', eligibleUserIds: ['owner'] }], summon: '@admins' };
    const credentialGap = { status: 403, json: { ...gap.json, summon: '@admins', missingCapabilities: [cap], credentialGrants: [cap] } };
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }],
      stages: [{ key: 'do', label: 'Working' }] }];
    const ui = await open(({ method, path, body }) => {
      if (path === '/api/schema') return schema;
      if (path.startsWith('/api/authorization/escalation-targets')) return credentialTargets;
      if (method === 'POST' && path === '/api/projects/p/tasks') return body.draft ? { id: 'task_draft', projectId: 'p', params: {} } : credentialGap;
      if (method === 'POST' && path.startsWith('/api/authorization-requests')) return { id: 'areq', status: 'pending' };
      return undefined;
    });
    await ui.run(`openTaskForm('software-dev')`);
    await ui.page.locator('#tf-page').waitFor();
    await ui.page.locator('#tf-page textarea').first().fill('Refund the duplicate charge');
    await ui.page.locator('#tf-queue').click();
    await expect.poll(() => dialog(ui).getByRole('heading').innerText()).toBe("You can't grant Stripe dashboard");
    await dialog(ui).getByText('1 missing').click();
    expect(await dialog(ui).locator('.summon-missing .chip').allInnerTexts()).toEqual(['Stripe dashboard']);
    const lookup = ui.calls.find((call: ApiCall) => call.path.startsWith('/api/authorization/escalation-targets'));
    expect(lookup!.body).toMatchObject({ credentialGrants: [cap] });
    await dialog(ui).getByRole('button', { name: 'Alert @admins', exact: true }).click();
    await expect.poll(() => writes(ui).map((call) => `${call.method} ${call.path.split('?')[0]}`)).toEqual([
      'POST /api/projects/p/tasks', 'POST /api/projects/p/tasks', 'POST /api/authorization-requests']);
    expect(writes(ui)[2]!.body).toMatchObject({ credentialGrants: [cap], audience: ['@admins'],
      reason: 'Please grant Stripe dashboard to this task agent.' });
    await ui.close();
  });
});

describe('confirming a merge you cannot make', () => {
  const eligibility = { taskId: 't1', required: true, canMerge: false, blocked: true, repositories: ['acme/site'],
    pullRequests: [{ slug: 'acme/site', number: 7, url: 'https://github.com/acme/site/pull/7' }],
    eligibleUserIds: ['lead'], audience: ['user:lead'], people: [{ id: 'lead', selector: 'user:lead', name: 'Lea Lead' }] };
  const review = async (answer: Record<string, unknown>) => {
    const ui = await open(({ method, path }) => {
      if (path === '/api/tasks/t1/merge-eligibility') return answer;
      if (path === '/api/tasks/t1/attempts') return { attempts: [] };
      if (method === 'POST' && (path === '/api/tasks/t1/escalate' || path === '/api/tasks/t1/signal')) return {};
      return undefined;
    });
    await ui.run(`
      S.selected = 't1';
      S.view = { taskId: 't1', title: 'Change', stage: 'review', status: 'waiting', messages: [], state: {},
        prs: [{ slug: 'acme/site', number: 7, url: 'https://github.com/acme/site/pull/7', state: 'open' }],
        actions: [{ name: 'confirm', label: 'Confirm', kind: 'signal', enabled: true }] };
      document.getElementById('main').insertAdjacentHTML('beforeend', '<div id="tp-foot"></div>');
      document.getElementById('tp-foot').innerHTML = taskActions(S.view);
      wireActions(S.view);
    `);
    return ui;
  };

  it('offers to send the Review to someone with merge access instead', async () => {
    const ui = await review(eligibility);
    await ui.page.locator('[data-act="confirm"]').click();
    await expect.poll(() => dialog(ui).getByRole('heading').innerText()).toBe("You can't merge acme/site#7 on GitHub");
    await dialog(ui).getByRole('button', { name: 'Alert Lea Lead' }).click();
    await expect.poll(() => writes(ui).map((call) => call.path)).toEqual(['/api/tasks/t1/escalate']);
    expect(writes(ui)[0]!.body).toMatchObject({ audience: ['user:lead'], message: expect.stringMatching(/merge/i) });
    await ui.close();
  });

  it('still lets the reviewer approve, and stays out of the way when the merge can proceed', async () => {
    const blocked = await review(eligibility);
    await blocked.page.locator('[data-act="confirm"]').click();
    await dialog(blocked).getByRole('button', { name: 'Confirm anyway' }).click();
    await expect.poll(() => writes(blocked).map((call) => call.path)).toEqual(['/api/tasks/t1/signal']);
    await blocked.close();
    const fine = await review({ ...eligibility, canMerge: true, blocked: false });
    await fine.page.locator('[data-act="confirm"]').click();
    await expect.poll(() => writes(fine).map((call) => call.path)).toEqual(['/api/tasks/t1/signal']);
    expect(await dialog(fine).count()).toBe(0);
    await fine.close();
  });
});
