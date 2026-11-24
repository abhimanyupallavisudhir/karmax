// A long task's page, end to end on the real gateway: it reads the newest 100
// messages, says how many earlier ones there are, and reads them when asked
// (wiki ops/performance-history, pramana#137).
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import type { Message, TaskView } from '../src/domain/types.js';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';
const shots = process.env.KARMAX_SCREENSHOT_DIR;

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('reads the newest messages of a long conversation, and earlier ones when asked', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.66', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const task = await g.store.createTask({ projectId: project.id, title: 'A month of work', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'Question 0' } });
    await g.store.numberTask(task.id);
    const T0 = Date.now() - 30 * 86_400_000;
    const messages = Array.from({ length: 250 }, (_, i): Message => (i % 2
      ? { id: `a${i}`, role: 'agent', text: `Answer ${i}: **done** with step ${i}.`, ts: T0 + i * 60_000 }
      : { id: `m${i}`, role: 'user', text: `Question ${i}: please do step ${i + 1}.`, ts: T0 + i * 60_000 }) as Message);
    await g.store.saveView(task.id, { taskId: task.id, title: 'A month of work', workflow: 'software-dev', stage: 'do', status: 'waiting',
      waitingFor: { kind: 'human' }, messages, transcripts: [{ role: 'do', label: 'Do agent', messages }],
      actions: [{ name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true }], state: {}, updatedAt: 1 } as TaskView);
    const num = (await g.store.getTask(task.id))!.num;
    const reads: string[] = [];
    page.on('request', (request) => { const url = new URL(request.url()); if (url.pathname.startsWith(`/api/tasks/${task.id}`)) reads.push(url.pathname + url.search); });
    const rows = () => page.locator('#ck-thread [data-conversation-key^="message:"]').count();
    const earlier = page.locator('#ck-thread [data-earlier-messages]');

    await step('it opens on the newest 100', async () => {
      await page.goto(`${g.url}/acme/website/tasks/${num}`);
      await earlier.waitFor();
      expect(reads).toContain(`/api/tasks/${task.id}?messages=100`);
      expect(await rows()).toBe(100);
      expect((await earlier.innerText()).trim()).toBe('150 earlier messages');
      expect(await page.locator('#ck-thread [data-conversation-key="message:a249"]').count()).toBe(1);
      // The page putting the thread at its top reads nothing: only a person scrolling does.
      await page.locator('#ck-thread').evaluate((thread) => { thread.scrollTop = 0; });
      await page.waitForTimeout(300);
      expect(await rows()).toBe(100);
      if (shots) await page.screenshot({ path: path.join(shots, 'conversation-window.png') });
    });

    await step('Earlier reads the rest', async () => {
      await earlier.click();
      await expect.poll(rows).toBe(250);
      expect(reads.some((read) => read.startsWith(`/api/tasks/${task.id}/transcript?role=do&before=150&limit=200`))).toBe(true);
      expect(await earlier.count()).toBe(0);
      expect(await page.locator('#ck-thread [data-conversation-key="message:m0"]').count()).toBe(1);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);
