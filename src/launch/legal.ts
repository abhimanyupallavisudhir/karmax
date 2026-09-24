/**
 * Launch-policy source of truth.
 *
 * This copy is a launch draft pending operator approval, not legal advice. Keep
 * the version beside the text: acceptance evidence is useful only when it can be
 * tied to the exact disclosure a person saw.
 */
import { HOSTED_PLANS } from '../domain/entitlements.js';

export const POLICY_VERSION = '2026-09-24';
export const POLICY_EFFECTIVE_DATE = 'September 24, 2026';
export const POLICY_DRAFT_NOTICE = 'Launch draft pending final operator approval — not legal advice or a statement of completed legal review.';

export type PolicySlug = 'terms' | 'acceptable-use' | 'privacy' | 'billing' | 'subprocessors' | 'security' | 'data' | 'dpa';
export type AcceptanceContext = 'signup' | 'checkout';

export interface PolicyDocument {
  slug: PolicySlug;
  title: string;
  summary: string;
  version: string;
  effectiveDate: string;
  sections: Array<{ heading: string; paragraphs: string[]; bullets?: string[] }>;
}

const docs: Record<PolicySlug, Omit<PolicyDocument, 'version' | 'effectiveDate'>> = {
  terms: {
    slug: 'terms', title: 'Terms of Service', summary: 'The agreement for using krmax and its hosted agent-orchestration service.',
    sections: [
      { heading: 'Agreement and operator', paragraphs: [
        'These Terms are an initial launch draft between you and the service operator identified in the launch configuration. Do not publish paid checkout until that identity and the governing-law fields are completed.',
        'By creating an account or buying a subscription, you affirmatively accept the versions shown at that action. If you use krmax for an organization, you represent that you may accept for it.',
      ] },
      { heading: 'The service', paragraphs: [
        'krmax coordinates AI agents, repositories, isolated workspaces, credentials, approvals, and related project records. Outputs can be incomplete or wrong. You remain responsible for reviewing work and choosing permissions, budgets, and deployment targets.',
        'Third-party services remain governed by their own terms. Availability can change when a repository host, model provider, cloud-workspace provider, payment provider, or customer-supplied integration changes or is unavailable.',
      ] },
      { heading: 'Your content and instructions', paragraphs: [
        'You retain rights in content you submit. You authorize the operator and applicable subprocessors to host, copy, transmit, and process it only as needed to provide, secure, support, and improve the service as described in the Privacy Policy.',
        'You are responsible for having rights to repositories, prompts, data, credentials, and instructions you connect, and for configuring agent access appropriately.',
      ] },
      { heading: 'Accounts, suspension, and termination', paragraphs: [
        'Keep account credentials secure and promptly report suspected compromise. The operator may limit or suspend access to protect the service, comply with law, address nonpayment, or investigate material violations of these Terms or the Acceptable Use Policy.',
        'An organization owner may cancel a paid subscription online from Organization settings → Plan & billing. Cancellation stops the next renewal; access continues through the paid period unless a refund or immediate termination is stated. Account deletion is a separate request described in Data controls.',
      ] },
      { heading: 'Disclaimers and unresolved legal terms', paragraphs: [
        'To the extent permitted by the law selected in the completed launch configuration, the service is provided as available and without promises not expressly made here. No compliance certification is claimed by this draft.',
        'Nothing in these Terms excludes mandatory consumer rights, liability for fraud or fraudulent misrepresentation, or liability for death or personal injury caused by negligence where that liability cannot lawfully be excluded. Any choice of governing law or courts is subject to the protections and courts available to consumers under mandatory applicable law.',
        'The launch checklist fails closed on the contracting entity, governing law, legal-notice address, contacts, and founder review of this exact version. Billing provider configuration is validated separately by the canonical organization subscription service. This draft does not invent a liability cap or dispute forum; qualified counsel should decide whether the final terms require those or other additions, which must ship as a new version.',
      ] },
    ],
  },
  'acceptable-use': {
    slug: 'acceptable-use', title: 'Acceptable Use Policy', summary: 'Safety boundaries for people, agents, repositories, credentials, and spending.',
    sections: [
      { heading: 'Use systems only with authority', paragraphs: ['Do not use krmax or an agent to access, test, alter, disrupt, purchase from, or communicate with systems or people unless you have authority to do so.'], bullets: [
        'No credential theft, phishing, malware, destructive payloads, or bypassing access controls.',
        'No unlawful surveillance, exploitation, harassment, fraud, or deceptive impersonation.',
        'No unauthorized vulnerability testing, spam, denial of service, or attempts to evade provider safeguards.',
        'No content or activity that violates applicable law or another person’s rights.',
      ] },
      { heading: 'Agent permissions and spend', paragraphs: [
        'Use the least access and spending authority reasonably needed. Review irreversible or high-impact actions and do not use approval limits to conceal or split a prohibited transaction.',
        'You must monitor autonomous work and promptly stop activity that behaves unexpectedly. The operator may preserve relevant audit records and suspend activity while investigating credible abuse or security reports.',
      ] },
      { heading: 'Reporting', paragraphs: ['Report suspected abuse through the security/contact page. Good-faith security research must follow the disclosure instructions there.'] },
    ],
  },
  privacy: {
    slug: 'privacy', title: 'Privacy Policy', summary: 'What krmax processes, why, where providers fit, and the choices available to you.',
    sections: [
      { heading: 'Roles and data categories', paragraphs: [
        'For account, authentication, support, product telemetry, and billing records, the configured service operator generally determines why and how data is processed.',
        'For repository, prompt, task, workspace, credential, and output data a business customer submits, the customer generally determines the purpose and the operator processes that data to provide the service. The contract and requested DPA control where applicable law assigns different roles.',
      ], bullets: [
        'Account data: name, email, login providers, memberships, preferences, sessions, and security events.',
        'Billing data: plan, price, renewal state, payment-provider customer/subscription references, acceptance evidence, refunds, and support history. The checkout payment provider handles subscription card details; krmax does not store full subscription payment-card numbers.',
        'Customer workspace data: repository files and metadata, prompts, tasks, messages, outputs, environment state, attachments, connected-service data, and audit events.',
      ] },
      { heading: 'How data is used', paragraphs: ['Data is used to provide and secure the service, execute customer instructions, authenticate users, administer subscriptions, respond to support and legal requests, prevent abuse, and maintain reliable operations. This draft does not authorize selling personal data or using private customer repository/workspace content to train general-purpose models.'] },
      { heading: 'Lawful bases and required information', paragraphs: [
        'Where the operator acts as controller under UK data protection law, account administration and providing a service you request rely on performance of a contract or steps you ask us to take before a contract. Tax, accounting and responses to binding legal requirements rely on compliance with legal obligations.',
        'Security, fraud prevention, service reliability and administration of business-customer contacts rely on legitimate interests in protecting the service and communicating with customers, balanced against individuals’ rights. Where an activity instead requires consent, we must ask separately before starting it; accepting these Terms or this Privacy Policy is not blanket consent to optional tracking or marketing.',
        'Authentication and necessary account or billing information are required to provide the corresponding service. If you do not provide them, we may be unable to create your account, supply a paid subscription or resolve a support request. Optional integrations and their credentials are not required unless you choose to use those integrations.',
      ] },
      { heading: 'Sources of information', paragraphs: [
        'We receive information from you, your organization’s administrators and invited members, and the identity, repository, model and other services that you authorize us to connect. Those services may supply profile identifiers, access permissions and the records requested by your tasks. Payment providers supply subscription and transaction status. Service operation also generates security and diagnostic records.',
      ] },
      { heading: 'Model keys and usage modes', paragraphs: [
        'With bring-your-own-key (BYOK), krmax stores the customer-supplied secret in its encrypted credential system and sends selected prompts, context, and files to the model provider the customer chose. Charges and provider data terms belong to that customer account.',
        'With a customer-connected OpenAI, Anthropic, or other subscription login, krmax operates the provider client under that customer connection. With managed usage, the operator supplies the provider account and the provider acts as an applicable subprocessor. The UI must identify the active rail; no mode prevents the chosen provider from receiving the content needed for the request.',
      ] },
      { heading: 'Sharing, transfers, and retention', paragraphs: [
        'Data is shared with subprocessors only for the service functions described on the Subprocessor list, with customer-selected integrations, when a customer directs, or when legally required. Providers may process data in the regions described by their own service terms and the applicable DPA.',
        'Retention, export, deletion, and backup behavior are described on Data controls. Contact the configured privacy address for access, correction, portability, objection, restriction, or other applicable privacy requests.',
      ] },
      { heading: 'Your rights and complaints', paragraphs: [
        'Contact the privacy address shown on this page to request access, correction, erasure, restriction or portability where applicable. You may object to processing based on legitimate interests. Where we rely on consent, you may withdraw it at any time without affecting the lawfulness of processing before withdrawal. We may need proportionate information to verify your identity and authority; some rights depend on the purpose and legal basis of processing.',
        'For personal data controlled by your organization, direct requests to that organization; we assist it under the applicable processing agreement. You can also contact us so we can identify the appropriate route.',
        'You may complain to the UK Information Commissioner’s Office at https://ico.org.uk/make-a-complaint/ or telephone 0303 123 1113. You do not have to complain to us first. You may also have the right to complain to the supervisory authority where you live or work.',
      ] },
    ],
  },
  billing: {
    slug: 'billing', title: 'Subscription, Refund & Cancellation Terms', summary: 'Price display, automatic renewal, refunds, downgrades, and online cancellation.',
    sections: [
      { heading: 'Before a charge', paragraphs: [
        'Organization settings show the central plan catalog, current active-user total, currency, monthly billing frequency, renewal rule, and cancellation path before checkout. The payment provider shows the final summary before charge. Where checkout is provided by Paddle, Paddle is the merchant of record and reseller for that purchase, handles applicable customer sales taxes, and issues payment receipts. Paddle buyer terms and privacy information are presented at checkout.',
        'A subscription renews automatically at the displayed interval until canceled. Applicable taxes may be added by the payment provider where required. Any future price change must be disclosed before it applies as required by law.',
      ] },
      { heading: 'Cancellation and renewal', paragraphs: [
        'An organization owner can cancel online at any time from Organization settings → Plan & billing, without requiring email or a support call. The billing portal is also available online. Cancellation normally takes effect at the end of the current paid period and prevents the next renewal.',
        'Deleting an account does not silently replace subscription cancellation. The account-deletion flow directs customers to cancel first and support must resolve any active billing relationship as part of deletion.',
      ] },
      { heading: 'Refunds and downgrades', paragraphs: [
        'Request refunds or report duplicate or erroneous charges through the configured billing contact or the payment provider. Paddle purchases are subject to Paddle’s buyer terms and refund decisions. Statutory consumer rights are not excluded. Approved Paddle refunds are processed through Paddle, not by a separate direct payment from krmax.',
        'Plan and active-user changes take effect after confirmation by the payment provider. Prorated adjustments are added to the next bill. A downgrade can reduce feature or usage limits when confirmed; cancellation at period end is a separate action.',
      ] },
    ],
  },
  subprocessors: {
    slug: 'subprocessors', title: 'Subprocessor List', summary: 'Providers that may handle account, billing, repository, or workspace data.',
    sections: [
      { heading: 'Core and conditional providers', paragraphs: ['The exact provider set depends on deployment and customer configuration. A provider receives only the categories needed for its role.'], bullets: [
        'Paddle — merchant-of-record checkout, customer sales taxes, receipts, subscriptions, refunds, and related billing identifiers when Paddle is selected. Paddle also acts as an independent controller for its own payment and legal obligations; it does not receive repository/workspace content for subscription billing.',
        'Stripe — legacy subscription billing where configured, and the separate agent-card integration when selected; receives the account and payment information required for those functions, not repository/workspace content for subscription billing.',
        'OpenAI and Anthropic — prompts, selected repository/workspace context, attachments, and outputs when their model or connected subscription is selected. BYOK uses the customer’s provider account; managed usage uses the operator’s account.',
        'E2B or Daytona — isolated compute, repository checkout, workspace files, environment variables made available to the world, command traffic, and resulting artifacts when that cloud world provider is selected.',
        'Configured database, object-storage, hosting, email, monitoring, and support providers — account records, service metadata, stored objects, transactional messages, diagnostics, or support content as needed for their function.',
        'Customer-selected repository hosts and integrations (for example GitHub) — data the customer directs krmax to read or write under the customer’s connection. These may be independent services as well as processors acting on the customer’s instructions.',
      ] },
      { heading: 'Changes and questions', paragraphs: ['Material additions should be versioned here and communicated to business customers as required by their DPA. Request the current provider/region details or object to a new subprocessor through the DPA contact.'] },
    ],
  },
  security: {
    slug: 'security', title: 'Security & Contact', summary: 'Security posture, responsible disclosure, and incident contact.',
    sections: [
      { heading: 'Operational safeguards', paragraphs: [
        'krmax uses scoped authorization, isolated execution worlds, encrypted credential storage, reviewed change flows, audit events, and provider-specific access boundaries. Customers remain responsible for repository permissions, connected accounts, agent grants, budgets, and reviewing proposed changes.',
        'No SOC 2, ISO 27001, HIPAA, PCI, GDPR, or other certification or compliance status is claimed unless a separately signed document explicitly says so. The subscription payment provider handles payment-card entry; that fact alone is not a krmax certification.',
      ] },
      { heading: 'Responsible disclosure', paragraphs: ['Send suspected vulnerabilities to the configured security contact with reproduction details, impact, and a safe way to reply. Do not access other customers’ data, degrade service, or publicly disclose an unresolved issue. The operator will acknowledge and coordinate in good faith; this draft does not invent a bounty or guaranteed response time.'] },
      { heading: 'Incidents', paragraphs: ['Customers should use the configured incident contact for suspected account compromise or exposure. The operator will investigate, contain, preserve relevant evidence, and notify affected customers as required by contract and applicable law.'] },
    ],
  },
  data: {
    slug: 'data', title: 'Data Controls', summary: 'Retention, export, account deletion, and incident-response paths.',
    sections: [
      { heading: 'Retention', paragraphs: [
        'Active account, project, task, audit, workspace, and billing records are retained while needed to provide and secure the service. Execution worlds may be short-lived or hibernated by their provider; adopted project resources and repository history follow their configured storage and Git retention.',
        'Retention decisions depend on whether an account or project is active, whether records are needed to complete an authorized task or resolve a dispute, statutory accounting requirements, security investigations and legal holds. Information must not be retained merely because storage is available. The operator must document the applicable periods and review retained exceptions.',
        'Account deletion is an operator-reviewed process, not an automatic purge triggered by subscription cancellation. Backup copies and data held by connected services require separate handling. There is no universal deletion deadline verified for this deployment in this draft; the operator must publish the production and backup deletion schedule before approving it for launch. An offboarding response must identify retained categories, their reason and applicable period rather than promise immediate deletion everywhere.',
      ] },
      { heading: 'Export', paragraphs: ['A signed-in user can download a personal JSON archive from Profile → Your data. Organization administrators can export organization records from Settings. Repository data remains exportable through its repository host; adopted resources should be downloaded before deletion. Contact support for a business offboarding export if the online exports are insufficient.'] },
      { heading: 'Account deletion', paragraphs: [
        'Request deletion from Profile → Data & account. The online request records the time and gives the configured privacy contact. Cancel an active subscription first. The operator must verify authority, address organizations or resources that need a new owner, and confirm the deletion scope before irreversible removal.',
        'Deletion removes or de-identifies the requesting account and customer-controlled data that no other customer must retain, subject to the limited retention reasons above. The response will identify anything that cannot yet be deleted and why.',
      ] },
      { heading: 'Security incidents and privacy requests', paragraphs: ['Use the configured incident address for urgent suspected compromise and the privacy address for data-subject requests. Do not place credentials, private keys, or unnecessary repository content in the initial message.'] },
    ],
  },
  dpa: {
    slug: 'dpa', title: 'Business DPA Requests', summary: 'A direct path for business customers to request and negotiate a Data Processing Addendum.',
    sections: [
      { heading: 'Request a DPA', paragraphs: ['Business customers can request the current Data Processing Addendum at the configured DPA contact before putting regulated or material personal data into the service. Include the legal customer name, country, expected data categories, relevant jurisdictions, desired signer, and any required security or subprocessor questionnaire.'] },
      { heading: 'What the DPA should settle', paragraphs: ['The final DPA should identify the contracting entities and roles, documented instructions, confidentiality, security measures, subprocessors and objection process, international-transfer mechanism, assistance with rights and incidents, audit information, return/deletion timing, and liability/order-of-precedence terms. None are silently represented as complete by this launch draft.'] },
    ],
  },
};

const withSiteName = (text: string, siteName: string) => text.replace(/krmax|Karmax/g, siteName);
const namedPolicy = (document: Omit<PolicyDocument, 'version' | 'effectiveDate'>, siteName: string) => ({
  ...document,
  summary: withSiteName(document.summary, siteName),
  sections: document.sections.map((section) => ({
    ...section,
    paragraphs: section.paragraphs.map((paragraph) => withSiteName(paragraph, siteName)),
    ...(section.bullets ? { bullets: section.bullets.map((bullet) => withSiteName(bullet, siteName)) } : {}),
  })),
});

export const POLICY_SLUGS = Object.keys(docs) as PolicySlug[];
export const ACCEPTANCE_POLICIES: Record<AcceptanceContext, PolicySlug[]> = {
  signup: ['terms', 'acceptable-use', 'privacy'],
  checkout: ['terms', 'privacy', 'billing'],
};

/** Exact product disclosures shown before an organization checkout and frozen
 * beside the billing service's authoritative commercial snapshot afterward. */
export const CHECKOUT_DISCLOSURES = Object.freeze({
  autoRenews: true,
  renewalDisclosure: 'The subscription renews monthly until canceled.',
  cancellationDisclosure: 'Cancel online from Organization settings before renewal; cancellation normally takes effect at the end of the current paid period.',
  refundDisclosure: 'Refunds are subject to applicable law and the payment provider’s buyer terms. Request a refund through billing support or the payment provider.',
});

export function policyVersions(context: AcceptanceContext): Record<string, string> {
  return Object.fromEntries(ACCEPTANCE_POLICIES[context].map((slug) => [slug, POLICY_VERSION]));
}

export function assertPolicyAcceptance(context: AcceptanceContext, accepted: unknown, versions: unknown): Record<string, string> {
  if (accepted !== true) throw new Error('affirmative policy acceptance is required');
  const expected = policyVersions(context);
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) throw new Error('policy versions are required');
  for (const [slug, version] of Object.entries(expected)) {
    if ((versions as Record<string, unknown>)[slug] !== version) throw new Error(`current ${slug} policy version ${version} must be accepted`);
  }
  return expected;
}

export interface LaunchConfig {
  paidLaunch: boolean;
  operatorName?: string;
  operatorCountry?: string;
  governingLaw?: string;
  legalNoticeAddress?: string;
  contacts: { legal?: string; privacy?: string; security?: string; incident?: string; dpa?: string; billing?: string };
  missing: string[];
  ready: boolean;
}

export interface StoredLaunchConfig {
  paidLaunch?: boolean;
  founderReviewedPolicyVersion?: string;
  operatorName?: string;
  operatorCountry?: string;
  governingLaw?: string;
  legalNoticeAddress?: string;
  contacts?: LaunchConfig['contacts'];
}

/** Resolve founder-entered installation settings before the legacy environment
 * bootstrap values. Environment variables remain an upgrade path, but the
 * normal hosted setup is persisted and editable in Installation settings. */
export function launchConfig(env: NodeJS.ProcessEnv = process.env, stored?: StoredLaunchConfig): LaunchConfig {
  const storedValues: Record<string, string | undefined> = {
    KARMAX_FOUNDER_REVIEWED_POLICY_VERSION: stored?.founderReviewedPolicyVersion,
    KARMAX_LEGAL_ENTITY_NAME: stored?.operatorName,
    KARMAX_LEGAL_ENTITY_COUNTRY: stored?.operatorCountry,
    KARMAX_GOVERNING_LAW: stored?.governingLaw,
    KARMAX_LEGAL_NOTICE_ADDRESS: stored?.legalNoticeAddress,
    KARMAX_LEGAL_EMAIL: stored?.contacts?.legal,
    KARMAX_PRIVACY_EMAIL: stored?.contacts?.privacy,
    KARMAX_SECURITY_EMAIL: stored?.contacts?.security,
    KARMAX_INCIDENT_EMAIL: stored?.contacts?.incident,
    KARMAX_DPA_EMAIL: stored?.contacts?.dpa,
    KARMAX_BILLING_EMAIL: stored?.contacts?.billing,
  };
  const value = (name: string) => storedValues[name]?.trim() || env[name]?.trim() || undefined;
  const email = (name: string) => {
    const candidate = value(name);
    return candidate && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) ? candidate : undefined;
  };
  const contacts = {
    legal: email('KARMAX_LEGAL_EMAIL'), privacy: email('KARMAX_PRIVACY_EMAIL'),
    security: email('KARMAX_SECURITY_EMAIL'), incident: email('KARMAX_INCIDENT_EMAIL'),
    dpa: email('KARMAX_DPA_EMAIL'), billing: email('KARMAX_BILLING_EMAIL'),
  };
  const required: Array<[string, unknown]> = [
    ['KARMAX_FOUNDER_REVIEWED_POLICY_VERSION', value('KARMAX_FOUNDER_REVIEWED_POLICY_VERSION') === POLICY_VERSION ? POLICY_VERSION : undefined],
    ['KARMAX_LEGAL_ENTITY_NAME', value('KARMAX_LEGAL_ENTITY_NAME')],
    ['KARMAX_LEGAL_ENTITY_COUNTRY', value('KARMAX_LEGAL_ENTITY_COUNTRY')],
    ['KARMAX_GOVERNING_LAW', value('KARMAX_GOVERNING_LAW')],
    ['KARMAX_LEGAL_NOTICE_ADDRESS', value('KARMAX_LEGAL_NOTICE_ADDRESS')],
    ['KARMAX_LEGAL_EMAIL', contacts.legal], ['KARMAX_PRIVACY_EMAIL', contacts.privacy],
    ['KARMAX_SECURITY_EMAIL', contacts.security], ['KARMAX_INCIDENT_EMAIL', contacts.incident],
    ['KARMAX_DPA_EMAIL', contacts.dpa], ['KARMAX_BILLING_EMAIL', contacts.billing],
  ];
  const missing = required.filter(([, configured]) => configured === undefined).map(([name]) => name);
  return {
    paidLaunch: stored?.paidLaunch ?? value('KARMAX_PAID_LAUNCH') === '1',
    operatorName: value('KARMAX_LEGAL_ENTITY_NAME'), operatorCountry: value('KARMAX_LEGAL_ENTITY_COUNTRY'),
    governingLaw: value('KARMAX_GOVERNING_LAW'), legalNoticeAddress: value('KARMAX_LEGAL_NOTICE_ADDRESS'), contacts,
    missing, ready: missing.length === 0,
  };
}

export function publicLaunchInfo(env: NodeJS.ProcessEnv = process.env, stored?: StoredLaunchConfig,
  siteName = 'krmax') {
  const config = launchConfig(env, stored);
  return {
    policyVersion: POLICY_VERSION, effectiveDate: POLICY_EFFECTIVE_DATE, draftNotice: POLICY_DRAFT_NOTICE,
    policies: POLICY_SLUGS.map((slug) => ({ slug, title: docs[slug].title,
      summary: withSiteName(docs[slug].summary, siteName), version: POLICY_VERSION })),
    acceptance: { signup: policyVersions('signup'), checkout: policyVersions('checkout') },
    pricingCatalog: Object.values(HOSTED_PLANS).map((plan) => ({ ...plan, currency: 'usd' as const,
      billingInterval: 'month' as const })),
    checkoutDisclosures: CHECKOUT_DISCLOSURES,
    // These are deliberately public operator fields, not private KYC details.
    // Publishing them must not depend on opening checkout or approving drafts.
    operator: config.operatorName && config.operatorCountry && config.legalNoticeAddress ? { name: config.operatorName, country: config.operatorCountry, governingLaw: config.governingLaw,
      legalNoticeAddress: config.legalNoticeAddress } : null,
    contacts: config.contacts,
    paidLaunch: config.paidLaunch, ready: config.ready,
  };
}

export function assertPaidLaunchReady(env: NodeJS.ProcessEnv = process.env, stored?: StoredLaunchConfig): LaunchConfig {
  const config = launchConfig(env, stored);
  if (!config.paidLaunch) throw new Error('paid checkout is not enabled');
  if (!config.ready) throw new Error(`paid checkout is unavailable until the launch checklist is complete: ${config.missing.join(', ')}`);
  return config;
}

export function policyDocument(slug: string, env: NodeJS.ProcessEnv = process.env, stored?: StoredLaunchConfig,
  siteName = 'krmax'): (PolicyDocument & { draftNotice: string; operator: ReturnType<typeof publicLaunchInfo>['operator']; contacts: LaunchConfig['contacts'] }) | undefined {
  if (!POLICY_SLUGS.includes(slug as PolicySlug)) return undefined;
  const info = publicLaunchInfo(env, stored, siteName);
  return { ...namedPolicy(docs[slug as PolicySlug], siteName), version: POLICY_VERSION, effectiveDate: POLICY_EFFECTIVE_DATE,
    draftNotice: POLICY_DRAFT_NOTICE, operator: info.operator, contacts: info.contacts };
}
