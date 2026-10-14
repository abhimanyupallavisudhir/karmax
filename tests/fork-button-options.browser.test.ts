import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
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
 * A task page's Fork button opens the task form on that task's agent exactly
 * as picking it in the form does: the chip names the source and offers
 * "Re-authorize previous grants?" and "Also add as dependency?", both on by
 * default. The source is usually archived (finished tasks are), so it is not in
 * the client's task list; the form must resolve it anyway — also when the
 * resulting draft is reopened later.
 */
it('the Fork button offers re-authorization and the dependency for an archived source', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-button-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const worlds = new WorldRegistry();
  const project = await store.createProject('Forks');
  await seedProfiles(store, 'mock');
  const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, authorization, taskQueue: 'test', contentDir: dir });
  const archivedSource = async (title: string, status: string) => {
    const task = await store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: title, _authorization: { level: 'maintainer', scope: 'projects', projectIds: [project.id], capabilities: [] } } });
    await store.saveView(task.id, { taskId: task.id, status, stage: status === 'done' ? 'done' : 'review', branch: `tavya/${task.id}`,
      targetBranch: 'main', actions: [], messages: [], state: {} } as any);
    await store.kvSet(`session:${task.id}:do`, `session-${task.id}`);
    await store.setTaskArchived(task.id, true);
    return task;
  };
  const finished = await archivedSource('Finished source', 'done');
  const unfinished = await archivedSource('Shelved source', 'waiting');
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'fork button test' } });
  const running = await gateway.listen(await findFreePortFrom(48905));
  const browser = await chromium.launch({ headless: true });
  const drafts = async () => (await store.listTasks(project.id)).filter((t) => t.params.draft);
  const fork = async (page: Page, num: number) => {
    await page.goto(`${running.url}/personal/forks/tasks/${num}`);
    await page.locator('#fork-task-agent').click();
    await page.locator('#tf-body .af-resume-chosen .af-resume-source').waitFor();
  };
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const chosen = page.locator('#tf-body .agent-field[data-agent="do"] .af-resume-chosen');
    const reauthorize = chosen.locator('.af-resume-reauthorize');
    const dependency = chosen.locator('.af-resume-add-dependency');
    const level = page.locator('#tf-authorization .authz-level-select');
    const base = page.locator('#tf-body [data-field="base"]');

    // A finished source: its grants are re-applied; there is nothing to wait for.
    await fork(page, finished.num!);
    expect(await chosen.locator('.af-resume-source').textContent()).toContain('Finished source');
    expect(await reauthorize.isVisible()).toBe(true);
    expect(await reauthorize.isChecked()).toBe(true);
    expect(await level.inputValue()).toBe('maintainer');
    expect(await dependency.count()).toBe(0);
    expect(await base.inputValue()).toBe('main');
    // Opening the form is not an edit: leaving it keeps no draft.
    await page.locator('#tf-close').click();
    await page.waitForTimeout(1200);
    expect(await drafts()).toEqual([]);

    // An unfinished source: re-authorized and waited for, like a picked one.
    await fork(page, unfinished.num!);
    expect(await reauthorize.isVisible()).toBe(true);
    expect(await reauthorize.isChecked()).toBe(true);
    expect(await level.inputValue()).toBe('maintainer');
    expect(await dependency.isVisible()).toBe(true);
    expect(await dependency.isChecked()).toBe(true);
    expect(await page.locator(`#dep-chips [data-depid="${unfinished.id}"]`).textContent()).toContain('Shelved source');
    expect(await base.inputValue()).toBe('main');
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('carry on');
    await expect.poll(async () => (await drafts())[0]?.params, { timeout: 10_000 }).toMatchObject({
      base: 'main', triggers: [{ kind: 'dependency', tasks: [unfinished.id] }],
      'agent:do': { resumeFrom: { taskId: unfinished.id, role: 'do' } }, _authorization: { level: 'maintainer' } });
    const draft = (await drafts())[0]!;

    // Reopening that draft still names the archived source and offers its options.
    await page.goto(`${running.url}/personal/forks/tasks/${draft.id}`);
    await chosen.locator('.af-resume-source').waitFor();
    expect(await chosen.locator('.af-resume-source').textContent()).toContain('Shelved source');
    expect(await chosen.locator('.af-resume-reauth').isVisible()).toBe(true);
    expect(await dependency.isVisible()).toBe(true);
    expect(await dependency.isChecked()).toBe(true);
    await expect.poll(() => page.locator(`#dep-chips [data-depid="${unfinished.id}"]`).textContent()).toContain('Shelved source');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await running.close();
    await store.close();
    if (priorHome === undefined) delete process.env.KARMAX_HOME;
    else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
