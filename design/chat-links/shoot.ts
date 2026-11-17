/**
 * Screens of chat accounts linked to people (wiki planned/assistant §3):
 * the /link/chat confirmation, the bot's Linked / Guests rows in Project
 * settings → Events, and Profile → Chat accounts.
 * Run from the repo: npx tsx design/chat-links/shoot.ts  (writes PNGs here).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { findFreePortFrom } from '../../src/util/ports.js';
import { Gateway } from '../../src/gateway/server.js';
import { Store } from '../../src/store/db.js';
import { TokenAuthority } from '../../src/platform/tokens.js';
import { KarmaxBus } from '../../src/contrib/bus.js';
import { ContributionRegistry } from '../../src/contrib/registry.js';
import { Overlays } from '../../src/store/overlays.js';
import { WorldRegistry } from '../../src/world/registry.js';
import { KarmaxApi } from '../../src/platform/api.js';
import { CredentialBroker } from '../../src/autonomy/broker.js';
import { Vault } from '../../src/autonomy/vault.js';
import { seedProfiles } from '../../src/agent/profiles.js';
import { ChatLinks } from '../../src/integrations/chat-links.js';
import { IncomingWebhooks } from '../../src/integrations/incoming-webhooks.js';

const out = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-links-shoot-'));
process.env.KARMAX_HOME = dir;
const store = await Store.create(':memory:');
await seedProfiles(store, 'mock');
const tokens = new TokenAuthority();
const worlds = new WorldRegistry();
const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, broker });
const project = await store.createProject('Factory');
const gateway = await Gateway.create({ store, tokens, worlds, client, api, broker, bus: new KarmaxBus(),
  contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
  agentInfo: { provider: 'mock', reason: 'chat links screens' } });
const running = await gateway.listen(await findFreePortFrom(49120));
const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
const fetcher = (async (url: string) => new Response(JSON.stringify(String(url).includes('getMe')
  ? { ok: true, result: { id: 42, username: 'factory_bot' } } : { ok: true }))) as unknown as typeof fetch;
const { hook } = await api.createIncomingWebhook(token, project.id, { name: 'Telegram bot', kind: 'telegram', credentials: { botToken: '1:a' } },
  { hookUrl: (id) => `${running.url}/api/hooks/${id}`, fetcher });
await api.updateIncomingWebhook(token, hook.id, { allowed: [{ id: '81', name: 'Grace' }] });
const links = new ChatLinks(store);
await links.redeem((await links.offer(hook, { id: '7', name: 'Ada' })).token, 'me');
await new IncomingWebhooks(store, broker).noteAsking(hook.id, { id: '66', name: 'Eve', text: 'can you redeploy staging?' });
const pending = await links.offer(hook, { id: '9', name: 'Lin' });

const browser = await chromium.launch({ headless: true });
for (const scheme of ['light', 'dark'] as const) {
  const page = await (await browser.newContext({ viewport: { width: 1180, height: 760 }, colorScheme: scheme, serviceWorkers: 'block' })).newPage();
  await page.route('**/api/session', async (route) => {
    const session = await (await route.fetch()).json();
    await route.fulfill({ json: { ...session, user: { id: 'me', name: 'Me', email: 'me@example.test' } } });
  });
  await page.goto(`${running.url}/link/chat?t=${pending.token}`);
  await page.locator('#chat-link-yes').waitFor();
  await page.screenshot({ path: path.join(out, `link-page-${scheme}.png`) });
  await page.goto(`${running.url}/personal/factory/settings#project-events`);
  await page.locator('.pe-people').waitFor();
  await page.locator('#project-events-box').screenshot({ path: path.join(out, `bot-rows-${scheme}.png`) });
  await page.goto(`${running.url}/profile`);
  await page.locator('#chat-links-card:not([hidden])').waitFor();
  await page.locator('#chat-links-card').screenshot({ path: path.join(out, `profile-card-${scheme}.png`) });
}
await browser.close();
await running.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('screens in', out);
