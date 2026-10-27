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
 * Confirm PR is accepted the moment Temporal takes the signal, but the
 * workflow acts on it only at its next workflow task, which for a long history
 * evicted from the worker's cache waits on a replay (pramana#111: two minutes).
 * Meanwhile the page, reloaded or not, says the confirmation is under way
 * instead of offering Confirm PR again.
 */
it('keeps an accepted Confirm PR under way until the workflow publishes, across a reload', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-accepted-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const worlds = new WorldRegistry();
  const project = await store.createProject('Release');
  await seedProfiles(store, 'mock');
  const signals: string[] = [];
  // Temporal accepts each signal; the workflow publishes nothing (it is replaying).
  const client = { workflow: { getHandle: () => ({ query: async () => undefined,
    signal: async (name: string) => { signals.push(name); } }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, authorization, taskQueue: 'test', contentDir: dir });
  const task = await store.createTask({ projectId: project.id, title: 'Ship the release', workflow: 'software-dev', workflowVersion: '1.30.0',
    params: { prompt: 'Ship the release', 'agent:do': { provider: 'mock' } } });
  const review = { taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'review', status: 'waiting',
    waitingFor: { kind: 'human', audience: ['@creator'] }, branch: `tavya/${task.id}`, targetBranch: 'main', state: {}, updatedAt: 3821,
    actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm PR', enabled: true },
      { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }],
    messages: [{ id: 'm0', role: 'user', text: 'Ship the release', ts: 1 }, { id: 'a1', role: 'agent', text: 'Ready for review.', ts: 2 }] } as any;
  await store.saveView(task.id, review);
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'confirm test' } });
  const running = await gateway.listen(await findFreePortFrom(48965));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const foot = page.locator('#tp-foot');
    const confirm = foot.locator('[data-act="confirm"]');
    await page.goto(`${running.url}/personal/release/tasks/${task.num}`);
    await confirm.click();
    await expect.poll(() => foot.locator('.action-pending').textContent()).toBe('Confirming…');
    expect(await confirm.count()).toBe(0);
    expect(signals).toEqual(['confirm']);
    expect(await page.locator('.toast').first().textContent()).toContain('Confirmed');
    const screenshots = process.env.KARMAX_SCREENSHOT_DIR;
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'confirm-accepted.png') });

    await page.reload();
    await expect.poll(() => foot.locator('.action-pending').textContent()).toBe('Confirming…');
    expect(await confirm.count()).toBe(0);
    expect(await foot.locator('[data-act="cancel"]').count()).toBe(1);

    // The workflow acts and publishes: the page follows its view.
    await store.saveView(task.id, { ...review, stage: 'merge', status: 'active', waitingFor: undefined, updatedAt: 3870,
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }] });
    await page.reload();
    await foot.locator('[data-act="cancel"]').waitFor();
    expect(await foot.locator('.action-pending').count()).toBe(0);
    expect(signals).toEqual(['confirm']);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await running.close();
    await store.close();
    if (priorHome === undefined) delete process.env.KARMAX_HOME;
    else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
