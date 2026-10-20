import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
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
import * as network from '../src/mcp/connections/http.js';
import type { AgentSpec } from '../src/domain/types.js';
/** The main agent's fork source as stored in a task's params. */
const resumeOf = (params: Record<string, unknown>) =>
  (params['agent:do'] as { resumeFrom: NonNullable<AgentSpec['resumeFrom']> }).resumeFrom;


const fixture = (name: string) => fs.readFileSync(path.resolve('tests/fixtures', name));
const GOOD = 'https://share.gemini.google/4gF2GfgiLKzw';
const GONE = 'https://chatgpt.com/share/gone';

/**
 * "Fork a previous agent" reads a pasted link (or an uploaded file) at once,
 * the way the agent's first turn will, says what it read, and an unreadable
 * source is refused before the task is queued (lvpm#4 failed only at the turn,
 * after its world was made). The network is the guarded fetch, stubbed here;
 * tests/conversation-shares-live.test.ts reads real links.
 */
it('reads a pasted share link, refuses an unreadable one, and the queued agent starts from what was read', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-check-'));
  process.env.KARMAX_HOME = dir;
  const fetches = vi.spyOn(network, 'publicShareFetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === GOOD) return new Response(null, { status: 301, headers: { location: 'https://gemini.google.com/share/50a32fbbfd3c' } });
    if (url.startsWith('https://gemini.google.com/_/BardChatUi/')) return new Response(fixture('gemini-share.txt'));
    return new Response('', { status: 404 });
  });
  const store = await Store.create(':memory:');
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const tokens = new TokenAuthority();
  const worlds = new WorldRegistry();
  const project = await store.createProject('Forks');
  await seedProfiles(store, 'mock');
  const started: unknown[] = [];
  const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async (...args: unknown[]) => { started.push(args); return {}; } } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, objects });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, objects, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'conversation check test' } });
  const running = await gateway.listen(await findFreePortFrom(48960));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/forks`);
    await page.locator('#expand-task').click();
    const agent = page.locator('#tf-body .tf-agent');
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('Carry on from the chat');
    await agent.locator('.af-resume-enabled').check();
    const link = agent.locator('.af-resume-session');
    const check = agent.locator('.af-resume-check');
    expect(await link.getAttribute('placeholder')).toBe('...or paste a share link or provider conversation ID');

    // An unreadable link says so, and the task is not queued.
    await link.fill(GONE);
    await expect.poll(() => check.textContent()).toBe('Share link not found; it may have been deleted or unshared');
    expect(await check.getAttribute('class')).toContain('err');
    await page.locator('#tf-queue').click();
    await expect.poll(() => page.locator('.toast').allTextContents()).toContainEqual(expect.stringContaining('Share link not found'));
    expect(started).toEqual([]);

    // A readable one says what it read, and that is what the task keeps.
    await link.fill(GOOD);
    await expect.poll(() => check.textContent()).toBe('Self-location fixture · 4 messages');
    expect(await check.getAttribute('title')).toBe('Read now: the agent starts from this copy');
    await agent.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR || dir, 'conversation-check.png') });
    await page.locator('#tf-queue').click();
    await expect.poll(() => started.length, { timeout: 15_000 }).toBe(1);
    const task = (await store.listTasks(project.id)).find((candidate) => candidate.params.prompt === 'Carry on from the chat')!;
    const resumeFrom = resumeOf(task.params);
    expect(resumeFrom).toEqual({ upload: expect.objectContaining({ share: GOOD, format: 'gemini-share', title: 'Self-location fixture', messages: 4 }) });
    expect(errors).toEqual([]);

    // The queued agent's first turn has the conversation, read from the stored copy.
    fetches.mockClear().mockRejectedValue(new Error('Unexpected share request'));
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
        worldHandle: world.handle, messages: [{ id: 'm1', role: 'user', text: 'Carry on from the chat', ts: 0 }],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'Carry on from the chat', project: {},
          workflow: 'software-dev', agents: { do: { provider: 'mock', resumeFrom } } },
      } as any);
    } finally { await world.destroy(); }
    expect(seen.at(-1)).toContain('It is the problem of **centered** information.');
    expect(fetches).not.toHaveBeenCalled();

    // An uploaded file is checked the same way, and reopening keeps what it read.
    await page.goto(`${running.url}/personal/forks`);
    await page.locator('#expand-task').click();
    await agent.locator('.af-resume-enabled').check();
    await agent.locator('.af-resume-upload input').setInputFiles({ name: 'saved.json', mimeType: 'application/json',
      buffer: fixture('claude-chat-snapshot.json') });
    const chip = agent.locator('.af-resume-uploaded');
    await expect.poll(() => chip.locator('.af-resume-upload-name').textContent()).toBe('Latent variable experiments · 4 messages');
    expect(await chip.locator('.af-resume-upload-name').getAttribute('title')).toBe('saved.json');
    await page.waitForTimeout(100);
    await chip.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR || dir, 'conversation-upload.png') });
    // Another file replaces it, once the draft has saved (an upload in the same
    // instant fires no change event in a headless browser).
    await expect.poll(() => page.locator('#tf-savestate').textContent(), { timeout: 10_000 }).toBe('Draft saved');
    await agent.locator('.af-resume-upload input').setInputFiles({ name: 'notes.json', mimeType: 'application/json',
      buffer: Buffer.from('{"hello": "world"}') });
    await expect.poll(() => chip.locator('.af-resume-check.err').textContent()).toBe('file is not a recognized Codex or Claude conversation');
    expect(await chip.getAttribute('data-upload')).toBe('null');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await running.close();
    await store.close();
    vi.restoreAllMocks();
    if (priorHome === undefined) delete process.env.KARMAX_HOME;
    else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
