// Installation → Managed compute → Model gateways (wiki features/model-gateways):
// one compact row per gateway with its on/off toggle, a tip saying the operator
// answers for its terms and that prompts, code and secrets pass through it, and
// a dialog to add one (off unless switched on).
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { closeConsoleBrowser, consolePage, signedIn } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

const gateway = { id: 'gw_1', name: 'Company LiteLLM', harnesses: ['claude', 'codex'], baseUrl: 'https://litellm.example.com',
  models: ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-mystery-9'], priceMultiplier: 0.3, enabled: false, keyConfigured: true,
  unpriced: ['claude-mystery-9'], costMicros: 1_250_000, chargedMicros: 2_500_000 };

async function card() {
  const ui = await consolePage({ path: '/org/workspace', api: signedIn((call) => {
    const route = call.path.split('?')[0];
    if (route === '/api/settings/managed-compute') return { providers: [] };
    if (route === '/api/settings/included-model') return { settings: { model: 'deepseek/deepseek-v4.1-flash-1017', effort: 'max', enabled: true,
      keyConfigured: true, organizations: 3, costMicros: 400_000, chargedMicros: 800_000 } };
    if (route === '/api/settings/model-gateways' && call.method === 'GET') return { gateways: [gateway] };
    if (route?.startsWith('/api/settings/model-gateways')) return { gateway, gateways: [gateway] };
    return undefined;
  }) });
  await ui.run('boot()');
  await ui.page.locator('#rail').first().waitFor({ state: 'attached' });
  await ui.run(`document.querySelector('#main').innerHTML = '<div class="main-inner" style="max-width:960px;padding:24px"><div class="card" id="managed-compute-card"></div></div>'; wireManagedComputeCard()`);
  await ui.page.locator('.model-gateway[data-gateway="gw_1"]').waitFor();
  return ui;
}

describe('model gateways in Installation → Managed compute', () => {
  it('shows each gateway in one row, off, with its harnesses, price, unpriced models and month, and the operator\'s responsibility in a tip', async () => {
    const ui = await card();
    const row = ui.page.locator('.model-gateway[data-gateway="gw_1"]');
    expect(await row.innerText()).toMatch(/Company LiteLLM\s+Claude Code · Codex · 0\.3× list\s+1 unpriced\s+\$1\.25 → \$2\.50/);
    expect(await row.locator('.model-gateway-enabled').isChecked()).toBe(false);
    const tip = await ui.page.locator('.model-gateways .info-dot').first().getAttribute('title');
    expect(tip).toMatch(/You answer for each gateway’s terms/);
    expect(tip).toMatch(/prompts, code and any secrets in them pass through it/);
    if (process.env.KARMAX_SHOTS) {
      fs.mkdirSync(process.env.KARMAX_SHOTS, { recursive: true });
      await ui.page.locator('#managed-compute-card').screenshot({ path: `${process.env.KARMAX_SHOTS}/model-gateways-row.png` });
    }
    // The toggle saves at once.
    await row.locator('.model-gateway-enabled').check();
    await expect.poll(() => ui.calls.find((call) => call.method === 'PUT')).toMatchObject({ path: '/api/settings/model-gateways/gw_1', body: { enabled: true } });
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('adds one off unless switched on, its models as a list', async () => {
    const ui = await card();
    await ui.page.locator('.model-gateway-add').click();
    const dialog = ui.page.locator('[aria-label="Model gateway"]');
    await dialog.locator('.gateway-name').fill('Bedrock gateway');
    await dialog.locator('.gateway-url').fill('https://bedrock-gw.example.com');
    await dialog.locator('.gateway-key').fill('secret');
    await dialog.locator('.gateway-models').fill('claude-opus-5-5, claude-haiku-5-5');
    await dialog.locator('.gateway-price').fill('0.8');
    if (process.env.KARMAX_SHOTS) await dialog.screenshot({ path: `${process.env.KARMAX_SHOTS}/model-gateways-dialog.png` });
    await dialog.locator('.gateway-save').click();
    await expect.poll(() => ui.calls.find((call) => call.method === 'POST')).toMatchObject({ path: '/api/settings/model-gateways',
      body: { name: 'Bedrock gateway', baseUrl: 'https://bedrock-gw.example.com', harnesses: ['claude'],
        models: ['claude-opus-5-5', 'claude-haiku-5-5'], priceMultiplier: 0.8, enabled: false, apiKey: 'secret' } });
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
