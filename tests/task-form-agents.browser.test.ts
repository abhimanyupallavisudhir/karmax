import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { seedProfiles } from '../src/agent/profiles.js';
import { RESPOND_PROMPT_DEFAULT } from '../src/domain/respond-prompt.js';

/**
 * The task form describes every agent completely (wiki planned/collaboration-
 * model): Prompt → Agent → Responder → Review route → where it runs → when it
 * starts, each agent one Agent block with a collapsed Authorization row. The
 * Responder and an agent Review layer carry their own authority to the API,
 * which stores it per participant.
 */
it('composes a task whose Responder and Reviewer carry their own authority', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-form-agents-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority();
  const worlds = new WorldRegistry();
  const project = await store.createProject('Agents');
  await seedProfiles(store, 'mock');
  const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
  // A draft saved when the Responder's prompt was still the pre-filled template.
  const legacy = await store.createTask({ projectId: project.id, title: 'Legacy', workflow: 'software-dev', workflowVersion: '1.26.0',
    params: { prompt: 'Legacy', draft: true, responder: { kind: 'agent', provider: 'mock', prompt: RESPOND_PROMPT_DEFAULT } } });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'task form agents test' } });
  const running = await gateway.listen(await findFreePortFrom(48870));
  const browser = await chromium.launch({ headless: true });
  try {
    // Requests a service worker relays are not the page's: keep them visible.
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const bodies: Array<{ method: string; url: string; body: any }> = [];
    page.on('request', (request) => {
      if (/\/api\/(projects\/[^/]+\/tasks|tasks\/[^/]+\/params)$/.test(new URL(request.url()).pathname) && request.method() !== 'GET')
        bodies.push({ method: request.method(), url: request.url(), body: request.postDataJSON() });
    });
    await page.goto(`${running.url}/personal/agents`);
    await page.locator('#expand-task').click();
    const body = page.locator('#tf-body');
    await expect.poll(() => body.locator('.tf-main > *').evaluateAll((elements) => elements.map((el) =>
      el.matches('[data-row="prompt"]') ? 'prompt' : el.classList.contains('tf-agent') ? 'agent'
        : el.classList.contains('tf-responder') ? 'responder' : el.classList.contains('tf-confirmer') ? 'review'
          : el.classList.contains('tf-where') ? 'where' : el.matches('details.advanced') ? 'triggers'
            : el.classList.contains('repeat-row') ? 'repeatable' : 'other'))).toEqual(
      ['prompt', 'agent', 'responder', 'review', 'where', 'triggers', 'repeatable']);
    // The task's own authority lives in the main Agent block, collapsed; the
    // sidebar keeps only organization metadata and logins.
    const main = body.locator('.tf-agent .agent-authority');
    expect(await main.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
    expect(await main.locator('#tf-authorization, #tf-vault-open, #tf-payments').count()).toBe(3);
    expect(await page.locator('.tf-side').locator('#tf-authorization, #tf-vault-open, #tf-payments').count()).toBe(0);
    expect(await page.locator('.tf-side [data-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row'))))
      .toEqual(['__org', '__github-merge', '__attempts', '__creds', '__notes']);
    expect(await main.locator('.aa-summary').textContent()).toContain('Developer');

    await body.locator('textarea[data-field="prompt"]').fill('Ship it');
    // Responder: an agent with instructions and a narrower authority.
    await body.locator('.rf-kind').selectOption('agent');
    const responder = body.locator('.responder-field .agent-block');
    expect(await responder.locator('.ab-instructions').inputValue()).toBe('');
    await responder.locator('.ab-instructions').fill('Answer from the README');
    await responder.locator('.agent-authority > summary').click();
    await expect.poll(() => responder.locator('.aa-summary').textContent()).toBe('Same as Agent');
    await responder.locator('.authz-level-select').selectOption('viewer');
    await expect.poll(() => responder.locator('.aa-summary').textContent()).toContain('Viewer');
    // Review route: an agent review before the human confirmation.
    await body.locator('.cf-add').click();
    const reviewer = body.locator('.cf-layer[data-kind="agent"] .agent-block');
    await reviewer.locator('.ab-instructions').fill('Check the tests');
    await reviewer.locator('.agent-authority > summary').click();
    await reviewer.locator('.authz-level-select').selectOption('maintainer');

    await expect.poll(async () => {
      const task = (await store.listTasks(project.id)).find((candidate) => candidate.params?.prompt === 'Ship it');
      return task?.params;
    }, { timeout: 15_000 }).toMatchObject({
      responder: { kind: 'agent', prompt: 'Answer from the README',
        authority: { authorization: { level: 'viewer', scope: 'projects', projectIds: [project.id] } } },
      confirm: { layers: [
        { kind: 'agent', prompt: 'Check the tests', authority: { authorization: { level: 'maintainer' } } },
        { kind: 'human', audience: ['@creator'] },
      ] },
      _agentAuthorization: {
        responder: { level: 'viewer', requested: { authorization: { level: 'viewer' } } },
        confirm: { level: 'maintainer' },
      },
    });
    // The main agent's authority still rides on the task's own fields.
    const saved = bodies.filter((request) => request.body?.params?.prompt === 'Ship it');
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)!.body.params).not.toHaveProperty('_agentAuthorization');
    expect(saved.find((request) => request.method === 'POST')?.body).toMatchObject({
      authorization: { level: 'developer' }, credentialGrants: [], draft: true, allowAttenuation: true });
    // "Same as Agent" hands the Responder back to the task's authority.
    await responder.locator('.aa-reset').click();
    await expect.poll(async () => (await store.listTasks(project.id))
      .find((candidate) => candidate.params?.prompt === 'Ship it')?.params?._agentAuthorization, { timeout: 15_000 })
      .toEqual({ confirm: expect.objectContaining({ level: 'maintainer' }) });

    // A stored copy of the old request template is not instructions.
    await page.locator('#tf-close').click();
    await page.locator('#main').getByText('Legacy', { exact: true }).first().click();
    await expect.poll(() => page.locator('#tf-body .responder-field .ab-instructions').inputValue()).toBe('');
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
