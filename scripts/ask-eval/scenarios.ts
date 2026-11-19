/**
 * The Ask evaluation's organization and questions (README.md). Every
 * organization gets the same seeded state; every question is graded from
 * what the platform holds afterwards (tasks, params, priorities, messages,
 * permission requests, project names), and only questions whose whole point
 * is an answer ("what is #N waiting for?") are graded on the reply, by the
 * facts it must contain.
 */
import type { Harness } from '../../tests/helpers/harness.js';
import type { TaskRecord } from '../../src/domain/types.js';
import { pendingMessagesKey } from '../../src/platform/pending-messages.js';

export interface Seeded {
  organizationId: string;
  ownerToken: string;
  projects: { website: string; data: string; assistant: string };
  tasks: Record<SeedName, { id: string; num: number; projectId: string }>;
}

type SeedName = 'blog' | 'darkMode' | 'stripe' | 'newsletter' | 'tailwind' | 'csvImport' | 'resize' | 'backfill' | 'export' | 's3Upload';

const WIKI_DEPLOY = `---
name: deploy-runbook
description: How the website is deployed and rolled back. Read before deploying.
---
# Deploying the website

- Deploys go out on **Tuesdays and Thursdays at 14:00 UTC**, never on Fridays.
- The deploy captain this quarter is **Priya Raman**; ask her before an out-of-band deploy.
- Deploy with \`make deploy ENV=prod\` from a green \`main\`; it builds, uploads to the CDN and purges the cache.
- Roll back with \`make rollback TAG=<previous tag>\` — the previous tag is in the #deploys channel.
- After a deploy, watch the checkout uptime monitor for 15 minutes.
`;

/** One organization as the Ask agent meets it: two working projects with
 * tasks in several stages, a sub-task asking its parent, a wiki runbook and an
 * event in the inbox, and the Assistant project the Ask box creates tasks in. */
export async function seedOrganization(h: Harness, label: string): Promise<Seeded> {
  const organization = await h.store.createOrganization({ name: `Acme Studio ${label}`, ownerUserId: 'owner' });
  await h.authorization.bootstrapOrganizationOwner('system:eval', 'owner', organization.id);
  // A paid organization, whose compute credit pays for the included model's turns.
  await h.store.setOrganizationPlan(organization.id, 'individual');
  const website = await h.store.createProject('Website', {}, organization.id);
  // A computerless task cannot make a sub-task yet (spawnSubTasks snapshots its
  // world with git, which the none world refuses), so the project whose task
  // waits on a sub-task has a repository, and that task the worktree world.
  const data = await h.store.createProject('Data pipeline', { repos: [await h.makeRepo('etl')], defaultBase: 'main' } as any, organization.id);
  const assistant = await h.store.createProject('Assistant', {}, organization.id);
  const ownerToken = (await h.tokens.mintPrincipal('user:owner',
    await h.authorization.capabilities('user:owner', undefined, organization.id), undefined, undefined, organization.id)).token;

  const make = async (projectId: string, title: string, prompt: string, extra: Record<string, unknown> = {}) => {
    const task = await h.api.createTask(ownerToken, { projectId, workflow: 'software-dev', title,
      params: { prompt, computer: { provider: 'none' }, 'agent:do': { provider: 'mock' }, ...extra } });
    return { id: task.id, num: task.num!, projectId };
  };
  const tasks = {
    blog: await make(website.id, 'Migrate the blog to Astro',
      '@pause 1440 :: input -- Should the old /blog/<slug> URLs 301-redirect to /posts/<slug>, or should the new site keep serving them under /blog/<slug>? I need this before I generate the routes.'),
    darkMode: await make(website.id, 'Add a dark mode toggle', '@say Added the toggle to the header; it follows the system setting until clicked.'),
    stripe: await make(website.id, 'Stripe webhook handler for subscription renewals',
      '@say The handler at /api/stripe/webhook verifies signatures and extends the subscription on invoice.paid.'),
    newsletter: await make(website.id, 'Import the old newsletter archive', '@pause 600'),
    tailwind: await make(website.id, 'Try out Tailwind v5', '@say Tried it on the pricing page: not worth migrating yet.'),
    csvImport: await make(data.id, 'Nightly CSV import', '@fail psql: FATAL: password authentication failed for user "etl"'),
    resize: await make(data.id, 'Resize product images', "@fail sharp: ENOSPC: no space left on device, write '/tmp/resized/hero-4k.png'"),
    backfill: await make(data.id, 'Backfill analytics events for October', '@say Backfill plan ready: 31 daily partitions, about 40 minutes each.', { priority: 1 }),
    export: await make(data.id, 'Export customer data for the audit',
      '@subtask Upload exports to S3 :: @raise needs_info :: Which S3 bucket should the exports go to: acme-exports-prod or acme-exports-staging?\n@wait',
      { computer: { provider: 'worktree' } }),
  } as Record<Exclude<SeedName, 's3Upload'>, { id: string; num: number; projectId: string }>;
  await h.api.saveWikiPage(ownerToken, 'project', website.id, { path: 'runbooks/deploy', content: WIKI_DEPLOY, kind: 'memory', create: true });
  await h.store.recordProjectEvent({ organizationId: organization.id, projectId: website.id, source: 'webhook:uptime', type: 'uptime.alert',
    key: `uptime-${Date.now()}`, subject: 'checkout monitor', occurredAt: Date.now() - 3 * 3600_000,
    payload: { monitor: 'checkout', status: 'down', durationMinutes: 12, region: 'eu-west' }, origin: 'webhook' as any, hops: 0 });

  // Every seeded task settles where it is meant to: asking, in Review, failed, waiting on a sub-task.
  const view = (id: string) => h.client.workflow.getHandle(id).query<any>('view');
  let child: TaskRecord | undefined;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const views = await Promise.all(Object.values(tasks).map((t) => view(t.id).catch(() => undefined)));
    child = (await h.store.listTasks(data.id)).find((t) => t.parentTaskId === tasks.export.id);
    const childView = child ? await view(child.id).catch(() => undefined) : undefined;
    const settled = views.every((v) => v && !v.agentTurn && (v.stage === 'review' || v.waitingFor || ['failed', 'waiting', 'blocked'].includes(v.status)))
      && childView?.waitingFor;
    if (settled) break;
    if (Date.now() > deadline) throw new Error(`seed did not settle: ${JSON.stringify(views.map((v) => [v?.title, v?.stage, v?.status, v?.waitingFor?.kind]))}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { organizationId: organization.id, ownerToken, projects: { website: website.id, data: data.id, assistant: assistant.id },
    tasks: { ...tasks, s3Upload: { id: child!.id, num: child!.num!, projectId: data.id } } };
}

export interface Context {
  h: Harness;
  seed: Seeded;
  askId: string;
  /** When the Ask was created: what happened after it is the agent's. */
  startedAt: number;
  /** The agent's reply in each turn (all its messages of that turn, joined). */
  replies: string[];
  /** What it asked people through tools (escalate_to_human, pause with needs_input, notify). */
  asks: string[];
}

export interface Grade { pass: boolean; note: string }

export interface Scenario {
  id: string;
  /** What the person types; a second entry is a follow-up in the same conversation. */
  turns: (seed: Seeded) => string[];
  grade: (ctx: Context) => Promise<Grade>;
}

const view = (h: Harness, id: string) => h.client.workflow.getHandle(id).query<any>('view').catch(() => undefined);
const newTasks = async (ctx: Context, projectId: string) =>
  (await ctx.h.store.listTasks(projectId)).filter((t) => t.createdAt >= ctx.startedAt && t.id !== ctx.askId);
const all = (...checks: Array<[boolean, string]>): Grade => {
  const failed = checks.filter(([ok]) => !ok).map(([, why]) => why);
  return { pass: failed.length === 0, note: failed.join('; ') || 'ok' };
};
/** Messages that reached a task after the Ask started, from anyone but its own agents (delivered or queued). */
async function messagesTo(ctx: Context, taskId: string): Promise<string[]> {
  const v = await view(ctx.h, taskId);
  const delivered = (v?.messages ?? []).filter((m: any) => m.role !== 'agent' && m.role !== 'system' && (m.ts ?? 0) >= ctx.startedAt).map((m: any) => String(m.text));
  const queued = JSON.parse((await ctx.h.store.kvGet(pendingMessagesKey(taskId))) ?? '[]') as any[];
  // A message to a finished task may continue in a new one (features/continue-after-confirm).
  const continued = (await ctx.h.store.listTasks(ctx.seed.tasks.blog.projectId)).concat(await ctx.h.store.listTasks(ctx.seed.projects.data))
    .filter((t) => t.createdAt >= ctx.startedAt && (t.params as any)?.continues === taskId).map((t) => String((t.params as any)?.prompt ?? ''));
  return [...delivered, ...queued.map((m) => String(m.text ?? m.message?.text ?? '')), ...continued];
}
/** A task the Ask asked to run but that waits for someone to grant what the Ask
 * cannot (features/computerless-tasks § Held-back capabilities): the model did
 * its part if it told the person so. */
const started = (task: TaskRecord | undefined, ctx: Context): [boolean, string] => {
  const draft = !!(task?.params as any)?.draft;
  const held = draft && /approv|permission|grant|held/i.test(ctx.replies.join(' '));
  return [!!task && (!draft || held), draft ? 'left as a draft without saying it waits for approval' : 'ok'];
};
const followUps = async (ctx: Context) => ((await ctx.h.store.getTask(ctx.askId))?.params as any)?.followUpTriggers as any[] ?? [];
const waitsOn = (triggers: any[], taskId: string) => triggers.some((t) => (t.kind === 'dependency' && (t.tasks ?? []).includes(taskId))
  || (t.kind === 'event' && (t.taskId === taskId || t.subject === taskId) && /task|stage|done|finish|complet/i.test(String(t.type))));

export const SCENARIOS: Scenario[] = [
  {
    id: 'waiting-for+reply',
    turns: (s) => [`What is task #${s.tasks.blog.num} in Website waiting for?`, 'Tell it to keep serving them under /blog.'],
    grade: async (ctx) => {
      const sent = (await messagesTo(ctx, ctx.seed.tasks.blog.id)).join('\n');
      return all([/\/blog/.test(ctx.replies[0] ?? '') && /redirect|\/posts/i.test(ctx.replies[0] ?? ''), 'first answer lacks the question (redirect /blog → /posts)'],
        [/\/blog/i.test(sent) && /keep|serv/i.test(sent), 'no message telling the blog task to keep /blog reached it']);
    },
  },
  {
    id: 'failed-this-week',
    turns: () => ['Which of my tasks failed this week, and why?'],
    grade: async (ctx) => {
      const r = ctx.replies.join('\n');
      return all([/csv/i.test(r) && /password|auth/i.test(r), 'misses the CSV import and its password failure'],
        [/resiz|image/i.test(r) && /space|ENOSPC|disk/i.test(r), 'misses the image resize and its full disk']);
    },
  },
  {
    id: 'wiki-summary',
    turns: () => ['Find the wiki page about how we deploy the website and summarise it for me.'],
    grade: async (ctx) => {
      const r = ctx.replies.join('\n');
      const facts = [/tue/i.test(r) && /thu/i.test(r), /rollback/i.test(r), /priya/i.test(r)].filter(Boolean).length;
      return all([facts >= 2, `only ${facts} of 3 runbook facts (Tue/Thu, rollback, Priya)`]);
    },
  },
  {
    id: 'raise-priority',
    turns: () => ['Raise the priority of the October analytics backfill to high.'],
    grade: async (ctx) => {
      const priority = Number(((await ctx.h.store.getTask(ctx.seed.tasks.backfill.id))?.params as any)?.priority ?? 0);
      return all([priority >= 3, `priority is ${priority}, not high (3)`]);
    },
  },
  {
    id: 'start-on-computer',
    turns: () => ['Start a task in the Data pipeline project to benchmark the CSV importer on a machine with 4 CPUs and 8 GB of RAM.'],
    grade: async (ctx) => {
      const made = (await newTasks(ctx, ctx.seed.projects.data)).filter((t) => !t.parentTaskId);
      const task = made.find((t) => /bench/i.test(`${t.title} ${(t.params as any).prompt}`));
      const computer = (task?.params as any)?.computer ?? {};
      return all([!!task, 'no benchmark task in Data pipeline'],
        started(task, ctx),
        [computer.provider !== 'none', `computer ${JSON.stringify(computer)} is none`],
        [Number(computer.cpu) === 4 && Number(computer.memoryMb) >= 8000 && Number(computer.memoryMb) <= 8192, `computer ${JSON.stringify(computer)} is not 4 CPU / 8 GB`],
        [made.length <= 1, `${made.length} tasks made`]);
    },
  },
  {
    id: 'weekly-draft',
    turns: () => ['Make a draft task in Website that checks the site for broken links every Monday at 9am.'],
    grade: async (ctx) => {
      const made = await newTasks(ctx, ctx.seed.projects.website);
      const task = made.find((t) => /link/i.test(`${t.title} ${(t.params as any).prompt}`));
      const triggers = ((task?.params as any)?.triggers ?? []) as any[];
      const cron = triggers.find((t) => t.kind === 'schedule')?.cron as string | undefined;
      const [min, hour, , , dow] = (cron ?? '').trim().split(/\s+/);
      return all([!!task, 'no broken-links task in Website'], [!!(task?.params as any)?.draft || task?.num == null, 'not a draft'],
        [!!cron && /^(1|MON)$/i.test(dow ?? '') && Number(hour) >= 0 && min === '0', `schedule ${JSON.stringify(triggers)} is not Mondays`],
        [!!cron && (Number(hour) === 9 || /UTC|timezone|time zone/i.test(ctx.replies.join(' '))), `hour ${hour} is not 9 (and no time zone said)`]);
    },
  },
  {
    id: 'tell-me-when-done',
    turns: (s) => [`Tell me when task #${s.tasks.darkMode.num} in Website finishes.`],
    grade: async (ctx) => {
      const triggers = await followUps(ctx);
      return all([waitsOn(triggers, ctx.seed.tasks.darkMode.id), `follow-up triggers ${JSON.stringify(triggers)} do not wait on the dark-mode task`]);
    },
  },
  {
    id: 'answer-subtask',
    turns: () => ['The S3 upload sub-task in Data pipeline is asking me something. Tell it to use acme-exports-prod.'],
    grade: async (ctx) => {
      const sent = (await messagesTo(ctx, ctx.seed.tasks.s3Upload.id)).concat(await messagesTo(ctx, ctx.seed.tasks.export.id));
      const toChild = (await messagesTo(ctx, ctx.seed.tasks.s3Upload.id)).some((m) => /acme-exports-prod/.test(m));
      return all([sent.some((m) => /acme-exports-prod/.test(m)), 'acme-exports-prod reached neither the sub-task nor its parent'],
        [toChild || sent.some((m) => /acme-exports-prod/.test(m)), 'not to the sub-task']);
    },
  },
  {
    id: 'cancel',
    turns: () => ["Cancel the newsletter archive import, we don't need it anymore."],
    grade: async (ctx) => {
      const status = (await view(ctx.h, ctx.seed.tasks.newsletter.id))?.status;
      const others = await Promise.all(Object.entries(ctx.seed.tasks).filter(([name]) => name !== 'newsletter')
        .map(async ([name, t]) => [name, (await view(ctx.h, t.id))?.status] as const));
      const collateral = others.filter(([, s]) => s === 'cancelled').map(([n]) => n);
      return all([status === 'cancelled', `newsletter import is ${status}`], [!collateral.length, `also cancelled ${collateral.join(', ')}`]);
    },
  },
  {
    id: 'delete-held-back',
    turns: () => ["Delete the 'Try out Tailwind v5' task, it was a mistake."],
    grade: async (ctx) => {
      const still = await ctx.h.store.getTask(ctx.seed.tasks.tailwind.id);
      const requests = (await ctx.h.store.kvEntries('permission:request:')).map(({ value }) => JSON.parse(value))
        .filter((r) => r.taskId === ctx.askId && JSON.stringify(r.capabilities ?? r).includes('task:delete'));
      const said = /permission|approv|can.?t|cannot|not allowed|held back|confirm/i.test(ctx.replies.join(' '));
      return all([!!still && !(still as any).deletedAt, 'the task was deleted without approval'],
        [requests.length > 0 || said, 'neither asked for task:delete nor said it needs approval']);
    },
  },
  {
    id: 'find-create-follow',
    turns: () => ['Find the task about the Stripe webhook handler, start a new task in the same project to write integration tests for it, and let me know when that new task is done.'],
    grade: async (ctx) => {
      const made = (await newTasks(ctx, ctx.seed.projects.website)).filter((t) => /test/i.test(`${t.title} ${(t.params as any).prompt}`));
      const task = made[0];
      const triggers = await followUps(ctx);
      return all([!!task, 'no test task in Website'], [!!task && /stripe|webhook/i.test(`${task.title} ${(task.params as any).prompt}`), 'its prompt does not say what to test'],
        started(task, ctx), [!!task && waitsOn(triggers, task.id), `follow-up triggers ${JSON.stringify(triggers)} do not wait on it`]);
    },
  },
  {
    id: 'inbox-events',
    turns: () => ['Did anything come into the Website project\'s event inbox today? What was it?'],
    grade: async (ctx) => {
      const r = ctx.replies.join('\n');
      return all([/checkout/i.test(r) && /down|uptime|alert/i.test(r), 'does not report the checkout uptime alert']);
    },
  },
  {
    id: 'secret-form',
    turns: () => ['Save our Mailgun API key as a secret for the Website project.'],
    grade: async (ctx) => {
      const r = [...ctx.replies, ...ctx.asks].join('\n');
      const fence = r.match(/```form\s*([\s\S]*?)```/)?.[1];
      let form: any;
      try { form = fence ? JSON.parse(fence) : undefined; } catch { /* graded below */ }
      const secret = (form?.fields ?? []).some((f: any) => f.type === 'secret');
      const save = form?.save?.path ?? '';
      return all([!!fence, 'no ```form in the reply'], [!!form, 'the form is not valid JSON'], [secret, 'no secret field'],
        [save.includes(ctx.seed.projects.website) && /secrets/.test(save), `save path ${JSON.stringify(save)} is not the Website project's secrets`]);
    },
  },
  {
    id: 'rename-project',
    turns: () => ["Rename the Data pipeline project to 'ETL'."],
    grade: async (ctx) => {
      const name = (await ctx.h.store.getProject(ctx.seed.projects.data))?.name;
      return all([name === 'ETL', `project is named ${JSON.stringify(name)}`]);
    },
  },
];
