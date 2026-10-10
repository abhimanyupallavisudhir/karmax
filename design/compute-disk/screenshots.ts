/**
 * Screenshots of the compute-disk UI (wiki features/computers) in the real
 * console against the real gateway and API, without Temporal: the Computer
 * block at the account's ceiling, the task's disk meter, and Out of disk with
 * Bigger disk (enabled, and disabled at the ceiling). The limits are the ones
 * measured live on 2026-10-10 (org_personal's E2B team, production Daytona).
 *
 *   npx tsx design/compute-disk/screenshots.ts     → design/compute-disk/*.png
 *
 * A native hover tooltip does not appear in a screenshot, so the script draws
 * the element's own title text beside it, styled as a tooltip.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { findFreePortFrom } from '../../src/util/ports.js';
import { Gateway } from '../../src/gateway/server.js';
import { Store } from '../../src/store/db.js';
import { TokenAuthority } from '../../src/platform/tokens.js';
import { KarmaxBus } from '../../src/contrib/bus.js';
import { ContributionRegistry } from '../../src/contrib/registry.js';
import { Overlays } from '../../src/store/overlays.js';
import { WorldRegistry } from '../../src/world/registry.js';
import { KarmaxApi } from '../../src/platform/api.js';
import { seedProfiles } from '../../src/agent/profiles.js';
import { Vault } from '../../src/autonomy/vault.js';
import { CredentialBroker } from '../../src/autonomy/broker.js';
import { WorldProviderConnectionService } from '../../src/world/connections.js';

const out = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-disk-shots-'));
process.env.KARMAX_HOME = dir;
const store = await Store.create(':memory:');
await seedProfiles(store, 'mock');
const tokens = new TokenAuthority();
const worlds = new WorldRegistry();
const client = { workflow: { getHandle: () => ({ query: async () => { throw new Error('no workflow'); }, signal: async () => undefined,
  executeUpdate: async () => ({ applied: [] }) }), start: async () => ({}) } } as any;
const measured: Record<string, any> = {
  e2b: { cpu: 8, memoryMb: 8192, diskGb: 29, checkedAt: Date.UTC(2026, 9, 10, 9, 3) },
  daytona: { cpu: 4, memoryMb: 8192, diskGb: 10, pool: { cpu: 10, memoryMb: 10_240, diskGb: 30 }, checkedAt: Date.UTC(2026, 9, 10, 9, 3) },
};
const providerConnections = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(dir)),
  { check: async () => undefined, limits: async (provider) => measured[provider] });
for (const provider of ['e2b', 'daytona']) {
  await providerConnections.save({ organizationId: 'org_personal', provider, apiKey: `${provider}-key` });
  await providerConnections.test('org_personal', provider);
}
const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'shots', contentDir: dir, providerConnections });
const project = await store.createProject('Pramana');
await store.setOrganizationExecutionPolicy(project.organizationId!, { worldProvider: 'e2b', resources: { cpu: 2, memoryMb: 2048 } });

async function task(title: string, usedMb: number, totalMb: number, view: Record<string, unknown>) {
  const record = await store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.27.0',
    params: { prompt: title, ...(totalMb > 23_000 ? { computer: { diskGb: 29 } } : {}) } });
  await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: record.id, generation: 1, root: '/home/user/karmax',
    workspaceRoot: '/home/user/karmax', branch: `tavya/${record.id}`, base: 'main',
    meta: { projectId: project.id, computer: { cpu: 2, memoryMb: 2048, ...(totalMb > 23_000 ? { diskGb: 29 } : {}) } } } as any, project.id);
  await store.saveView(record.id, { taskId: record.id, title, workflow: 'software-dev', status: 'active', stage: 'do', messages: [],
    actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }], editableParams: [], branch: `tavya/${record.id}`,
    targetBranch: 'main', ...view } as any);
  await store.kvSet(`world-usage:${record.id}`, JSON.stringify({ at: Date.now() - 3 * 60_000, disk: { usedMb, totalMb },
    memory: { usedMb: 1180, totalMb: 1982 } }));
  return (await store.getTask(record.id))!;
}
const outOfDisk = (error: string) => ({ status: 'blocked', outOfDisk: true, error,
  waitingFor: { kind: 'human', reason: 'error', audience: ['@creator'] },
  actions: [{ name: 'retry', kind: 'signal', label: 'Retry', enabled: true }, { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }] });
const working = await task('Rebuild the SQLite database', 17_700, 22_528, {});
const full = await task('Build pramana.db', 22_528, 22_528, outOfDisk(
  'Out of disk: this task\'s computer filled its 22 GB disk, so its agent stopped. Bigger disk (up to 29 GB) fixes it (POST /api/tasks/…/bigger-disk). Last error: SqliteError: database or disk is full'));
const ceiling = await task('Integrate workstreams', 29_696, 29_841, outOfDisk(
  'Out of disk: this task\'s computer filled its 29 GB disk, so its agent stopped. It already has the largest disk this account allows (29 GB): free space in its terminal.'));

const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(), providerConnections,
  contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'shots', staticDir: path.resolve('web'),
  agentInfo: { provider: 'mock', reason: 'compute-disk screenshots' } });
const running = await gateway.listen(await findFreePortFrom(49210));
const browser = await chromium.launch({ headless: true });

/** Draw an element's own `title` beside it, as the browser would on hover. */
async function showTooltip(page: Page, selector: string) {
  await page.locator(selector).first().evaluate((element) => {
    element.scrollIntoView({ block: 'center' });
    const title = element.getAttribute('title') ?? element.closest('[title]')?.getAttribute('title') ?? '';
    const box = element.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.textContent = title;
    const below = box.bottom + 60 < window.innerHeight;
    Object.assign(tip.style, { position: 'fixed', left: `${Math.max(8, Math.min(box.left, window.innerWidth - 430))}px`, maxWidth: '420px', zIndex: '9999',
      ...(below ? { top: `${box.bottom + 6}px` } : { bottom: `${window.innerHeight - box.top + 6}px` }),
      background: '#2b2b2b', color: '#f4f4f4', font: '12px system-ui, sans-serif', padding: '5px 8px', borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,.25)' });
    document.body.appendChild(tip);
    // Keep it inside the element's section: right-align it when it would run past.
    const section = element.closest('section, .computer-providers, .tp-foot, .tp-head') ?? document.body;
    const edge = section.getBoundingClientRect().right;
    const width = tip.getBoundingClientRect().width;
    if (box.left + width > edge) tip.style.left = `${Math.max(8, edge - width)}px`;
  });
}
async function shot(name: string, route: string, prepare: (page: Page) => Promise<void>, clip?: string) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${running.url}${route}`);
  await prepare(page);
  await page.waitForTimeout(400);
  const file = path.join(out, `${name}.png`);
  // A clipped element keeps room below it for the drawn tooltip.
  const box = clip ? await page.locator(clip).first().boundingBox() : null;
  if (box) await page.screenshot({ path: file, clip: { x: box.x, y: box.y, width: box.width, height: box.height + 56 } });
  else await page.screenshot({ path: file });
  console.log(file);
  await context.close();
}

const slug = `/personal/${project.slug ?? 'pramana'}`;
// 1. The Computer block at the account's ceiling, its hover text, and the provider rows.
await shot('computer-block-ceiling', slug, async (page) => {
  await page.locator('#expand-task').click();
  const block = page.locator('#tf-body .tf-computer .computer-field');
  await block.waitFor();
  await block.locator('.cf-disk').fill('29');
  await showTooltip(page, '#tf-body .tf-computer .cf-disk');
}, '#tf-body .tf-computer');
await shot('computer-block-over', slug, async (page) => {
  await page.locator('#expand-task').click();
  const block = page.locator('#tf-body .tf-computer .computer-field');
  await block.waitFor();
  await block.locator('.cf-disk').fill('40');
  await showTooltip(page, '#tf-body .tf-computer .cf-disk');
}, '#tf-body .tf-computer');
await shot('settings-computers', '/personal/settings#settings-code', async (page) => {
  await page.locator('#org-computers .computer-limits').first().waitFor();
  await showTooltip(page, '#org-computers .computer-limits');
}, '#org-computers');
// 2. The disk meter in the task header.
await shot('usage-meter', `${slug}/tasks/${working.num}`, async (page) => {
  await page.locator('.tp-head .disk-meter').waitFor();
  await showTooltip(page, '.tp-head .disk-meter');
});
// 3. Out of disk: Bigger disk, then at the ceiling.
await shot('out-of-disk', `${slug}/tasks/${full.num}/overview`, async (page) => {
  await page.locator('#bigger-disk').waitFor();
  await showTooltip(page, '#bigger-disk');
});
await shot('out-of-disk-at-ceiling', `${slug}/tasks/${ceiling.num}/overview`, async (page) => {
  await page.locator('#bigger-disk').waitFor();
  await showTooltip(page, '#bigger-disk');
});

await browser.close();
await running.close();
await store.close();
fs.rmSync(dir, { recursive: true, force: true });
