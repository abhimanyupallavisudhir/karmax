import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// Settings → Agents: every account once, as a row with its live state; the rare
// controls fold under it. It used to list each account twice (chips, then an
// "Availability" block naming it by its internal id with five controls apiece).
const H = 3_600_000;
const login = (provider: string, account: string) =>
  ({ key: `login:org_x:${provider}:${account}`, label: `${provider}:${account}`, provider, kind: 'login', account });
const credentials = [login('claude', 'work'), login('codex', 'home'),
  { key: 'key:handle:kimi-k', label: 'kimi:k', provider: 'kimi', kind: 'key', account: 'k' }];
const [claude, codex, kimi] = credentials.map((c) => c.key) as [string, string, string];

async function agentsCard(claudeUsage?: Record<string, unknown>) {
  const accounts = [
    { id: claude, status: 'available', inUse: 0, maxConcurrent: 10 },
    { id: codex, status: 'exhausted', resetAt: Date.now() + 5 * H, inUse: 0, maxConcurrent: 1_000_000 },
    { id: kimi, status: 'available', inUse: 2, maxConcurrent: 4 },
  ];
  const usage = { [claude]: claudeUsage ?? { ok: true, at: Date.now(), session: { pct: 23, resetAt: Date.now() + H }, week: { pct: 91, resetAt: Date.now() + 50 * H } } };
  let policy: Record<string, unknown> = {};
  const ui = await consolePage({ api: ({ method, path, body }: ApiCall) => {
    const base = '/api/organizations/org_x';
    if (method === 'GET' && path.split('?')[0] === `${base}/credentials`) return { credentials, global: { own: policy, enabled: credentials.map((c) => c.key)
      .filter((k) => !((policy.off as string[] | undefined) ?? []).includes(k)) } };
    if (path === `${base}/credentials/policy`) { policy = body.policy; return { ok: true }; }
    if (path === `${base}/accounts`) return { logins: credentials.filter((c) => c.kind === 'login') };
    if (path === `${base}/accounts/status`) return { accounts };
    if (path === `${base}/accounts/usage`) return { usage, pollable: [claude] };
    return method === 'POST' ? { ok: true } : undefined;
  } });
  await ui.run(`S.organizationId = 'org_x';
    document.getElementById('main').innerHTML = '<div class="settings-section-title" id="settings-agents"><div>Agents</div></div>' + agentAccountsCard();
    hydrateAccounts('org_x')`);
  await ui.page.locator('.cred-row.acct').first().waitFor();
  const posts = (suffix: string) => ui.calls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix)).map((call) => call.body);
  return { ui, row: (key: string) => ui.page.locator(`.cred-row.acct[data-key="${key}"]`), posts };
}

describe('Settings → Agents accounts list', () => {
  it('shows each account once, by name, with one status phrase and its fullest quota', async () => {
    const { ui, row } = await agentsCard();
    expect(await ui.page.locator('.cred-row').count()).toBe(3);
    expect(await ui.page.locator('#accounts-card').innerText()).not.toContain('org_x');
    expect(await row(claude).locator('.cred-label').innerText()).toBe('claude:work');
    expect(await row(claude).locator('.acct-state').innerText()).toBe('Available');
    expect(await row(codex).locator('.acct-state').innerText()).toMatch(/^Out of quota · back in (4h 59m|5h 0m)$/);
    expect(await row(kimi).locator('.acct-state').innerText()).toBe('2 running');
    // The tightest window is the one shown; every window is in its tip.
    expect(await row(claude).locator('.acct-meter').innerText()).toMatch(/91%\s*week/);
    expect(await row(claude).locator('.acct-meter').getAttribute('title')).toContain('Session 23%');
    expect(await row(codex).locator('.acct-meter').count()).toBe(0);
    // Details stay folded until asked for.
    expect(await ui.page.locator('.acct-detail:visible').count()).toBe(0);
    await row(claude).getByRole('button', { name: 'Details of claude:work' }).click();
    expect(await row(claude).locator('.acct-detail').isVisible()).toBe(true);
    expect(await row(claude).getByRole('button', { name: 'Details of claude:work' }).getAttribute('aria-expanded')).toBe('true');
    expect(await ui.page.locator('#accounts-card .usage-recheck-all').isVisible()).toBe(true);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('switches an account off, sets its turns at once and when it is unavailable', async () => {
    const { ui, row, posts } = await agentsCard();
    await row(codex).getByRole('checkbox', { name: 'Use codex:home' }).click();
    await expect.poll(() => posts('/credentials/policy')).toEqual([{ scope: 'global', policy: { on: [], off: [codex], explainerOnly: [] } }]);
    await ui.page.locator(`.cred-row.acct.off[data-key="${codex}"]`).waitFor();

    await row(claude).locator('.acct-expand').click();
    await row(claude).getByRole('textbox', { name: 'Turns at once' }).fill('3');
    await row(claude).getByRole('textbox', { name: 'Turns at once' }).press('Enter');
    await expect.poll(() => posts('/accounts/concurrency')).toEqual([{ accountId: claude, max: 3 }]);

    // The fold stays open across the re-render.
    await row(claude).getByRole('button', { name: 'Choose time…' }).click();
    const until = row(claude).getByLabel('Unavailable until', { exact: true });
    await until.fill('2099-01-02T03:04');
    await expect.poll(() => posts('/accounts/availability')).toEqual([{ accountId: claude, status: 'exhausted',
      resetAt: await ui.run(`new Date('2099-01-02T03:04').getTime()`) }]);

    await row(codex).locator('.acct-expand').click();
    expect(await row(codex).getByLabel('Unavailable until', { exact: true }).inputValue()).not.toBe('');
    await row(codex).getByRole('button', { name: 'Mark available' }).click();
    await expect.poll(() => posts('/accounts/availability').at(-1)).toEqual({ accountId: codex, status: 'available' });
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('reorders by dragging a row handle, staged behind Save', async () => {
    const { ui, row, posts } = await agentsCard();
    const handle = (await row(kimi).locator('.cred-drag').boundingBox())!;
    const target = (await row(claude).boundingBox())!;
    await ui.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await ui.page.mouse.down();
    await ui.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 6);
    await ui.page.mouse.move(target.x + 200, target.y + 4);
    await ui.page.mouse.move(target.x + 200, target.y + 5);
    await ui.page.mouse.up();
    const order = () => ui.page.locator('.cred-row.acct').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-key')));
    expect(await order()).toEqual([kimi, claude, codex]);
    await ui.page.getByRole('button', { name: /Unsaved changes/ }).click();
    await expect.poll(() => posts('/credentials/policy')).toEqual([{ scope: 'global', policy: { order: [kimi, claude, codex] } }]);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('keeps the last numbers when a check fails, saying so', async () => {
    const { ui, row } = await agentsCard({ ok: true, at: Date.now() - 2 * H, failedAt: Date.now(), failure: 'probe-failed: usage probe timed out',
      week: { pct: 40, resetAt: Date.now() + 50 * H } });
    expect(await row(claude).locator('.acct-meter').innerText()).toMatch(/40%\s*week/);
    await row(claude).locator('.acct-expand').click();
    const checked = row(claude).locator('.acct-checked');
    expect(await checked.innerText()).toBe('Couldn’t check just now · read 2h ago');
    expect(await checked.getAttribute('title')).toBe('probe-failed: usage probe timed out');
    await ui.close();
  });

  it('says a check failed rather than blaming a setup-token sign-in', async () => {
    const { ui, row } = await agentsCard({ ok: false, at: Date.now(), reason: 'probe-failed: no usage numbers' });
    await row(claude).locator('.acct-expand').click();
    expect(await row(claude).locator('.acct-detail').innerText()).toContain('Couldn’t check usage');
    expect(await row(claude).locator('.acct-detail').innerText()).not.toContain('setup-token');
    await ui.close();
  });

  it('keeps rename, delete and sign-in under the fold', async () => {
    const { ui, row } = await agentsCard();
    await row(kimi).locator('.acct-expand').click();
    expect(await row(kimi).getByTitle('Edit API key').isVisible()).toBe(true);
    expect(await row(kimi).getByTitle('Delete API key').isVisible()).toBe(true);
    await row(claude).locator('.acct-expand').click();
    expect(await row(claude).getByRole('button', { name: 'Rename' }).isVisible()).toBe(true);
    expect(await row(claude).getByRole('button', { name: 'Sign in again' }).isVisible()).toBe(true);
    await ui.close();
  });
});
