import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { validateDeployment } from '../src/config/deployment.js';
import { ACCEPTANCE_POLICIES, CHECKOUT_DISCLOSURES, POLICY_SLUGS, POLICY_VERSION,
  assertPaidLaunchReady, assertPolicyAcceptance, launchConfig,
  policyDocument, policyVersions, publicLaunchInfo } from '../src/launch/legal.js';

const completeEnv = () => ({
  KARMAX_PAID_LAUNCH: '1', KARMAX_LEGAL_ENTITY_NAME: 'Configured Operator',
  KARMAX_FOUNDER_REVIEWED_POLICY_VERSION: POLICY_VERSION,
  KARMAX_LEGAL_ENTITY_COUNTRY: 'Configured Country', KARMAX_GOVERNING_LAW: 'Configured Law',
  KARMAX_LEGAL_NOTICE_ADDRESS: 'Configured Notice Address', KARMAX_LEGAL_EMAIL: 'legal@example.test',
  KARMAX_PRIVACY_EMAIL: 'privacy@example.test', KARMAX_SECURITY_EMAIL: 'security@example.test',
  KARMAX_INCIDENT_EMAIL: 'incident@example.test', KARMAX_DPA_EMAIL: 'dpa@example.test',
  KARMAX_BILLING_EMAIL: 'billing@example.test',
} as NodeJS.ProcessEnv);

describe('paid-launch policies', () => {
  it('routes every discoverable policy slug to one immutable versioned document', () => {
    const info = publicLaunchInfo({});
    expect(info.policies.map((policy) => policy.slug)).toEqual(POLICY_SLUGS);
    expect(POLICY_SLUGS).toEqual(['terms', 'acceptable-use', 'privacy', 'billing', 'subprocessors', 'security', 'data', 'dpa']);
    for (const slug of POLICY_SLUGS) {
      expect(policyDocument(slug)).toMatchObject({ slug, version: POLICY_VERSION });
      expect(policyDocument(slug)?.draftNotice).toMatch(/not legal advice/i);
    }
    expect(policyDocument('invented')).toBeUndefined();
  });

  it('requires an affirmative click on every current applicable version and appends evidence', async () => {
    expect(ACCEPTANCE_POLICIES.signup).toEqual(['terms', 'acceptable-use', 'privacy']);
    expect(ACCEPTANCE_POLICIES.checkout).toEqual(['terms', 'privacy', 'billing']);
    expect(() => assertPolicyAcceptance('signup', false, policyVersions('signup'))).toThrow(/affirmative/);
    expect(() => assertPolicyAcceptance('signup', true, { ...policyVersions('signup'), terms: 'stale' })).toThrow(/current terms/);
    const versions = assertPolicyAcceptance('signup', true, policyVersions('signup'));
    const store = (await Store.create(':memory:'));
    (await store.recordPolicyAcceptance({ userId: 'u1', email: 'a@example.test', context: 'signup', versions, acceptedAt: 10 }));
    (await store.recordPolicyAcceptance({ userId: 'u1', email: 'a@example.test', organizationId: 'org_1', context: 'checkout',
      versions: policyVersions('checkout'), acceptedAt: 20, checkoutRequestReference: 'request_1',
      checkoutSessionReference: 'cs_1', commercialTerms: { planId: 'team', monthlyBasePriceCents: 1900,
        monthlyAdditionalActiveUserPriceCents: 500, currency: 'usd', billingInterval: 'month', ...CHECKOUT_DISCLOSURES } }));
    expect((await store.policyAcceptances('u1'))).toMatchObject([
      { context: 'signup', versions, acceptedAt: 10 },
      { organizationId: 'org_1', context: 'checkout', versions: policyVersions('checkout'), acceptedAt: 20,
        checkoutRequestReference: 'request_1', checkoutSessionReference: 'cs_1', commercialTerms: {
          planId: 'team', monthlyBasePriceCents: 1900, monthlyAdditionalActiveUserPriceCents: 500,
          currency: 'usd', billingInterval: 'month', autoRenews: true,
        } },
    ]);
    (await store.close());
  });

  it('keeps all unresolved entity, jurisdiction, and contact facts behind a fail-closed checklist', () => {
    const empty = launchConfig({ KARMAX_PAID_LAUNCH: '1' });
    expect(empty.ready).toBe(false);
    expect(empty.missing).toContain('KARMAX_LEGAL_ENTITY_NAME');
    expect(empty.missing).toContain('KARMAX_FOUNDER_REVIEWED_POLICY_VERSION');
    expect(empty.missing).toContain('KARMAX_GOVERNING_LAW');
    expect(publicLaunchInfo({ KARMAX_PAID_LAUNCH: '1' }).operator).toBeNull();
    expect(() => assertPaidLaunchReady({ KARMAX_PAID_LAUNCH: '1' })).toThrow(/launch checklist/);
    expect(launchConfig(completeEnv())).toMatchObject({ paidLaunch: true, ready: true, missing: [] });
    expect(() => validateDeployment({
      KARMAX_DEPLOYMENT: 'hosted', KARMAX_PUBLIC_URL: 'https://krmax.test',
      KARMAX_PREVIEW_ORIGIN: 'https://preview.krmax.test', KARMAX_AUTH_SECRET: 'x'.repeat(32),
      KARMAX_VAULT_KEY: 'x'.repeat(32), KARMAX_WORLD_REF_KEY: 'x'.repeat(32),
      KARMAX_DATABASE_URL: 'postgres://db/krmax', KARMAX_TEMPORAL_ADDRESS: 'temporal:7233',
      KARMAX_OBJECT_STORE: 's3', KARMAX_S3_ENDPOINT: 'https://objects.test', KARMAX_S3_BUCKET: 'krmax',
      KARMAX_S3_ACCESS_KEY_ID: 'key', KARMAX_S3_SECRET_ACCESS_KEY: 'secret',
      KARMAX_CLOUD_WORLD_PROVIDER: 'e2b', KARMAX_PAID_LAUNCH: '1',
    })).toThrow(/explicit launch checklist.*KARMAX_FOUNDER_REVIEWED_POLICY_VERSION.*KARMAX_LEGAL_ENTITY_NAME/);
  });

  it('publishes the central Free, Individual, and Team catalog exactly', () => {
    expect(publicLaunchInfo({}).pricingCatalog).toEqual([
      expect.objectContaining({ id: 'free', monthlyBasePriceCents: 0, maxMembers: 1,
        unlimitedProjects: true, maxActiveAgentRuns: 5, additionalActiveUserAgentRuns: 0,
        currency: 'usd', billingInterval: 'month' }),
      expect.objectContaining({ id: 'individual', monthlyBasePriceCents: 900, maxMembers: 1,
        unlimitedProjects: true, maxActiveAgentRuns: 10, additionalActiveUserAgentRuns: 0,
        currency: 'usd', billingInterval: 'month' }),
      expect.objectContaining({ id: 'team', monthlyBasePriceCents: 1900, includedActiveUsers: 1,
        monthlyAdditionalActiveUserPriceCents: 500, maxMembers: null, unlimitedProjects: true,
        maxActiveAgentRuns: 20, additionalActiveUserAgentRuns: 5,
        currency: 'usd', billingInterval: 'month' }),
    ]);
  });

  it('publishes configured public operator details without enabling checkout or claiming draft approval', () => {
    const stored = { paidLaunch: false, operatorName: 'Public Sole Trader', operatorCountry: 'United Kingdom',
      legalNoticeAddress: 'Approved public correspondence address' };
    const info = publicLaunchInfo({}, stored, 'Tavya');
    expect(info).toMatchObject({ paidLaunch: false, ready: false, operator: {
      name: stored.operatorName, country: stored.operatorCountry, legalNoticeAddress: stored.legalNoticeAddress,
    } });
    expect(info.draftNotice).toMatch(/pending final operator approval/);
    expect(info.draftNotice).not.toMatch(/founder-reviewed/);
    expect(policyDocument('terms', {}, stored, 'Tavya')?.operator).toEqual(info.operator);
    expect(publicLaunchInfo({}, { operatorName: 'Incomplete' }).operator).toBeNull();
    expect(() => assertPaidLaunchReady({}, stored)).toThrow(/not enabled/);
  });

  it('discloses privacy grounds and complaints without claiming an unverified deletion schedule', () => {
    const privacy = JSON.stringify(policyDocument('privacy', {}, undefined, 'Tavya'));
    expect(privacy).toContain('performance of a contract');
    expect(privacy).toContain('legitimate interests');
    expect(privacy).toContain('withdraw it at any time');
    expect(privacy).toContain('https://ico.org.uk/make-a-complaint/');
    expect(privacy).not.toContain('krmax');
    const data = JSON.stringify(policyDocument('data'));
    expect(data).toContain('not an automatic purge');
    expect(data).toContain('applicable period or expiry criteria');
    expect(data).toContain('completed deletion requests reapplied');
    expect(JSON.stringify(policyDocument('terms'))).toContain('mandatory consumer rights');
  });

  it('distinguishes operator subprocessors, customer destinations and retained copies', () => {
    const privacy = JSON.stringify(policyDocument('privacy', {}, undefined, 'Tavya'));
    expect(privacy).toContain('MCP');
    expect(privacy).toContain('not automatically an operator subprocessor');
    expect(privacy).toContain('Disconnecting an integration does not erase');
    expect(privacy).toContain('no service-wide promise');
    expect(privacy).toContain('does not replace those requirements');
    const providers = JSON.stringify(policyDocument('subprocessors'));
    for (const name of ['E2B', 'Daytona', 'one.com', 'Resend', 'Composio']) expect(providers).toContain(name);
    expect(providers).toContain('does not establish which region is in use');
    expect(providers).toContain('Publishing an updated list alone does not replace');
  });

  it('incorporates a scoped processing addendum without claiming execution or launch approval', () => {
    const dpa = policyDocument('dpa')!;
    expect(dpa.title).toBe('Data Processing Addendum');
    const text = JSON.stringify(dpa);
    for (const obligation of ['documented', 'confidentiality', 'Subprocessors', 'International',
      'without undue delay', 'return or delete', 'audits and inspections', 'its subprocessor']) {
      expect(text).toContain(obligation);
    }
    expect(text).toContain('not limited to sensitive or regulated-sector data');
    expect(text).toContain('not itself an executed international-transfer instrument');
    expect(text).toContain('operator-approval gate');
    expect(JSON.stringify(policyDocument('terms'))).toContain('Data Processing Addendum linked with these Terms');
    expect(JSON.stringify(policyDocument('terms'))).not.toContain('support, and improve');
    expect(launchConfig({ ...completeEnv(), KARMAX_FOUNDER_REVIEWED_POLICY_VERSION: '2026-09-24' }))
      .toMatchObject({ ready: false, missing: ['KARMAX_FOUNDER_REVIEWED_POLICY_VERSION'] });
    expect(() => assertPolicyAcceptance('signup', true, { ...policyVersions('signup'), terms: '2026-09-24' }))
      .toThrow(/current terms/);
  });
});
