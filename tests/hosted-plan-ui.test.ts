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

const esc = (value: unknown) => String(value);
const markup = Function('esc', `${extractFunction('policyTip')}; ${extractFunction('organizationPlanMarkup')}; return organizationPlanMarkup;`)(esc);

describe('hosted plan organization UI', () => {
  it('shows plan limits and explains shared queued concurrency', () => {
    const free = markup({
      deployment: 'hosted', planName: 'Free', currentMonthlyPriceCents: 0,
      maxMembers: 1, unlimitedProjects: true, maxActiveAgentRuns: 5,
      currentMemberCount: 1, overMemberLimit: false,
      activeAgentRuns: 1, queuedAgentRuns: 2,
    });
    expect(free).toContain('Free');
    expect(free).toContain('$0/month');
    expect(free).toContain('1 user');
    expect(free).toContain('Unlimited projects');
    expect(free).toContain('5 active agent runs');
    expect(free).toContain('1 active · 2 queued');
    expect(free).toContain('shared maximum');
    expect(free).toContain('waits in queue');
  });

  it('renders Team per-active-user pricing returned by the server', () => {
    const team = markup({
      deployment: 'hosted', planName: 'Team', currentMonthlyPriceCents: 2_900,
      maxMembers: null, unlimitedProjects: true, maxActiveAgentRuns: 30,
      currentMemberCount: 3, overMemberLimit: false,
      activeAgentRuns: 3, queuedAgentRuns: 0,
    });
    expect(team).toContain('Team');
    expect(team).toContain('$29/month');
    expect(team).toContain('3 active users · unlimited');
    expect(team).toContain('30 active agent runs');
  });

  it('shows an actionable paused state after an over-member downgrade', () => {
    const overLimit = markup({
      deployment: 'hosted', planName: 'Free', currentMonthlyPriceCents: 0,
      currentMemberCount: 3, maxMembers: 1, overMemberLimit: true,
      unlimitedProjects: true, maxActiveAgentRuns: 5, activeAgentRuns: 1, queuedAgentRuns: 2,
    });
    expect(overLimit).toContain('3 of 1 user · over limit');
    expect(overLimit).toContain('Agent runs are paused');
    expect(overLimit).toContain('Remove 2 extra members');
    expect(overLimit).toContain('People &amp; authorization');
    expect(overLimit).toContain('restore Team');
    expect(overLimit).toContain('Running agents may finish');
    expect(overLimit).toContain('no new agent run will start');
  });

  it('makes private-install behavior explicit instead of showing hosted limits', () => {
    const privateInstall = markup({ deployment: 'private' });
    expect(privateInstall).toContain('Private installation');
    expect(privateInstall).toContain('Hosted plan restrictions are not applied');
  });

  it('loads the server entitlement view from Organization settings', () => {
    const organization = extractFunction('organizationView');
    const hydration = extractFunction('hydrateOrganizationView');
    expect(organization).toContain('href="#settings-plan"');
    expect(organization).toContain('id="org-plan"');
    expect(hydration).toContain("read('entitlements')");
    expect(hydration).toContain('organizationPlanMarkup(entitlements)');
  });

  it('loads the selected organization agent queue instead of the legacy global queue', () => {
    const endpoint = extractFunction('agentQueueApi');
    expect(endpoint).toContain('projectById(S.projectId)?.organizationId');
    expect(endpoint).toContain('?organizationId=');
  });

  it('renders subscription prices and owner controls from server-derived state', () => {
    const subscription = extractFunction('hydrateOrganizationSubscription');
    expect(subscription).toContain('monthlyBasePriceCents');
    expect(subscription).toContain('monthlyAdditionalActiveUserPriceCents');
    expect(subscription).toContain('state.canManage');
    expect(subscription).toContain('Only an organization owner can administer this subscription');
    expect(subscription).toContain("policyAcceptanceMarkup('checkout', 'checkout-policy-acceptance')");
    expect(subscription).toContain('acceptedPolicies: acceptance.accepted');
    expect(subscription).toContain('policyVersions: acceptance.versions');
    expect(subscription).toContain('Cancel online at period end');
    expect(subscription).not.toContain('$9 / month');
    expect(subscription).not.toContain('$19 / month');
  });

  it('renders the public three-plan page from the central launch catalog', () => {
    const pricing = extractFunction('renderPricing');
    expect(pricing).toContain('S.launch?.pricingCatalog');
    expect(pricing).toContain('Free, Individual, and Team');
    expect(pricing).toContain('Unlimited projects');
    expect(pricing).toContain('maxActiveAgentRuns');
    expect(pricing).toContain('monthlyAdditionalActiveUserPriceCents');
    expect(pricing).toContain('additionalActiveUserAgentRuns');
    expect(pricing).toContain('Cancel online from Organization settings');
    expect(pricing).not.toContain('Simple subscription');
    expect(pricing).not.toContain('S.launch?.subscription');
  });
});
