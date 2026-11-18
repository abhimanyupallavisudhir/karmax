// Screens of Plan & billing (Free, paid with managed compute, a gifted plan)
// and Installation → Managed compute, rendered from the real app.js functions
// and styles. Run: node design/billing/shoot.cjs [outDir]  (default /tmp/billing)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`Missing function: ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unterminated function: ${name}`);
}
const constant = (name) => { const start = src.indexOf(`const ${name} = `); return src.slice(start, src.indexOf('\n};\n', start) + 3); };
const out = process.argv[2] || '/tmp/billing';
fs.mkdirSync(out, { recursive: true });
const GB = 1024 ** 3;
const catalog = [
  { id: 'free', name: 'Free', monthlyBasePriceCents: 0, maxMembers: 1, maxActiveAgentRuns: 5, storageBytes: 5 * GB, computeCreditMicros: 0 },
  { id: 'individual', name: 'Individual', monthlyBasePriceCents: 900, maxMembers: 1, maxActiveAgentRuns: 10, storageBytes: 50 * GB, computeCreditMicros: 5e6 },
  { id: 'team', name: 'Team', monthlyBasePriceCents: 1900, monthlyAdditionalActiveUserPriceCents: 500, maxActiveAgentRuns: 20, additionalActiveUserAgentRuns: 5,
    storageBytes: 100 * GB, additionalActiveUserStorageBytes: 10 * GB, computeCreditMicros: 10e6, additionalActiveUserComputeCreditMicros: 3e6 },
];
const compute = (used, credit) => ({ usedMicros: used, creditMicros: credit, from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1), providers: ['hetzner', 'e2b'] });
const base = { deployment: 'hosted', currentMemberCount: 1, overMemberLimit: false, activeAgentRuns: 0, queuedAgentRuns: 0, storagePackBytes: 100 * GB,
  storagePacks: 0, giftedStoragePacks: 0, computePacks: 0, giftedComputePacks: 0, computePackCreditMicros: 10e6 };
const packs = { storagePack: { bytes: 100 * GB, monthlyPriceCents: 400, available: true }, computePack: { creditMicros: 10e6, monthlyPriceCents: 1000, available: true } };
const screens = {
  'plan-free': [{ ...base, plan: 'free', planName: 'Free', currentMonthlyPriceCents: 0, maxMembers: 1, maxActiveAgentRuns: 5, storageQuotaBytes: 5 * GB,
    includedStorageBytes: 5 * GB, storageUsedBytes: 3.4 * GB, computeCreditMicros: 0, includedComputeCreditMicros: 0, compute: compute(0, 0) },
  { managed: true, providerConfigured: true, plan: 'free', billedPlan: 'free', status: 'none', catalog, canManage: true, ...packs }],
  // A new organization's free trial: $5 for 14 days, $1.30 of it used (computers and the included model).
  'plan-free-trial': [{ ...base, plan: 'free', planName: 'Free', currentMonthlyPriceCents: 0, maxMembers: 1, maxActiveAgentRuns: 5, storageQuotaBytes: 5 * GB,
    includedStorageBytes: 5 * GB, storageUsedBytes: 0.2 * GB, computeCreditMicros: 0, includedComputeCreditMicros: 0,
    compute: { ...compute(1.3e6, 0), includedModel: 'xiaomi/mimo-v2.6-pro', byProvider: [{ provider: 'e2b', usedMicros: 0.9e6 }, { provider: 'openrouter', usedMicros: 0.4e6 }],
      trial: { creditMicros: 5e6, startsAt: Date.UTC(2026, 9, 6), endsAt: Date.UTC(2026, 9, 20), usedMicros: 1.3e6, leftMicros: 3.7e6, monthMicros: 5e6 } } },
  { managed: true, providerConfigured: true, plan: 'free', billedPlan: 'free', status: 'none', catalog, canManage: true, ...packs }],
  'plan-individual': [{ ...base, plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 2300, maxMembers: 1, maxActiveAgentRuns: 10,
    activeAgentRuns: 3, queuedAgentRuns: 1, storageQuotaBytes: 150 * GB, includedStorageBytes: 50 * GB, storagePacks: 1, storageUsedBytes: 56 * GB,
    computeCreditMicros: 15e6, includedComputeCreditMicros: 5e6, computePacks: 1, compute: compute(12.4e6, 15e6) },
  { managed: true, providerConfigured: true, plan: 'individual', billedPlan: 'individual', status: 'active', catalog, canManage: true, ...packs,
    storagePacks: 1, computePacks: 1, currentPeriodEnd: Date.UTC(2026, 10, 3) }],
  // Auto top-up on: $10 bought this month and kept until used, $0.85 held by computers running now.
  'plan-auto-top-up': [{ ...base, plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 900, maxMembers: 1, maxActiveAgentRuns: 10,
    activeAgentRuns: 2, storageQuotaBytes: 50 * GB, includedStorageBytes: 50 * GB, storageUsedBytes: 21 * GB,
    computeCreditMicros: 5e6, includedComputeCreditMicros: 5e6, compute: { ...compute(9.2e6, 5e6), topUpMicros: 10e6, heldMicros: 0.85e6 } },
  { managed: true, providerConfigured: true, plan: 'individual', billedPlan: 'individual', status: 'active', catalog, canManage: true, ...packs,
    currentPeriodEnd: Date.UTC(2026, 10, 3), autoTopUp: { enabled: true, offered: true, capCents: 5000, amountCents: 1000, spentCents: 1000 } }],
  'plan-gifted-operator': [{ ...base, plan: 'team', planName: 'Team', currentMemberCount: 4, maxMembers: null, maxActiveAgentRuns: 35, monthlyAdditionalActiveUserPriceCents: 500,
    storageQuotaBytes: 330 * GB, includedStorageBytes: 130 * GB, giftedStoragePacks: 2, storageUsedBytes: 41 * GB,
    computeCreditMicros: 29e6, includedComputeCreditMicros: 19e6, giftedComputePacks: 1, compute: compute(2.1e6, 29e6) },
  { managed: true, providerConfigured: true, plan: 'team', billedPlan: 'free', status: 'none', catalog, canManage: true, canGift: true, gift: { plan: 'team' },
    giftedStoragePacks: 2, giftedComputePacks: 1, ...packs }],
  // A gifted Individual as its owner sees it: packs and Team are bought at checkout.
  'plan-gifted-individual': [{ ...base, plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 900, maxMembers: 1, maxActiveAgentRuns: 10,
    storageQuotaBytes: 50 * GB, includedStorageBytes: 50 * GB, storageUsedBytes: 31 * GB,
    computeCreditMicros: 5e6, includedComputeCreditMicros: 5e6, compute: compute(3.6e6, 5e6) },
  { managed: true, providerConfigured: true, plan: 'individual', billedPlan: 'free', status: 'none', catalog, canManage: true, gift: { plan: 'individual' }, ...packs }],
  // …and once it bought packs: a subscription of packs alone beside the gift.
  'plan-gifted-with-packs': [{ ...base, plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 900, maxMembers: 1, maxActiveAgentRuns: 10,
    storageQuotaBytes: 150 * GB, includedStorageBytes: 50 * GB, storagePacks: 1, storageUsedBytes: 31 * GB,
    computeCreditMicros: 25e6, includedComputeCreditMicros: 5e6, computePacks: 2, compute: compute(3.6e6, 25e6) },
  { managed: true, providerConfigured: true, plan: 'individual', billedPlan: 'free', status: 'active', catalog, canManage: true, gift: { plan: 'individual' }, ...packs,
    storagePacks: 1, computePacks: 2, billedMonthlyPriceCents: 2400, currentPeriodEnd: Date.UTC(2026, 10, 3) }],
  // A gifted Team (nisada-personal): its one gifted seat taken; the next is bought at checkout.
  'plan-gifted-team-seats': [{ ...base, plan: 'team', planName: 'Team', currentMonthlyPriceCents: 1900, maxMembers: null, maxActiveAgentRuns: 20,
    monthlyAdditionalActiveUserPriceCents: 500, storageQuotaBytes: 100 * GB, includedStorageBytes: 100 * GB, storageUsedBytes: 41 * GB,
    computeCreditMicros: 10e6, includedComputeCreditMicros: 10e6, compute: compute(6.2e6, 10e6) },
  { managed: true, providerConfigured: true, plan: 'team', billedPlan: 'free', status: 'none', catalog, canManage: true, gift: { plan: 'team', seats: 1 }, ...packs,
    teamSeats: { total: 1, used: 1, gifted: 1, paid: 0, included: 1, limit: 1, autoBill: false, priceCents: 500 } }],
  // …once it bought two seats and a 100 GB pack beside the gift, one seat still free.
  'plan-gifted-team-seats-bought': [{ ...base, plan: 'team', planName: 'Team', currentMemberCount: 2, currentMonthlyPriceCents: 1900, maxMembers: null, maxActiveAgentRuns: 25,
    monthlyAdditionalActiveUserPriceCents: 500, storageQuotaBytes: 210 * GB, includedStorageBytes: 110 * GB, storagePacks: 1, storageUsedBytes: 41 * GB,
    computeCreditMicros: 13e6, includedComputeCreditMicros: 13e6, compute: compute(6.2e6, 13e6) },
  { managed: true, providerConfigured: true, plan: 'team', billedPlan: 'free', status: 'active', catalog, canManage: true, gift: { plan: 'team', seats: 1 }, ...packs,
    storagePacks: 1, billedMonthlyPriceCents: 1400, currentPeriodEnd: Date.UTC(2026, 11, 2),
    teamSeats: { total: 3, used: 2, gifted: 1, paid: 2, included: 1, limit: 3, autoBill: false, priceCents: 500 } }],
  // A paid Team with a seat bought ahead of an invitation, and a $10 pack.
  'plan-team-seats': [{ ...base, plan: 'team', planName: 'Team', currentMemberCount: 3, currentMonthlyPriceCents: 3900, maxMembers: null, maxActiveAgentRuns: 30,
    monthlyAdditionalActiveUserPriceCents: 500, storageQuotaBytes: 120 * GB, includedStorageBytes: 120 * GB, storageUsedBytes: 64 * GB,
    computeCreditMicros: 26e6, includedComputeCreditMicros: 16e6, computePacks: 1, compute: compute(8.9e6, 26e6) },
  { managed: true, providerConfigured: true, plan: 'team', billedPlan: 'team', status: 'active', catalog, canManage: true, ...packs, computePacks: 1,
    currentPeriodEnd: Date.UTC(2026, 11, 2), teamSeats: { total: 4, used: 3, gifted: 0, paid: 3, included: 1, limit: null, autoBill: true, priceCents: 500 } }],
  // tavya credits folded open (task_mwlxentuf97ab46ddc): where they come from, what they paid for, and the price.
  'plan-credits-info': [{ ...base, plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 1900, maxMembers: 1, maxActiveAgentRuns: 10,
    activeAgentRuns: 2, storageQuotaBytes: 50 * GB, includedStorageBytes: 50 * GB, storageUsedBytes: 21 * GB,
    computeCreditMicros: 25e6, includedComputeCreditMicros: 5e6, computePacks: 1, giftedComputePacks: 1,
    compute: { ...compute(9.4e6, 25e6), includedModel: 'xiaomi/mimo-v2.6-pro', heldMicros: 0.6e6, topUpMicros: 0,
      byProvider: [{ provider: 'hetzner', usedMicros: 5.1e6 }, { provider: 'e2b', usedMicros: 1.2e6 }, { provider: 'openrouter', usedMicros: 2.3e6 }, { provider: 'composio', usedMicros: 0.8e6 }] } },
  { managed: true, providerConfigured: true, plan: 'individual', billedPlan: 'individual', status: 'active', catalog, canManage: true, ...packs, computePacks: 1,
    currentPeriodEnd: Date.UTC(2026, 11, 3), autoTopUp: { enabled: false, offered: true, capCents: 5000, amountCents: 1000, spentCents: 0 } }, ['compute']],
  // A gifted Team with gifted packs: storage credits folded open.
  'plan-gifted-info': [{ ...base, plan: 'team', planName: 'Team', currentMemberCount: 2, currentMonthlyPriceCents: 1900, maxMembers: null, maxActiveAgentRuns: 25,
    storageQuotaBytes: 310 * GB, includedStorageBytes: 110 * GB, giftedStoragePacks: 2, storageUsedBytes: 41 * GB,
    computeCreditMicros: 23e6, includedComputeCreditMicros: 13e6, giftedComputePacks: 1, compute: compute(6.2e6, 23e6) },
  { managed: true, providerConfigured: true, plan: 'team', billedPlan: 'free', status: 'none', catalog, canManage: true, gift: { plan: 'team', seats: 2 }, ...packs,
    teamSeats: { total: 2, used: 2, gifted: 2, paid: 0, included: 2, limit: 2, autoBill: false, priceCents: 500 } }, ['storage', 'people']],
  // Canceled at the period end: Keep plan withdraws it.
  'plan-ending': [{ ...base, plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 900, maxMembers: 1, maxActiveAgentRuns: 10,
    storageQuotaBytes: 50 * GB, includedStorageBytes: 50 * GB, storageUsedBytes: 12 * GB, computeCreditMicros: 5e6, includedComputeCreditMicros: 5e6, compute: compute(1.1e6, 5e6) },
  { managed: true, providerConfigured: true, plan: 'individual', billedPlan: 'individual', status: 'active', catalog, canManage: true, ...packs,
    cancelAtPeriodEnd: true, currentPeriodEnd: Date.UTC(2026, 11, 2) }],
};
const managedCompute = { providers: [
  { provider: 'hetzner', enabled: true, status: 'ready', config: { maxRunning: 8, region: 'fsn1' }, running: 3, organizations: 4, costMicros: 6.1e6, chargedMicros: 12.2e6, seconds: 512 * 3600 },
  { provider: 'e2b', enabled: false, status: 'ready', config: { maxRunning: 20 }, running: 0, organizations: 0, costMicros: 0, chargedMicros: 0, seconds: 0 },
] };
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 860, height: 600 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'UTC' });
  await page.route('http://shots.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(root, 'web', pathname)), contentType: 'font/woff2' });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="light"><body><main class="main"><div class="main-inner" style="padding:20px;max-width:820px"><div class="settings-section-title"><div>Plan &amp; billing</div></div><div class="card plan-card" id="shot"></div></div></main></body></html>' });
  });
  await page.goto('http://shots.test/');
  await page.addStyleTag({ path: path.join(root, 'web/styles.css') });
  await page.addScriptTag({ content: `
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const siteName = () => 'tavya';
    const S = { launch: { paidLaunch: true, ready: true, acceptance: { checkout: { terms: 'v', billing: 'v' } } } };
    const policyLinks = () => '<a href="#">Terms</a> and <a href="#">Billing terms</a>';
    ${constant('COMPUTER_PROVIDERS')}
    const PLAN_ACTIVE = ['active', 'trialing', 'past_due'];
    ${['formatBytes', 'policyTip', 'policyAcceptanceMarkup', 'planMoney', 'planDollars', 'planMeter', 'planPackName', 'planStepper', 'planRow', 'planLines', 'planCreditUse', 'checkoutTermsTip', 'planBillingMarkup', 'profilePlansMarkup', 'managedRunning', 'managedComputeMarkup', 'includedModelRow'].map(fn).join('\n')}` });
  for (const [name, [e, state, open]] of Object.entries(screens)) {
    await page.evaluate(([e, state, open]) => { S.planInfoOpen = new Set(open || []);
      document.querySelector('#shot').innerHTML = planBillingMarkup(e, state); document.querySelector('.plan-operator')?.setAttribute('open', ''); }, [e, state, open]);
    await page.locator('.main-inner').screenshot({ path: path.join(out, `${name}.png`) });
  }
  // Profile → Plans & billing: every organization one belongs to, one open into its card.
  await page.evaluate(([e, state]) => {
    S.planInfoOpen = new Set(); S.profilePlanOpen = 'o2';
    document.querySelector('.settings-section-title div').textContent = 'Plans & billing';
    document.querySelector('#shot').className = 'card';
    document.querySelector('#shot').innerHTML = profilePlansMarkup({ organizations: [
      { organizationId: 'o1', name: 'acme', planName: 'Team', gift: null, storagePacks: 1, computePacks: 2, giftedStoragePacks: 0, giftedComputePacks: 0,
        credits: { usedMicros: 18.2e6, heldMicros: 0, availableMicros: 17.8e6, totalMicros: 36e6 } },
      { organizationId: 'o2', name: 'nisada-personal', planName: 'Team', gift: { plan: 'team' }, storagePacks: 0, computePacks: 0, giftedStoragePacks: 2, giftedComputePacks: 1,
        credits: { usedMicros: 6.2e6, heldMicros: 0, availableMicros: 16.8e6, totalMicros: 23e6 } },
      { organizationId: 'o3', name: 'side-project', planName: 'Individual', gift: null, storagePacks: 0, computePacks: 0, giftedStoragePacks: 0, giftedComputePacks: 0,
        credits: { usedMicros: 5e6, heldMicros: 0, availableMicros: 0, totalMicros: 5e6 } },
      { organizationId: 'o4', name: 'sandbox', planName: 'Free', gift: null, credits: null }] });
    document.querySelector('#profile-plan-o2').innerHTML = planBillingMarkup(e, state);
  }, screens['plan-gifted-info']);
  await page.locator('.main-inner').screenshot({ path: path.join(out, 'profile-plans.png') });
  await page.evaluate((view) => {
    document.querySelector('.settings-section-title div').textContent = 'Managed compute';
    document.querySelector('#shot').innerHTML = managedComputeMarkup(view, includedModelRow({ model: 'xiaomi/mimo-v2.6-pro', enabled: true,
      keyConfigured: true, organizations: 12, costMicros: 3.4e6, chargedMicros: 6.8e6 }));
  }, managedCompute);
  await page.locator('.main-inner').screenshot({ path: path.join(out, 'installation-managed-compute.png') });
  await browser.close();
  console.log(`screens in ${out}`);
})().catch((error) => { console.error(error); process.exit(1); });
