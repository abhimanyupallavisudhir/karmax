// Screenshots of the conversation outline on two real tavya conversations:
// #689 (CI failed while the PR waited for Review; the agent went back and
// fixed it) and #687 (two merge-conflict rounds after the report).
//
// A scratch tavya seeded by design/task-page/seed.cjs hosts the page; this
// script answers task #1's view and event history with the real task's, shown
// as if it were waiting at Review (or, for LIVE, working on the CI repair).
// The real data is read through the platform API, never stored in the repo:
//   KARMAX_GATEWAY_URL=… KARMAX_TOKEN=… OUT=design/conversation-outline/after \
//     node design/conversation-outline/shoot.cjs
// Shoot `before` the same way with web/ checked out at the base commit.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || 'design/conversation-outline/after';
const SEED = JSON.parse(fs.readFileSync(process.env.SEED || '/tmp/shots/seed.json', 'utf8'));
// #704: follow-ups after the report, the agent's own sub-task and pauses.
const SOURCES = { ci: 'task_mvdbbw30733cf14c3b', conflicts: 'task_mvd1dtz20c826867de', followups: 'task_mvecea9z3ebf47582e' };

const remote = async (p) => {
  const response = await fetch(`${process.env.KARMAX_GATEWAY_URL}${p}`, { headers: { authorization: `Bearer ${process.env.KARMAX_TOKEN}` } });
  if (!response.ok) throw new Error(`${p}: ${response.status}`);
  return response.json();
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const real = {};
  for (const [name, id] of Object.entries(SOURCES)) {
    const events = await remote(`/api/tasks/${id}/events?since=0&limit=300`);
    real[name] = { view: await remote(`/api/tasks/${id}`), events: Array.isArray(events) ? events : events.events };
  }
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  // `shape(view, events)` returns what task #1 shows: a real task's
  // conversation and its activity, in the state the screenshot is about.
  const open = async (viewport, source, shape) => {
    const context = await browser.newContext({ storageState: STATE, viewport, colorScheme: 'light' });
    await context.route(`**/api/tasks/${SEED.taskId}`, async (route) => {
      const own = await (await route.fetch()).json();
      const { view } = shape(real[source].view, real[source].events);
      route.fulfill({ json: { ...own, ...view, taskId: SEED.taskId, num: view.num, subTasks: [], subTaskSummaries: [], reviewInfo: undefined, checkouts: own.checkouts, actions: own.actions } });
    });
    await context.route(new RegExp(`/api/tasks/${SEED.taskId}/events`), (route) => {
      const { events } = shape(real[source].view, real[source].events);
      route.fulfill({ json: events.map((e) => ({ ...e, taskId: SEED.taskId })) });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    await page.goto(`${APP}/personal/video-studio/tasks/${SEED.num}`);
    await page.locator('.task-page:not([aria-busy="true"])').waitFor();
    await page.waitForTimeout(2500);
    return page;
  };
  const idle = (view) => (view.participants || []).map((p) => ({ ...p, state: 'idle' }));
  const atReview = (view, events) => ({ view: { ...view, stage: 'review', status: 'waiting', waitingFor: undefined, agentTurn: undefined, participants: idle(view) }, events });
  // Working on the CI repair: the conversation up to the failed check, and
  // the activity the agent has done since.
  const fixingCi = (view, events) => {
    const at = view.messages.findIndex((m) => m.id.startsWith('review-ci-'));
    const until = view.messages[at + 1].ts - 60_000;
    return { view: { ...view, stage: 'do', status: 'active', waitingFor: undefined, messages: view.messages.slice(0, at + 1),
      agentTurn: { role: 'do', state: 'running', turnId: 'live' }, participants: idle(view).map((p) => p.key === 'do' ? { ...p, state: 'running' } : p) },
      events: events.filter((e) => Number(e.ts) <= until) };
  };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const desktop = { width: 1440, height: 900 };

  const toEnd = (page) => page.locator('#ck-thread').evaluate((thread) => { thread.scrollTop = thread.scrollHeight; });
  let page = await open(desktop, 'ci', atReview);
  await shot(page, '1-ci-repair-at-review');
  await toEnd(page);
  await shot(page, '1b-ci-repair-at-review-end');
  if (!process.env.BEFORE) {
    await page.locator('details.conv-fold.automatic > summary').last().click();
    await page.waitForTimeout(400);
    await page.locator('details.conv-fold.automatic').last().evaluate((fold) => fold.scrollIntoView({ block: 'start' }));
    await shot(page, '2-ci-repair-opened');
  }
  await page.context().close();

  page = await open(desktop, 'conflicts', atReview);
  await shot(page, '3-merge-conflicts-at-review');
  await toEnd(page);
  await shot(page, '3b-merge-conflicts-at-review-end');
  if (!process.env.BEFORE) {
    await page.locator('details.conv-fold:not(.automatic) > summary').first().click();
    await page.waitForTimeout(400);
    await page.locator('details.conv-fold').first().evaluate((fold) => fold.scrollIntoView({ block: 'start' }));
    await shot(page, '4-work-opened');
  }
  await page.context().close();

  page = await open(desktop, 'ci', fixingCi);
  await shot(page, '5-agent-working');
  await page.context().close();

  // #704 as it is: the latest follow-up answered. Opening it shows that answer.
  const asIs = (view, events) => ({ view: { ...view, participants: idle(view) }, events });
  page = await open(desktop, 'followups', asIs);
  await shot(page, '7-followup-answered');
  // Earlier rounds: each question, the work folded, then its answer.
  await page.locator('#ck-thread .msg.user', { hasText: 'No need to do daytona' }).evaluate((row) => row.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await shot(page, '8-followup-rounds');
  await page.context().close();

  page = await open({ width: 390, height: 844 }, 'ci', atReview);
  await shot(page, '6-mobile');
  await page.context().close();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
