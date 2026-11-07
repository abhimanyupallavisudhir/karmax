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
 * The message box is there while a task sets up its computer: what is said
 * shows with a clock until the agent can take it (wiki features/queued-messages),
 * can be taken back to edit, and is delivered when Do starts.
 */
it('a message said during setup waits with a clock, can be taken back, and is sent when the agent can take it', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const bus = new KarmaxBus();
  store.onEventRecorded((event) => bus.emit(event));
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const worlds = new WorldRegistry();
  const project = await store.createProject('Queued');
  await seedProfiles(store, 'mock');
  const delivered: Array<{ id: string; text: string }> = [];
  const client = { workflow: { getHandle: () => ({ query: async () => undefined,
    signal: async (name: string, message: { id: string; text: string }) => { if (name === 'followUp') delivered.push(message); } }),
  start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, authorization, taskQueue: 'test', contentDir: dir, bus });
  const task = await store.createTask({ projectId: project.id, title: 'Add the export', workflow: 'software-dev', workflowVersion: '1.30.0',
    params: { prompt: 'Add the export', 'agent:do': { provider: 'mock' } } });
  const view = (over: Record<string, unknown>) => ({ taskId: task.id, title: task.title, workflow: 'software-dev', status: 'active',
    branch: `tavya/${task.id}`, targetBranch: 'main', state: {}, messages: [{ id: 'm0', role: 'user', text: 'Add the export', ts: 1 }],
    participants: [{ key: 'do', label: 'Agent', role: 'do', state: 'idle', messages: 0 }], ...over }) as any;
  await store.saveView(task.id, view({ stage: 'setup', updatedAt: 2,
    actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }] }));
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, bus,
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'queued messages test' } });
  const running = await gateway.listen(await findFreePortFrom(48975));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/queued/tasks/${task.num}`);
    const input = page.locator('.followup-box[data-role="do"] .followup-input');
    const send = page.locator('.followup-box[data-role="do"] .followup-send');
    await input.waitFor();
    await input.fill('Write it as CSV, not JSON');
    await send.click();

    const pending = page.locator('.msg.pending');
    await pending.waitFor();
    expect(await pending.locator('.msg-text').textContent()).toContain('Write it as CSV, not JSON');
    expect(await pending.locator('.pending-mark').getAttribute('title')).toBe('Not sent yet. The agent gets it as soon as it can take messages.');
    expect(await input.inputValue()).toBe('');
    const screenshots = process.env.KARMAX_SCREENSHOT_DIR;
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'queued-message.png') });

    // Taken back, it is the box's text again; sent again, it waits again.
    await pending.locator('.unsend-pending').click();
    await expect.poll(() => input.inputValue()).toBe('Write it as CSV, not JSON');
    await expect.poll(() => pending.count()).toBe(0);
    await input.fill('Write it as CSV, with a header row');
    await send.click();
    await pending.waitFor();
    expect(delivered).toEqual([]);

    // Do starts: the agent gets it, and it shows as said.
    await store.saveView(task.id, view({ stage: 'do', updatedAt: 3,
      actions: [{ name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true },
        { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }] }));
    await expect.poll(() => delivered.map((message) => message.text), { timeout: 10_000 }).toEqual(['Write it as CSV, with a header row']);
    await expect.poll(() => pending.count(), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => page.locator('.msg.user', { hasText: 'Write it as CSV, with a header row' }).count(), { timeout: 10_000 }).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await running.close();
    await store.close();
    if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
  }
}, 90_000);
