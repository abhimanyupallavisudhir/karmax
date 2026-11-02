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
  const checkoutTermsTip = () => policyTip('Plans renew monthly until canceled.');
  const COMPUTER_PROVIDERS = { e2b: { name: 'E2B' }, hetzner: { name: 'Hetzner' } };
  ${extractFunction('formatBytes')}
  const PLAN_ACTIVE = ['active', 'trialing', 'past_due'];
  ${extractFunction('planMoney')}; ${extractFunction('planDollars')}; ${extractFunction('planMeter')}; ${extractFunction('planPackName')}; ${extractFunction('planStepper')};
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
const status = (overrides: Record<string, unknown> = {}): any => ({ managed: true, providerConfigured: true, plan: 'free', billedPlan: 'free',
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
    expect(html).toContain('50 GB with Individual + 1 × 100 GB pack');
    expect(html).toContain('$5.00 with Individual + 1 × $10 pack');
    expect(html).toContain('data-kind="storage"');
    expect(html).toContain('data-kind="compute" data-packs="2"');
    expect(html).toContain('Each $10 pack adds $10 of compute a month for $10/month');
    // Packs are named by what they give, on their buttons and beside their count.
    expect(html).toContain('aria-label="Add a 100 GB pack"');
    expect(html).toContain('aria-label="Remove a $10 pack"');
    expect(text(html)).toMatch(/− 1 \+ 100 GB pack\b/);
    expect(text(html)).toMatch(/− 1 \+ \$10 pack\b/);
    expect(html).toContain('Upgrade to Team');
    expect(html).toContain('billing-cancel');
    expect(html).not.toContain('data-plan="team" disabled');
  });

  it('adds top-up credit to the month\'s, counts what running computers hold, and offers auto top-up in one row', () => {
    const paid = { plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 900, computeCreditMicros: 5_000_000,
      includedComputeCreditMicros: 5_000_000, compute: { usedMicros: 4_000_000, heldMicros: 1_500_000, topUpMicros: 10_000_000,
        creditMicros: 5_000_000, from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1), providers: ['e2b'] } };
    const auto = { enabled: false, offered: true, capCents: 5_000, amountCents: 1_000, spentCents: 0 };
    const html = markup(entitlements(paid), status({ plan: 'individual', billedPlan: 'individual', status: 'active', autoTopUp: auto }));
    expect(text(html)).toMatch(/\$4\.00 of \$15\.00 this month/);
    expect(html).toContain('$10.00 topped up, kept until used');
    expect(html).toContain('$1.50 is held for computers running now');
    expect(html).toMatch(/aria-valuenow="5500000"/);
    const row = html.slice(html.indexOf('data-limit="auto-top-up"'));
    expect(row).toMatch(/class="toggle billing-auto-topup" type="checkbox" aria-label="Auto top-up"\s+>/);
    expect(row).toMatch(/id="billing-auto-cap"[^>]*value="50"/);
    expect(row).toContain('When compute runs low, buy $10 more at once on the saved card, up to this much a month. Top-ups last until used.');
    // On, declined: says so; a member sees it but cannot change it.
    const declined = markup(entitlements(paid), status({ plan: 'individual', billedPlan: 'individual', status: 'active', canManage: false,
      autoTopUp: { ...auto, enabled: true, spentCents: 1_000, pausedUntil: Date.now() + 86_400_000, lastError: 'the payment was declined' } }));
    expect(text(declined)).toMatch(/\/month · \$10 this month\s*Card declined · retries/);
    expect(declined).toMatch(/billing-auto-topup"[^>]*checked disabled/);
    // Not offered (its billing terms not approved yet) and off: no row at all.
    expect(markup(entitlements(paid), status({ plan: 'individual', billedPlan: 'individual', status: 'active',
      autoTopUp: { ...auto, offered: false } }))).not.toContain('auto-top-up');
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

  it('lets a gifted plan buy packs at checkout, and a gifted Individual buy Team', () => {
    const giftedTeam = markup(entitlements({ plan: 'team', planName: 'Team', currentMonthlyPriceCents: 1_900, maxMembers: null,
      storageQuotaBytes: 100 * GB, includedStorageBytes: 100 * GB,
      compute: { usedMicros: 0, creditMicros: 10_000_000, from: 0, to: Date.UTC(2026, 10, 1), providers: ['e2b'] } }),
    status({ plan: 'team', gift: { plan: 'team' } }));
    expect(text(giftedTeam)).toMatch(/^\s*Team Gifted\s+People/);
    // The first pack opens checkout; there is nothing to remove yet.
    expect(giftedTeam).toMatch(/billing-buy" data-kind="storage" data-packs="1" data-add aria-label="Add a 100 GB pack"/);
    expect(giftedTeam).toMatch(/billing-buy" data-kind="compute" data-packs="1" data-add/);
    expect(giftedTeam).toMatch(/billing-packs" data-kind="storage" data-packs="-1" aria-label="Remove a 100 GB pack" disabled/);
    // No plan choices or cancel on a gift; no seat counts without its seats.
    expect(giftedTeam).not.toContain('Upgrade to Team');
    expect(giftedTeam).not.toContain('billing-checkout');
    expect(giftedTeam).not.toContain('billing-cancel');

    const giftedIndividual = markup(entitlements({ plan: 'individual', planName: 'Individual' }), status({ plan: 'individual', gift: { plan: 'individual' } }));
    expect(giftedIndividual).toMatch(/class="btn sm billing-buy" data-plan="team"\s*>Upgrade to Team/);
    // A member sees no controls; neither does anyone while checkout is closed.
    expect(markup(entitlements({ plan: 'individual', planName: 'Individual' }), status({ plan: 'individual', gift: { plan: 'individual' }, canManage: false })))
      .not.toMatch(/billing-buy" data-kind/);
    expect(markup(entitlements({ plan: 'individual', planName: 'Individual' }), status({ plan: 'individual', gift: { plan: 'individual' }, providerConfigured: false })))
      .not.toContain('billing-buy');
  });

  it('changes the packs bought beside a gift on their own subscription, and shows what it bills', () => {
    const packs = status({ plan: 'individual', gift: { plan: 'individual' }, billedPlan: 'free', status: 'active', storagePacks: 2,
      billedMonthlyPriceCents: 800, currentPeriodEnd: Date.UTC(2026, 10, 3) });
    const html = markup(entitlements({ plan: 'individual', planName: 'Individual', storagePacks: 2, storageQuotaBytes: 250 * GB }), packs);
    expect(text(html)).toMatch(/Individual Gifted Packs \$8\/month · renews/);
    expect(html).toMatch(/billing-packs" data-kind="storage" data-packs="3" data-add/);
    expect(html).toMatch(/billing-packs" data-kind="storage" data-packs="1" aria-label="Remove/);
    expect(html).not.toContain('billing-buy');
    // Team goes onto the same subscription; the payment method is managed in Billing.
    expect(html).toMatch(/billing-change" data-plan="team"/);
    expect(html).toContain('billing-portal');
    expect(html).not.toContain('billing-cancel');
    // The last pack removed: the subscription ends with its period, and the steppers show none.
    const ending = markup(entitlements({ plan: 'individual', planName: 'Individual', storagePacks: 2 }), { ...packs, cancelAtPeriodEnd: true });
    expect(text(ending)).toMatch(/Packs \$8\/month · end/);
    expect(ending).toMatch(/data-kind="storage" data-packs="1" data-add/);
    // Packs left after the gift was removed take a plan onto their subscription.
    const ungifted = markup(entitlements({ storagePacks: 2 }), { ...packs, plan: 'free', gift: null });
    expect(ungifted).toMatch(/billing-change" data-plan="individual"/);
    expect(ungifted).not.toContain('billing-checkout');
    expect(ungifted).not.toContain('policy-acceptance');
  });

  it('shows a Team\'s seats and lets its owner add one ahead of an invitation, or remove an unused one', () => {
    const team = entitlements({ plan: 'team', planName: 'Team', currentMonthlyPriceCents: 2_900, maxMembers: null, currentMemberCount: 2 });
    const paid = status({ plan: 'team', billedPlan: 'team', status: 'active', currentPeriodEnd: Date.UTC(2026, 10, 3),
      teamSeats: { total: 3, used: 2, gifted: 0, paid: 2, included: 1, limit: null, autoBill: true, priceCents: 500 } });
    const html = markup(team, paid);
    expect(text(html)).toMatch(/People ⓘ 2 of 3 seats 1 free − 3 \+ seats/);
    expect(html).toMatch(/billing-seats" data-kind="seats" data-packs="4" data-add aria-label="Add a seat"/);
    // Never below the people there.
    expect(html).toMatch(/billing-seats" data-kind="seats" data-packs="2" aria-label="Remove a seat"\s*>/);
    expect(markup(team, { ...paid, teamSeats: { ...paid.teamSeats, total: 2, paid: 1 } }))
      .toMatch(/data-packs="1" aria-label="Remove a seat" disabled/);
    expect(html).toContain('Someone who joins without a free seat is billed one.');
    // A member sees the seats, not the controls.
    expect(markup(team, { ...paid, canManage: false })).not.toContain('billing-seats');
    // Someone joined without a seat: Bill seats, not the stepper.
    const short = markup(entitlements({ plan: 'team', planName: 'Team', maxMembers: null, currentMemberCount: 3 }),
      { ...paid, seatDeficit: 1, teamSeats: { ...paid.teamSeats, used: 3, total: 2 } });
    expect(short).toContain('billing-sync');
    expect(text(short)).toContain('1 seat not yet billed');
    // A Team the operator set directly bills nothing: no Bill seats, no stepper.
    const direct = markup(entitlements({ plan: 'team', planName: 'Team', maxMembers: null, currentMemberCount: 2 }),
      status({ plan: 'team', seatDeficit: 0, teamSeats: { total: null, used: 2, gifted: 0, paid: 0, included: 0, limit: null, autoBill: false, priceCents: 500 } }));
    expect(text(direct)).toMatch(/People 2 people/);
    expect(direct).not.toContain('billing-sync');
    expect(direct).not.toContain('billing-seats');
  });

  it('lets a gifted Team buy its first seat at checkout, then change seats beside the gift', () => {
    const team = entitlements({ plan: 'team', planName: 'Team', maxMembers: null, currentMemberCount: 1 });
    const gifted = status({ plan: 'team', gift: { plan: 'team', seats: 1 },
      teamSeats: { total: 1, used: 1, gifted: 1, paid: 0, included: 1, limit: 1, autoBill: false, priceCents: 500 } });
    const html = markup(team, gifted);
    expect(text(html)).toMatch(/People ⓘ 1 of 1 seat all taken − 1 \+ seat/);
    expect(html).toMatch(/billing-buy" data-kind="seats" data-packs="2" data-add aria-label="Add a seat"/);
    expect(html).toContain('1 seat gifted; each more is $5/month');
    const beside = markup(team, { ...gifted, billedPlan: 'free', status: 'active', billedMonthlyPriceCents: 900, storagePacks: 1,
      currentPeriodEnd: Date.UTC(2026, 10, 3), teamSeats: { ...gifted.teamSeats, total: 2, paid: 1, limit: 2 } });
    expect(text(beside)).toMatch(/Team Gifted Seats &amp; packs \$9\/month · renews/);
    expect(beside).toMatch(/billing-seats" data-kind="seats" data-packs="3" data-add/);
    expect(beside).not.toMatch(/billing-buy" data-kind="seats"/);
  });

  it('keeps a plan whose cancellation is scheduled', () => {
    const ending = markup(entitlements({ plan: 'individual', planName: 'Individual', currentMonthlyPriceCents: 900 }),
      status({ plan: 'individual', billedPlan: 'individual', status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: Date.UTC(2026, 10, 3) }));
    expect(text(ending)).toMatch(/Individual Ends/);
    expect(ending).toContain('billing-resume');
    expect(ending).not.toContain('billing-cancel');
    expect(markup(entitlements({ plan: 'individual', planName: 'Individual' }),
      status({ plan: 'individual', billedPlan: 'individual', status: 'active', currentPeriodEnd: Date.UTC(2026, 10, 3) }))).not.toContain('billing-resume');
  });

  it('gifts Team seats and names gifted packs by what they give', () => {
    const operator = markup(entitlements({ plan: 'team', planName: 'Team', maxMembers: null, currentMemberCount: 2 }),
      status({ canGift: true, gift: { plan: 'team', seats: 4 } }));
    expect(operator).toMatch(/id="billing-gift-seats"[^>]*value="4"/);
    expect(text(operator)).toContain('100 GB packs');
    expect(text(operator)).toContain('$10 compute packs');
    expect(markup(entitlements(), status({ canGift: true, gift: { plan: 'individual' } }))).toMatch(/id="billing-gift-seats"[^>]*hidden/);
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
