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
    ${['formatBytes', 'policyTip', 'policyAcceptanceMarkup', 'planMoney', 'planDollars', 'planMeter', 'planStepper', 'planBillingMarkup', 'managedComputeMarkup'].map(fn).join('\n')}` });
  for (const [name, [e, state]] of Object.entries(screens)) {
    await page.evaluate(([e, state]) => { document.querySelector('#shot').innerHTML = planBillingMarkup(e, state); document.querySelector('.plan-operator')?.setAttribute('open', ''); }, [e, state]);
    await page.locator('.main-inner').screenshot({ path: path.join(out, `${name}.png`) });
  }
  await page.evaluate((view) => {
    document.querySelector('.settings-section-title div').textContent = 'Managed compute';
    document.querySelector('#shot').innerHTML = managedComputeMarkup(view);
  }, managedCompute);
  await page.locator('.main-inner').screenshot({ path: path.join(out, 'installation-managed-compute.png') });
  await browser.close();
  console.log(`screens in ${out}`);
})().catch((error) => { console.error(error); process.exit(1); });
