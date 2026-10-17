import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { seedProfiles } from '../src/agent/profiles.js';

/**
 * A task whose proposal was confirmed keeps its message box: Continue carries
 * the agent on in a new task (wiki features/continue-after-confirm), and the
 * page follows it there.
 */
it('Continue on a finished task opens the task that carries its agent on', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continue-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const worlds = new WorldRegistry();
  const project = await store.createProject('Continue');
  await seedProfiles(store, 'mock');
  const client = { workflow: { getHandle: () => ({ query: async () => undefined, signal: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, authorization, taskQueue: 'test', contentDir: dir });
  const source = await store.createTask({ projectId: project.id, title: 'Fix the landing', workflow: 'software-dev', workflowVersion: '1.30.0',
    params: { prompt: 'Fix the landing', 'agent:do': { provider: 'mock' } } });
  await store.saveView(source.id, { taskId: source.id, title: source.title, workflow: 'software-dev', stage: 'done', status: 'done',
    branch: `tavya/${source.id}`, targetBranch: 'main', actions: [], state: {}, updatedAt: 3,
    messages: [{ id: 'm0', role: 'user', text: 'Fix the landing', ts: 1 }, { id: 'a1', role: 'agent', text: 'Fixed and landed.', ts: 2 }],
    participants: [{ key: 'do', label: 'Agent', role: 'do', state: 'idle', messages: 1 }] } as any);
  await store.kvSet(`session:${source.id}:do`, 'source-session');
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'continue test' } });
  const running = await gateway.listen(await findFreePortFrom(48955));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/continue/tasks/${source.num}`);
    const send = page.locator('.followup-box[data-role="do"] .followup-send');
    await send.waitFor();
    expect((await send.textContent())?.trim()).toBe('Continue');
    expect(await send.getAttribute('title')).toBe('The approved PR lands as it is. The agent carries on in a new task.');
    await page.locator('.followup-box[data-role="do"] .followup-input').fill('Now make the retry wait visible');
    const screenshots = process.env.KARMAX_SCREENSHOT_DIR;
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'continue-after-confirm.png') });
    await send.click();
    await expect.poll(async () => (await store.listTasks(project.id)).length, { timeout: 10_000 }).toBe(2);
    const next = (await store.listTasks(project.id)).find((task) => task.id !== source.id)!;
    expect(next.params['agent:do']).toMatchObject({ resumeFrom: { taskId: source.id, role: 'do' } });
    expect(next.title).toBe('Now make the retry wait visible');
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(`/personal/continue/tasks/${next.num}`);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await running.close();
    await store.close();
    if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
  }
}, 60_000);
