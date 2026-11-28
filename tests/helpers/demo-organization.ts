import type { BrowserContext } from 'playwright';
import { consoleRequest, type HostedGateway } from './browser.js';

// A demo organization for store screenshots and other public pictures (wiki
// features/phone-apps § Screenshots, ops/launch-video § Never on camera):
// an invented company, Harbor Studio, with invented people, projects, tasks
// and files. Nothing here comes from a real organization, so nothing private
// can reach a picture; never seed it from production.

export const DEMO = {
  person: { name: 'Maya Lindqvist', email: 'maya@harbor.example' },
  password: 'correct horse battery staple 42',
  organization: 'Harbor Studio',
  slug: 'harbor-studio',
};

const MINUTE = 60_000;

type Seed = {
  title: string; stage: 'do' | 'review' | 'done'; status: 'active' | 'waiting' | 'done';
  waiting?: true; ago: number; reply?: string; review?: { caption: string; changedFiles: string[]; diff?: string; actions?: Array<{ kind: 'open' | 'run'; label: string; target?: string; command?: string }> };
};

/** What each project holds: tasks in every stage, the newest first in each list. */
const PROJECTS: Record<string, Seed[]> = {
  Website: [
    { title: 'Which analytics provider should we use?', stage: 'do', status: 'waiting', waiting: true, ago: 4,
      reply: 'I compared three for the shop:\n\n- **Plausible**: no cookies, so no consent banner; €19/month.\n- **PostHog**: funnels and session replay; free up to 1M events.\n- **Simple Analytics**: no cookies, EU-hosted; €15/month.\n\nWhich should I set up?' },
    { title: 'Add a size guide to every product page', stage: 'do', status: 'active', ago: 9 },
    { title: 'Fix the flaky checkout test', stage: 'review', status: 'waiting', waiting: true, ago: 22,
      reply: 'The test waited a fixed 2 s for the payment form. It now waits for the form’s ready event; 200 runs in a row passed.',
      review: { caption: 'The checkout test passes 200 times in a row',
        actions: [{ kind: 'open', label: 'Test report', target: 'reports/checkout-200-runs.html' }, { kind: 'run', label: 'Run the checkout test', command: 'npx playwright test tests/checkout.spec.ts' }],
        changedFiles: ['tests/checkout.spec.ts', 'src/checkout/payment-form.ts'],
        diff: [
          'diff --git a/tests/checkout.spec.ts b/tests/checkout.spec.ts',
          '--- a/tests/checkout.spec.ts',
          '+++ b/tests/checkout.spec.ts',
          '@@ -18,7 +18,7 @@ test(\'pays with a card\', async ({ page }) => {',
          '   await page.getByRole(\'button\', { name: \'Checkout\' }).click();',
          '-  await page.waitForTimeout(2000);',
          '+  await page.locator(\'#payment-form[data-ready]\').waitFor();',
          '   await page.getByLabel(\'Card number\').fill(\'4242 4242 4242 4242\');',
          'diff --git a/src/checkout/payment-form.ts b/src/checkout/payment-form.ts',
          '--- a/src/checkout/payment-form.ts',
          '+++ b/src/checkout/payment-form.ts',
          '@@ -41,6 +41,7 @@ export async function mountPaymentForm(root: HTMLElement) {',
          '   const form = await loadProvider(root);',
          '   form.on(\'change\', validate);',
          '+  root.dataset.ready = \'\';',
          ' }',
        ].join('\n') } },
    { title: 'Renew the TLS certificate', stage: 'done', status: 'done', ago: 300 },
  ],
  'Mobile app': [
    { title: 'Ship dark mode on Android', stage: 'do', status: 'active', ago: 14 },
    { title: 'Reply to the App Store review feedback', stage: 'review', status: 'waiting', waiting: true, ago: 41,
      reply: 'Drafted a reply to the reviewer and attached a screen recording of account deletion.',
      review: { caption: 'Read the draft reply before it is sent', changedFiles: ['store/review-reply.md'] } },
    { title: 'Translate the onboarding screens into Spanish', stage: 'done', status: 'done', ago: 900 },
  ],
  Research: [
    { title: 'Summarize this week’s customer interviews', stage: 'review', status: 'waiting', waiting: true, ago: 63,
      reply: 'Five interviews summarized in interviews/summary.md: the top request is shared carts (4 of 5).',
      review: { caption: 'Five interviews, one page', changedFiles: ['interviews/summary.md'], actions: [{ kind: 'open', label: 'Summary', target: 'interviews/summary.md' }] } },
    { title: 'Compare three email providers', stage: 'done', status: 'done', ago: 1440 },
  ],
  Operations: [
    { title: 'Book the team offsite in Lisbon, under €4,000', stage: 'do', status: 'waiting', waiting: true, ago: 31,
      reply: 'Found a venue for 12 people on 14–16 May at €3,640 all in. Shall I book it with the company card?' },
    { title: 'Renew the domain names before they expire', stage: 'done', status: 'done', ago: 2880 },
  ],
};

/** A transcript of `lines` invented exchanges, about `kb` kilobytes. */
function transcript(name: string, topic: string, kb: number) {
  const lines = [`# ${name}\n`, `Interview about ${topic}. Recorded with consent; names changed.\n`];
  const turns = [
    'Q: Walk me through your last order.', `A: I opened the shop on my phone and went straight to ${topic}.`,
    'Q: What slowed you down?', 'A: Finding my size again, and not knowing when it would arrive.',
    'Q: What would you change first?', `A: Honestly, ${topic}. Everything else was fine.`,
  ];
  for (let index = 0; lines.join('\n').length < kb * 1024; index++) lines.push(turns[index % turns.length]!);
  return `${lines.join('\n')}\n`;
}
/** A stand-in for a binary document of `kb` kilobytes. */
const document = (kb: number) => `%PDF-1.7\n${'0'.repeat(kb * 1024 - 10)}\n`;

/** Files of the Research project's repository, for Files and Available offline. */
export const DEMO_FILES: Record<string, string> = {
  'README.md': '# Research\n\nInterviews, pricing and market notes for Harbor Studio.\n',
  'interviews/summary.md': '# Customer interviews, week 47\n\nFive interviews. Top requests:\n\n1. Shared carts (4 of 5)\n2. Saved sizes (3 of 5)\n3. Faster delivery estimates (2 of 5)\n',
  'interviews/2026-11-17 Ana.md': transcript('Ana, boutique owner', 'sharing a cart', 38),
  'interviews/2026-11-18 Tomás.md': transcript('Tomás, returning customer', 'saved sizes', 44),
  'interviews/2026-11-19 Léa.md': transcript('Léa, first order', 'the size guide', 29),
  'interviews/2026-11-20 Sam.md': transcript('Sam, gift buyer', 'sending a cart to a friend', 33),
  'interviews/2026-11-21 Inês.md': transcript('Inês, wholesale', 'invoices with VAT numbers', 41),
  'brand/Harbor Studio brand book.pdf': document(2_410),
  'brand/logo.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${'<path d="M0 0h64v64H0z"/>'.repeat(240)}</svg>\n`,
  'contracts/Lisbon venue quote.pdf': document(186),
  'pricing/competitors.csv': `shop,shipping,returns\n${'Northside,4.90,30 days\nKestrel,free over 50,14 days\n'.repeat(120)}`,
  'pricing/notes.md': '# Pricing notes\n\nFree shipping over €60 matches the two closest competitors.\n',
};

export interface DemoOrganization {
  organizationId: string;
  userId: string;
  projects: Record<string, { id: string; slug: string }>;
  /** Task numbers by title. */
  tasks: Record<string, number>;
}

/** Seeds Harbor Studio on a hosted test gateway, signed in as its owner in `context`. */
export async function seedDemoOrganization(g: HostedGateway, context: BrowserContext): Promise<DemoOrganization> {
  const { user, organization } = await g.owner({ ...DEMO.person, password: DEMO.password, organization: DEMO.organization });
  const { signIn } = await import('./browser.js');
  await signIn(context, g.url, DEMO.person.email, DEMO.password);
  const projects: DemoOrganization['projects'] = {};
  const tasks: Record<string, number> = {};
  const now = Date.now();
  for (const [name, seeds] of Object.entries(PROJECTS)) {
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name });
    projects[name] = { id: project.id, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') };
    // Oldest first, so task numbers rise with time.
    for (const seed of [...seeds].sort((a, b) => b.ago - a.ago)) {
      const task = await g.store.createTask({ projectId: project.id, title: seed.title, workflow: 'software-dev', workflowVersion: '1.30.0',
        params: { prompt: seed.title }, createdBy: { kind: 'user', userId: user.id } });
      tasks[seed.title] = task.num!;
      const at = now - seed.ago * MINUTE;
      const actions = seed.stage === 'review'
        ? [{ name: 'confirm', kind: 'signal', label: 'Confirm', enabled: true },
          { name: 'followUp', kind: 'signal', label: 'Request changes', enabled: true, args: [{ name: 'text', type: 'text', label: 'Message', required: true }] }]
        : seed.stage === 'done' ? [] : [{ name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true, args: [{ name: 'text', type: 'text', label: 'Message', required: true }] }];
      await g.store.saveView(task.id, {
        taskId: task.id, title: seed.title, workflow: 'software-dev', stage: seed.stage, status: seed.status,
        ...(seed.waiting ? { waitingFor: { kind: 'human', audience: ['@creator'] } } : {}),
        ...(seed.review ? { reviewInfo: { ...seed.review, completion: 'signalled' }, branch: `tavya/${task.id}`, targetBranch: 'main' } : {}),
        actions, state: {}, updatedAt: at,
        messages: [{ id: 'm0', role: 'user', text: seed.title, ts: at - 20 * MINUTE },
          ...(seed.reply ? [{ id: 'a1', role: 'agent', text: seed.reply, ts: at }] : [])],
        participants: [{ key: 'do', label: 'Agent', role: 'do', state: seed.status === 'active' ? 'running' : 'idle', messages: seed.reply ? 1 : 0 }],
      } as any);
      // When it last moved and asked, as its list row says ("4m", "1h"), not the moment it was seeded.
      const db = (g.store as any).db;
      await db.prepare('UPDATE tasks SET createdAt=?, statusChangedAt=? WHERE id=?').run(at - 20 * MINUTE, at, task.id);
      await db.prepare('UPDATE inbox SET createdAt=? WHERE taskId=?').run(at, task.id);
    }
  }
  return { organizationId: organization.id, userId: user.id, projects, tasks };
}
