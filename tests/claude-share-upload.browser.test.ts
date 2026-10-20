import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { ProfileResolver, seedProfiles } from '../src/agent/profiles.js';

const SHARE = 'https://claude.ai/share/e510a898-8e59-4423-b613-12c7c5ac37a5';
const SNAPSHOT = 'https://claude.ai/api/chat_snapshots/e510a898-8e59-4423-b613-12c7c5ac37a5?rendering_mode=messages&render_all_tools=true';

/**
 * No server can read a claude.ai share (src/agent/panagent.ts
 * claudeShareSnapshotUrl), so a pasted Claude link says, under the field, which
 * file to save in the browser; uploading that file replaces the link, and the
 * agent starts from the conversation in it.
 */
it('a pasted Claude share link leads to uploading its saved conversation, which the agent starts from', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-share-upload-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const tokens = new TokenAuthority();
  const worlds = new WorldRegistry();
  const project = await store.createProject('Shares');
  await seedProfiles(store, 'mock');
  const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, objects, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'claude share upload test' } });
  const running = await gateway.listen(await findFreePortFrom(48940));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/shares`);
    await page.locator('#expand-task').click();
    const agent = page.locator('#tf-body .tf-agent');
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('Build the testbed');
    await agent.locator('.af-resume-enabled').check();
    const link = agent.locator('.af-resume-session');
    const hint = agent.locator('.af-resume-hint');
    expect(await hint.isVisible()).toBe(false);
    await link.fill(SHARE);
    await expect.poll(() => hint.isVisible()).toBe(true);
    expect(await hint.textContent()).toBe('Claude shows shares only in your browser: open this one, save it, then upload the file.');
    const open = hint.locator('a');
    expect(await open.getAttribute('href')).toBe(SNAPSHOT);
    expect(await open.getAttribute('target')).toBe('_blank');
    await page.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR || dir, 'claude-share-hint.png') });

    // The file saved from that page replaces the link.
    await agent.locator('.af-resume-upload input').setInputFiles({ name: 'e510a898-8e59-4423-b613-12c7c5ac37a5.json',
      mimeType: 'application/json', buffer: fs.readFileSync(path.resolve('tests/fixtures/claude-chat-snapshot.json')) });
    await expect.poll(() => agent.locator('.af-resume-uploaded').textContent()).toContain('e510a898-8e59-4423-b613-12c7c5ac37a5.json');
    expect(await link.inputValue()).toBe('');
    expect(await hint.isVisible()).toBe(false);
    const draft = async () => (await store.listTasks(project.id)).find((task) => task.params.prompt === 'Build the testbed');
    await expect.poll(async () => (await draft())?.params['agent:do'], { timeout: 15_000 }).toMatchObject({
      resumeFrom: { upload: { name: 'e510a898-8e59-4423-b613-12c7c5ac37a5.json', format: 'claude-export', projectId: project.id } } });
    expect(errors).toEqual([]);

    // The agent's first turn starts from the uploaded conversation.
    const task = (await draft())!;
    const seen: string[] = [];
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any) {
      seen.push(input.messages.map((m: any) => m.text).join('\n'));
      return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'ok' };
    } }]]) as any;
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const core = makeCoreActivities({ store, worlds, adapters, objects, profiles: new ProfileResolver(store, 'mock') } as any);
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    try {
      await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`, agentSlotGranted: true,
        worldHandle: world.handle, messages: [{ id: 'm1', role: 'user', text: 'Build the testbed', ts: 0 }],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'Build the testbed', project: {},
          workflow: 'software-dev', agents: { do: { provider: 'mock', resumeFrom: (task.params['agent:do'] as any).resumeFrom } } },
      } as any);
    } finally { await world.destroy(); }
    expect(seen.at(-1)).toContain('Plan the oversight experiments.');
    expect(seen.at(-1)).toContain('Build the testbed first, then the evaluations.');
  } finally {
    await browser.close();
    await running.close();
    await store.close();
    if (priorHome === undefined) delete process.env.KARMAX_HOME;
    else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
