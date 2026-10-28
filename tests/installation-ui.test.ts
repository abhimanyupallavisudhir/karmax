import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, type ApiHandler } from './helpers/console-page.js';

// Installation cards as one setting per row: choices as segmented controls
// that still save, copyable URLs, folded process groups and setup reference.
afterAll(closeConsoleBrowser);

const paidLaunch = {
  paidLaunch: false, canEnable: false, canManage: true, billingProvider: 'stripe', source: 'stored', contacts: { legal: 'legal@x.test' },
  missing: ['Legal email'], billingMissing: ['Stripe secret key'], completedTasks: ['a'],
  tasks: [{ id: 'a', group: 'Business', title: 'Confirm the legal operator', instructions: 'Use your legal name.' },
    { id: 'b', group: 'Business', title: 'Open banking', instructions: 'Open an account.', href: 'https://bank.test' }],
  stripe: { webhookUrl: 'https://x.test/api/subscriptions/webhook', apiVersion: '2026-06-24.dahlia', webhookEvents: ['invoice.paid'] },
  paddle: { environment: 'live', webhookUrl: 'https://x.test/paddle', checkoutUrl: 'https://x.test/checkout' },
};

async function render(markup: string, wire: string, api: ApiHandler) {
  const ui = await consolePage({ api });
  await ui.run(`S.organizationId = 'org'; S.meta = { siteName: 'tavya' };
    document.getElementById('main').innerHTML = '<div class="installation-settings">' + ${markup} + '</div>'; ${wire}`);
  return ui;
}

describe('Installation → Paid launch', () => {
  it('folds the checklist with a count, keeps the consent visible, and saves the segmented choices', async () => {
    const ui = await render('paidLaunchCard()', 'wirePaidLaunchCard()', ({ method, path }) =>
      path === '/api/settings/paid-launch' ? (method === 'PUT' ? { ok: true } : paidLaunch) : path === '/api/launch' ? {} : undefined);
    const card = ui.page.locator('#paid-launch-card');
    await card.locator('.paid-launch-save').waitFor();
    expect(await card.locator('.inst-checklist > summary').innerText()).toMatch(/^Launch checklist\s+1\/2 done/);
    expect(await card.locator('.inst-checklist').getAttribute('open')).toBeNull();
    expect(await card.locator('.tip-chip').first().innerText()).toBe('2 missing');
    expect(await card.locator('.tip-chip').first().getAttribute('title')).toBe('Still required: Legal email, Stripe secret key');
    expect(await card.getByText('Publishes the policies as yours').isVisible()).toBe(true);
    expect(await card.locator('.paid-launch-enabled').isDisabled()).toBe(true);
    // The webhook URL is shown once, with Copy; the setup steps refer to it.
    expect(await card.locator('.paid-stripe-section .inst-url').allInnerTexts()).toEqual(['https://x.test/api/subscriptions/webhook']);
    expect(await card.locator('.paid-stripe-section [data-inst-copy]').count()).toBe(1);

    await card.getByRole('group', { name: 'Billing provider' }).getByRole('button', { name: 'Paddle' }).click();
    expect(await card.locator('.paid-paddle-section').isVisible()).toBe(true);
    expect(await card.locator('.paid-stripe-section').isVisible()).toBe(false);
    expect(await card.locator('.save-state').innerText()).toBe('Unsaved changes');
    await card.getByRole('group', { name: 'Paddle environment' }).getByRole('button', { name: 'Sandbox' }).click();
    await card.locator('.paid-launch-save').click();
    await expect.poll(() => ui.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
      billingProvider: 'paddle', paddle: { environment: 'sandbox' }, contacts: { legal: 'legal@x.test' }, completedTasks: ['a'] });
    await ui.close();
  });
});

describe('Installation → Agent cards', () => {
  it('says the Connect state once and saves from the one Save button', async () => {
    const platform = { configured: true, webhookConfigured: false, secretKeyConfigured: true, source: 'environment', clientId: 'ca_1',
      callbackUrl: 'https://x.test/cb', webhookUrl: 'https://x.test/wh' };
    const ui = await render('stripePlatformCard()', 'wireStripePlatformCard()', ({ method, path }) =>
      path.endsWith('/payments/stripe/platform') ? (method === 'PUT' ? {} : platform) : undefined);
    const card = ui.page.locator('#stripe-platform-card');
    await card.locator('.stripe-platform-save').waitFor();
    expect(await card.locator('.chip').allInnerTexts()).toEqual(['Webhook secret missing', 'From environment']);
    expect(await card.locator('[data-inst-copy]').evaluateAll((buttons) => buttons.map((b) => (b as HTMLElement).dataset.instCopy)))
      .toEqual(['https://x.test/cb', 'https://x.test/wh']);
    expect(await card.locator('.stripe-platform-save').innerText()).toBe('Save');
    await ui.close();
  });
});

describe('Installation → Email', () => {
  it('switches to SMTP with a segmented control and sends the SMTP fields, TLS from a toggle', async () => {
    const email = { configured: false, canManage: true, providers: [
      { name: 'resend', help: 'Resend help', links: [{ label: 'Sign up', url: 'https://resend.test' }] },
      { name: 'smtp', help: 'SMTP help', links: [] }] };
    const ui = await render('outboundEmailCard()', 'wireOutboundEmailCard()', ({ method, path }) =>
      path === '/api/email' ? email : path === '/api/email/connect' && method === 'POST' ? { detail: 'Connected' } : undefined);
    const card = ui.page.locator('#outbound-email-card');
    await card.locator('#oe-connect').waitFor();
    expect(await card.locator('#oe-test').count()).toBe(0);
    expect(await card.locator('#oe-smtp').isVisible()).toBe(false);
    await card.getByRole('group', { name: 'Provider' }).getByRole('button', { name: 'SMTP' }).click();
    expect(await card.locator('#oe-smtp').isVisible()).toBe(true);
    expect(await card.locator('#oe-help .info-dot').getAttribute('title')).toBe('SMTP help');
    await card.locator('#oe-host').fill('smtp.example.com');
    await card.locator('#oe-port').fill('465');
    await card.locator('#oe-secure').check();
    expect(await card.locator('#oe-secure').getAttribute('class')).toBe('toggle');
    await card.locator('#oe-connect').click();
    await expect.poll(() => ui.calls.find((call) => call.method === 'POST')?.body)
      .toMatchObject({ provider: 'smtp', host: 'smtp.example.com', port: '465', secure: true });
    await ui.close();
  });
});

describe('Installation → Health', () => {
  const sample = { supported: true, ts: Date.now(), canKill: true, totals: { procs: 3, cpuPct: 2, rssMb: 600 }, groups: [
    { key: '1', kind: 'app', label: 'tavya (gateway + worker)', protected: true, cpuPct: 1, rssMb: 500, procs: [{ pid: 1, cmd: 'node main', cpuPct: 1, rssMb: 500, ageSec: 60 }] },
    { key: '9', kind: 'untracked', label: 'other tavya children', cpuPct: 1, rssMb: 100, procs: [
      { pid: 7, cmd: 'esbuild', cpuPct: 1, rssMb: 50, ageSec: 30 }, { pid: 8, cmd: 'git fetch', cpuPct: 0, rssMb: 50, ageSec: 5 }] }] };

  it('folds each process group, keeps it open across refreshes, and stops instead of killing', async () => {
    const ui = await consolePage();
    const draw = `document.getElementById('main').innerHTML = '<div id="proc-panel">' + procPanelHtml(${JSON.stringify(sample)}) + '</div>';
      wireProcPanel(document.getElementById('proc-panel'))`;
    await ui.run(`S.meta = { siteName: 'tavya' }; ${draw}`);
    const page = ui.page;
    expect(await page.locator('thead th').allInnerTexts()).toEqual(['Process', 'Age', 'CPU', 'Memory', '']);
    expect((await page.locator('.proc-toggle').allInnerTexts()).map((text) => text.replace(/\s+/g, ' '))).toEqual(['tavya', 'Other processes 2']);
    expect(await page.locator('.proc-row:visible').count()).toBe(0);
    // One lock, on the protected group; none on its rows.
    expect(await page.locator('.proc-lock').count()).toBe(1);
    await page.locator('.proc-toggle', { hasText: 'Other processes' }).click();
    expect(await page.locator('.proc-row:visible').count()).toBe(2);
    expect(await page.locator('.proc-row:visible .proc-kill').allInnerTexts()).toEqual(['Stop', 'Stop']);
    expect(await page.locator('.proc-row:visible td.cmd').first().getAttribute('title')).toBe('PID 7 · esbuild');
    await ui.run(draw);
    expect(await page.locator('.proc-row:visible').count()).toBe(2);
    expect(await page.locator('.proc-foot').innerText()).toMatch(/^3 processes · 2\.0% CPU · 600 MB · updated /);
    await ui.close();
  });

  it('shows load as one tile, no memory tile, and the admission pause only when it holds', async () => {
    const ui = await consolePage();
    const html = (slots: Record<string, unknown>) => ui.run<string>(`hostDiagHtml(${JSON.stringify({
      host: { loadavg: [1.6, 1, 0.5], cores: 8, loadPerCore: 0.2, freeMemMb: 300, totalMemMb: 8000 },
      agentSlots: { capacity: 3, inUse: 1, waiting: 0, minFreeMb: 512, maxLoadFactor: 1, ...slots },
      runtimeLifecycle: [{ action: 'runtime.started', ts: Date.now() - 3_600_000 }] })})`);
    const calm = await html({});
    expect(calm).not.toMatch(/Free RAM|paused|Runtime lifecycle/);
    expect(calm).toContain('Load per core · 8 cores');
    expect(calm).toContain('<div class="l">Up</div>');
    expect(await html({ memoryTight: true })).toContain('New agent turns paused: free memory under 512 MB (300 MB free)');
    await ui.close();
  });
});

describe('Installation → Appearance and Managed compute', () => {
  it('shows the current logo and opens the picker on Change', async () => {
    const ui = await render('appearanceCard()', 'wireAppearanceCard()', ({ path }) =>
      path === '/api/settings/global/appearance' ? { icon: 'knot' } : path === '/api/settings/installation' ? { siteName: 'tavya' } : undefined);
    await ui.page.locator('#brand-current img').waitFor();
    expect(await ui.page.locator('#brand-current').innerText()).toBe('Knot');
    expect(await ui.page.locator('#brand-picker').isVisible()).toBe(false);
    await ui.page.getByRole('button', { name: 'Change' }).click();
    expect(await ui.page.locator('#brand-picker').isVisible()).toBe(true);
    await ui.close();
  });

  it('lists connected providers and folds the rest with a count', async () => {
    const ui = await consolePage();
    await ui.run(`document.getElementById('main').innerHTML = managedComputeMarkup(${JSON.stringify({
      providers: [{ provider: 'e2b', enabled: true, status: 'ok', running: 2, seconds: 3600, organizations: 1, costMicros: 0, chargedMicros: 0 }] })})`);
    expect(await ui.page.locator('#main > .computer-providers .computer-provider').count()).toBe(1);
    const fold = ui.page.locator('details.managed-off');
    expect(await fold.locator('summary').innerText()).toMatch(/^Not connected\s+\d+$/);
    expect(await fold.getAttribute('open')).toBeNull();
    await ui.close();
  });
});
