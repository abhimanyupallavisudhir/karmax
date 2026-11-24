// How a task page's cost grows with its conversation: open, re-render on an
// agent event, and refresh on view.updated, in Chromium against the fake console.
// Run: node benchmarks/task-page-render.cjs [messages=940] [subtasks=105]
const { conversationWindowApi, fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

const N = Number(process.argv[2] ?? 940), KIDS = Number(process.argv[3] ?? 105);
const para = (i) => `Checked \`src/world/e2b.ts\` and [the test](tests/x.test.ts): step ${i} **works**. `.repeat(6);
const agentText = (i) => `## Step ${i}\n\n${para(i)}\n\n- one item ${i}\n- another \`code\`\n\n\`\`\`ts\nconst x = ${i};\nconsole.log(x);\n\`\`\`\n\n${para(i)}\n${para(i)}`;
const userText = (i) => `Please also look at item ${i}. `.repeat(25);
const messages = Array.from({ length: N }, (_, i) => i % 7 < 3
  ? { id: `m${i}`, ts: 1_790_000_000_000 + i * 60_000, role: 'agent', text: agentText(i) }
  : i % 7 < 6 ? { id: `m${i}`, ts: 1_790_000_000_000 + i * 60_000, role: 'agent', text: agentText(i).slice(0, 900), sourceActivity: true }
  : { id: `m${i}`, ts: 1_790_000_000_000 + i * 60_000, role: 'user', text: userText(i), author: 'u', authorLabel: 'Tester' });
const kids = Array.from({ length: KIDS }, (_, i) => ({ id: `c${i}`, num: 200 + i, title: `Sub-task ${i}`, workflow: 'software-dev',
  lastView: { stage: 'done', status: 'done' } })); // as taskSummary trims it

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't1', projectId: 'p', num: 1, title: 'Long task', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'do', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'do', label: 'Working' }, { key: 'review', label: 'Review' }] }];
    const view = () => taskView(task, { messages, transcripts: [{ role: 'do', label: 'Do', messages }], subTaskSummaries: kids });
    const windowed = conversationWindowApi('t1', view);
    const body = JSON.stringify(view());
    const windowedBytes = JSON.stringify({ ...view(), messages: messages.slice(-100), transcripts: [{ role: 'do', label: 'Do', sameAsMessages: true }] }).length;
    const { sockets } = await fakeConsole(context, { project, tasks: [task], schema, api: (p, _request, url) => windowed(p, url) });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto('http://console.test/org/workspace/tasks');
    await page.waitForTimeout(500);
    const t0 = Date.now();
    await page.evaluate(() => { history.pushState({ kx: 1 }, '', '/org/workspace/tasks/1/checkin'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.locator('#ck-thread').waitFor({ timeout: 120000 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r))));
    const open = Date.now() - t0;
    const rows = await page.locator('#ck-thread [data-conversation-key]').count();
    const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
    // Main-thread time an event costs: long tasks between the send and quiet.
    await page.evaluate(() => { window.__busy = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__busy += e.duration; }).observe({ type: 'longtask' }); });
    const send = (event) => sockets.at(-1).send(JSON.stringify({ projectId: 'p', ts: Date.now(), ...event }));
    const cost = async (event) => {
      await page.evaluate(() => { window.__busy = 0; });
      const a = Date.now();
      send(event);
      await page.waitForTimeout(50);
      await page.evaluate(() => new Promise(r => { let last = window.__busy, still = 0; const tick = () => { if (window.__busy === last && ++still > 5) return r(); if (window.__busy !== last) { last = window.__busy; still = 0; } setTimeout(tick, 100); }; tick(); }));
      return { busy: await page.evaluate(() => window.__busy | 0), wall: Date.now() - a - 600 };
    };
    const renders = [], refresh = [];
    for (let i = 0; i < 3; i++) renders.push((await cost({ type: 'agent.activity', taskId: 't1', payload: { role: 'do', kind: 'tool', text: 'ran ls' } })).busy);
    for (let i = 0; i < 3; i++) refresh.push((await cost({ type: 'view.updated', taskId: 't1', payload: { stage: 'do', status: 'active' } })).busy);
    const { metrics } = await cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
    const heap = metrics.find(m => m.name === 'JSHeapUsedSize')?.value;
    const med = (xs) => xs.sort((a, b) => a - b)[1] | 0;
    console.log(JSON.stringify({ messages: N, subtasks: KIDS, viewBytes: body.length, windowedBytes, rows, domNodes: nodes, openMs: open, agentEventMs: med(renders), viewUpdatedMs: med(refresh), heapMB: heap ? (heap / 1048576).toFixed(0) : null }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
