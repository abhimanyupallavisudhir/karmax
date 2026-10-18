import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const markup = Function('esc', 'S', 'location', `
  const policyTip = (text) => '<i title="' + esc(text) + '">ⓘ</i>';
  const siteName = () => 'tavya';
  const policyAcceptanceMarkup = () => '<label class="policy-acceptance"></label>';
  const COMPUTER_PROVIDERS = { e2b: { name: 'E2B' }, hetzner: { name: 'Hetzner' } };
  ${extractFunction('formatBytes')}
  const PLAN_ACTIVE = ['active', 'trialing', 'past_due'];
  ${extractFunction('planMoney')}; ${extractFunction('planDollars')}; ${extractFunction('planMeter')}; ${extractFunction('planStepper')};
  ${extractFunction('planBillingMarkup')}; return planBillingMarkup;`)(esc, { launch: { paidLaunch: true, ready: true } }, { search: '' });
const GB = 1024 ** 3;
const catalog = [
  { id: 'free', name: 'Free', monthlyBasePriceCents: 0, maxActiveAgentRuns: 5, storageBytes: 5 * GB, computeCreditMicros: 0 },
  { id: 'individual', name: 'Individual', monthlyBasePriceCents: 900, maxActiveAgentRuns: 10, storageBytes: 50 * GB, computeCreditMicros: 5_000_000 },
  { id: 'team', name: 'Team', monthlyBasePriceCents: 1_900, monthlyAdditionalActiveUserPriceCents: 500, maxActiveAgentRuns: 20,
    additionalActiveUserAgentRuns: 5, storageBytes: 100 * GB, additionalActiveUserStorageBytes: 10 * GB,
    computeCreditMicros: 10_000_000, additionalActiveUserComputeCreditMicros: 3_000_000 },
];
const entitlements = (overrides: Record<string, unknown> = {}) => ({ deployment: 'hosted', plan: 'free', planName: 'Free',
  currentMonthlyPriceCents: 0, maxMembers: 1, currentMemberCount: 1, overMemberLimit: false, maxActiveAgentRuns: 5,
  activeAgentRuns: 0, queuedAgentRuns: 0, storageQuotaBytes: 5 * GB, includedStorageBytes: 5 * GB, storageUsedBytes: 2 * GB,
  storagePacks: 0, giftedStoragePacks: 0, storagePackBytes: 100 * GB, computeCreditMicros: 0, includedComputeCreditMicros: 0,
  computePacks: 0, giftedComputePacks: 0, computePackCreditMicros: 10_000_000, compute: null, ...overrides });
const status = (overrides: Record<string, unknown> = {}) => ({ managed: true, providerConfigured: true, plan: 'free', billedPlan: 'free',
  status: 'none', catalog, canManage: true, canGift: false, activeUsers: 1, storagePacks: 0, computePacks: 0,
  storagePack: { bytes: 100 * GB, monthlyPriceCents: 400, available: true }, computePack: { creditMicros: 10_000_000, monthlyPriceCents: 1_000, available: true },
  ...overrides });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Plan & billing', () => {
  it('shows each limit against its use, and plan choices on Free', () => {
    const html = markup(entitlements({ activeAgentRuns: 1, queuedAgentRuns: 2 }), status());
    expect(text(html)).toMatch(/^\s*Free\s+People/);
    expect(text(html)).toContain('100 GB storage (+10 GB/person)');
    expect(text(html)).toMatch(/People 1 of 1/);
    expect(text(html)).toMatch(/5 at once 1 working, 2 waiting/);
    expect(text(html)).toMatch(/2 GB of 5 GB/);
    expect(html).toContain('role="meter"');
    // Compute shows only where the installation runs computers itself.
    expect(text(html)).not.toContain('Compute');
    expect(html).toContain('data-plan="individual"');
    expect(html).toContain('Choose Team');
    expect(html).toContain('policy-acceptance');
    // No pack steppers without a paid plan.
    expect(html).not.toContain('billing-packs');
    // No stray provider usage: the organization's own E2B bill is not a plan fact.
    expect(text(html)).not.toMatch(/Usage|incurred|estimated/i);
  });

  it('shows the month\'s compute against its credit with pack steppers on a paid plan', () => {
    const html = markup(entitlements({ plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 2_300,
      storageQuotaBytes: 150 * GB, includedStorageBytes: 50 * GB, storagePacks: 1, storageUsedBytes: 60 * GB,
      computeCreditMicros: 15_000_000, includedComputeCreditMicros: 5_000_000, computePacks: 1,
      compute: { usedMicros: 13_000_000, creditMicros: 15_000_000, from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1), providers: ['e2b'] } }),
    status({ plan: 'individual', billedPlan: 'individual', status: 'active', storagePacks: 1, computePacks: 1, currentPeriodEnd: Date.UTC(2026, 10, 3) }));
    expect(text(html)).toMatch(/Individual \$23\/month · renews/);
    expect(text(html)).toMatch(/\$13\.00 of \$15\.00 this month/);
    expect(html).toMatch(/plan-meter near/);
    expect(html).toContain('50 GB with Individual + 100 GB in 1 pack');
    expect(html).toContain('$5.00 with Individual + $10.00 in 1 pack');
    expect(html).toContain('data-kind="storage"');
    expect(html).toContain('data-kind="compute" data-packs="2"');
    expect(html).toContain('Each pack adds $10.00 of compute a month for $10/month');
    expect(html).toContain('Upgrade to Team');
    expect(html).toContain('billing-cancel');
    expect(html).not.toContain('data-plan="team" disabled');
  });

  it('says Free has no managed compute, and that an over-limit organization\'s agents are paused', () => {
    const html = markup(entitlements({ currentMemberCount: 3, overMemberLimit: true,
      compute: { usedMicros: 0, creditMicros: 0, from: 0, to: Date.UTC(2026, 10, 1), providers: ['hetzner'] } }), status());
    expect(text(html)).toMatch(/Compute .*With a paid plan/);
    expect(text(html)).toMatch(/3 of 1 over the limit: agents are paused/);
    expect(text(html)).toContain('compute a month');
  });

  it('lets only an owner change the plan, and shows the operator\'s gifts folded away', () => {
    const member = markup(entitlements(), status({ canManage: false }));
    expect(member).toMatch(/billing-checkout" data-plan="individual" disabled/);
    const operator = markup(entitlements(), status({ canGift: true, gift: { plan: 'team' }, giftedComputePacks: 2 }));
    expect(operator).toContain('<details class="plan-operator">');
    expect(operator).toContain('id="billing-gift-compute"');
    expect(operator).toMatch(/value="2" class="plan-gift-count" aria-label="Gifted compute packs"/);
    // A gifted plan is not for sale.
    expect(operator).not.toContain('billing-checkout');
  });

  it('makes private-install behavior explicit instead of showing hosted limits', () => {
    const privateInstall = markup({ deployment: 'private' }, null);
    expect(privateInstall).toContain('Private installation');
    expect(privateInstall).toContain('Hosted plan limits don’t apply');
  });

  it('loads the plan into Organization settings', () => {
    const organization = extractFunction('organizationView');
    const hydration = extractFunction('hydratePlanAndBilling');
    expect(organization).toContain('href="#settings-plan"');
    expect(organization).toContain('id="org-plan"');
    expect(organization).toContain('id="settings-billing"');
    expect(hydration).toContain('/entitlements');
    expect(hydration).toContain('/subscription/status');
    expect(hydration).toContain('acceptedPolicies: acceptance.accepted');
    expect(hydration).toContain('policyVersions: acceptance.versions');
  });

  it('loads the selected organization agent queue instead of the legacy global queue', () => {
    const endpoint = extractFunction('agentQueueApi');
    expect(endpoint).toContain('projectById(S.projectId)?.organizationId');
    expect(endpoint).toContain('?organizationId=');
  });

  it('renders the public three-plan page from the central launch catalog', () => {
    const pricing = extractFunction('renderPricing');
    expect(pricing).toContain('S.launch?.pricingCatalog');
    expect(pricing).toContain('Free, Individual, and Team');
    expect(pricing).toContain('Unlimited projects');
    expect(pricing).toContain('maxActiveAgentRuns');
    expect(pricing).toContain('monthlyAdditionalActiveUserPriceCents');
    expect(pricing).toContain('computeCreditMicros');
    expect(pricing).toContain('S.launch?.managedCompute');
    expect(pricing).toContain('additionalActiveUserAgentRuns');
    expect(pricing).toContain('Cancel online from Organization settings');
    expect(pricing).not.toContain('Simple subscription');
    expect(pricing).not.toContain('S.launch?.subscription');
  });
});
