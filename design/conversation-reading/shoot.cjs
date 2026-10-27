// Screenshots of the conversation's reading typography: a question and a long,
// richly formatted answer (headings, lists, code, a table, math, a quote), in
// light and dark, desktop and phone.
//
// A scratch tavya seeded by design/task-page/seed.cjs hosts the page; this
// script answers task #1's view with the conversation below.
//   OUT=design/conversation-reading/after node design/conversation-reading/shoot.cjs
// Shoot `before` the same way with web/ checked out at the base commit.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || 'design/conversation-reading/after';
const SEED = JSON.parse(fs.readFileSync(process.env.SEED || '/tmp/shots/seed.json', 'utf8'));

const question = 'In relation to the price-recursion post — what is the core claim, and how does it connect reward assignment to Bayesian updating? Keep it short but precise.';
const answer = `The post builds a bridge between **multi-agent reinforcement learning**, **asset pricing** and **Bayesian belief aggregation**.

Its thesis: *rewards in a multi-agent system are to action what probabilities are to belief*. Just as Bayes' rule is the unique coherent way to update probabilities, a set of coherence conditions forces a unique, unhackable way to assign rewards across sub-agents — the **price recursion**, i.e. the backward pass of Bellman / reverse-mode autodiff.

## Why price recursion

The argument mirrors de Finetti's Dutch book:

1. A betting price that admits a sure loss is incoherent.
2. A reward scheme that admits a *reward hack* — a coalition gaining while welfare drops — is incoherent in the same sense.
3. Only rewards of the form $r_i = \\partial W / \\partial a_i$ plus a baseline avoid both.

### What it changes in practice

- Credit assignment becomes a pricing problem, so \`advantage\` estimates are marginal prices.
- Baselines are free: any term independent of $a_i$ leaves incentives unchanged.
- Hacks show up as arbitrage, which is cheap to test for.

| Belief domain | Reward domain |
| --- | --- |
| Betting prices | Marginal rewards paid to sub-agents |
| Dutch book (sure loss) | Reward hack (coalition gains, welfare drops) |
| de Finetti's theorem | Rewards must be $\\kappa \\nabla W$ + baselines |

\`\`\`python
def price(node, upstream=1.0):
    # reverse-mode: each input is paid its marginal contribution
    for child, weight in node.inputs:
        price(child, upstream * weight)
    node.reward += upstream
\`\`\`

> The surprising part is not that backprop assigns credit — it is that nothing else can without being exploitable.

See [the original post](https://www.lesswrong.com/) for the proofs.`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const open = async (viewport, colorScheme) => {
    const context = await browser.newContext({ storageState: STATE, viewport, colorScheme });
    await context.route(`**/api/tasks/${SEED.taskId}`, async (route) => {
      const own = await (await route.fetch()).json();
      const ts = Date.parse('2026-10-27T09:00:00Z');
      const messages = [
        { id: 'm0', role: 'user', text: question, ts },
        { id: 'a1', role: 'agent', text: answer, ts: ts + 60_000 },
        { id: 'm2', role: 'user', text: 'Thanks — and the table again in one line?', ts: ts + 120_000 },
        { id: 'a3', role: 'agent', text: 'Betting prices ↔ marginal rewards; Dutch book ↔ reward hack; de Finetti ↔ $\\kappa \\nabla W$ + baselines.', ts: ts + 180_000 },
      ];
      route.fulfill({ json: { ...own, messages, stage: 'review', status: 'waiting', waitingFor: undefined, agentTurn: undefined,
        participants: (own.participants || []).map((p) => ({ ...p, state: 'idle' })), reviewInfo: undefined, subTasks: [], subTaskSummaries: [] } });
    });
    await context.route(new RegExp(`/api/tasks/${SEED.taskId}/events`), (route) => route.fulfill({ json: [] }));
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    await page.goto(`${APP}/personal/video-studio/tasks/${SEED.num}`);
    await page.locator('.task-page:not([aria-busy="true"])').waitFor();
    await page.waitForTimeout(2500);
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const top = (page) => page.locator('#ck-thread').evaluate((thread) => { thread.scrollTop = 0; });
  for (const scheme of ['light', 'dark']) {
    let page = await open({ width: 1440, height: 900 }, scheme);
    await top(page);
    await page.waitForTimeout(300);
    await shot(page, `desktop-${scheme}`);
    await page.locator('#ck-thread').evaluate((thread) => { thread.scrollTop = thread.scrollHeight; });
    await page.waitForTimeout(300);
    await shot(page, `desktop-${scheme}-end`);
    await page.context().close();
    page = await open({ width: 390, height: 844 }, scheme);
    await top(page);
    await page.waitForTimeout(300);
    await shot(page, `mobile-${scheme}`);
    await page.context().close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
