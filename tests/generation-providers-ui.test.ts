// Installation → Managed compute → Generation (wiki features/generate § Other
// providers): fal.ai and Unifically in one row each, a switch disabled until
// a key is saved, the risk of Unifically's Suno access in its tip.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { closeConsoleBrowser, consolePage, signedIn } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

const providers = [
  { id: 'fal', name: 'fal.ai', enabled: true, keyConfigured: true, costMicros: 3_100_000, chargedMicros: 6_200_000,
    tip: 'Music, sound effects, 3D, upscaling, lip-sync, background removal and more: about 1,500 models, priced per request.' },
  { id: 'unifically', name: 'Unifically', enabled: false, keyConfigured: false, costMicros: 0, chargedMicros: 0,
    tip: 'Suno and other models. Its Suno access appears to use Suno’s consumer app, which Suno’s terms forbid: you answer for that, and commercial rights to the songs are unclear.' },
];

describe('generation providers in Installation → Managed compute', () => {
  it('shows each provider in one row with its month, keeps one without a key off, and saves a key from its dialog', async () => {
    const ui = await consolePage({ path: '/org/workspace', api: signedIn((call) => {
      const route = call.path.split('?')[0];
      if (route === '/api/settings/managed-compute') return { providers: [] };
      if (route === '/api/settings/included-model') return { settings: { model: 'deepseek/deepseek-v4.1-flash-1017', effort: 'max', enabled: true,
        keyConfigured: true, organizations: 3, costMicros: 400_000, chargedMicros: 800_000 } };
      if (route === '/api/settings/model-gateways') return { gateways: [] };
      if (route?.startsWith('/api/settings/generation-providers')) return { providers };
      return undefined;
    }) });
    await ui.run('boot()');
    await ui.page.locator('#rail').first().waitFor({ state: 'attached' });
    await ui.run(`document.querySelector('#main').innerHTML = '<div class="main-inner" style="max-width:960px;padding:24px"><div class="card" id="managed-compute-card"></div></div>'; wireManagedComputeCard()`);
    const fal = ui.page.locator('.generation-provider[data-generation-provider="fal"]');
    const unifically = ui.page.locator('.generation-provider[data-generation-provider="unifically"]');
    await fal.waitFor();
    expect(await fal.innerText()).toMatch(/fal\.ai\s+ⓘ\s+\$3\.10 → \$6\.20/);
    expect(await fal.locator('.generation-provider-enabled').isChecked()).toBe(true);
    expect(await unifically.innerText()).toMatch(/Unifically\s+ⓘ\s+No key/);
    expect(await unifically.locator('.generation-provider-enabled').isDisabled()).toBe(true);
    expect(await unifically.locator('.info-dot').getAttribute('title')).toMatch(/Suno’s terms forbid/);
    if (process.env.KARMAX_SHOTS) {
      fs.mkdirSync(process.env.KARMAX_SHOTS, { recursive: true });
      await ui.page.locator('#managed-compute-card').screenshot({ path: `${process.env.KARMAX_SHOTS}/generation-providers-rows.png` });
    }
    await unifically.locator('.generation-provider-edit').click();
    const dialog = ui.page.locator('[aria-label="Unifically"]');
    await dialog.locator('.provider-key').fill('uni-secret');
    await dialog.locator('.provider-save').click();
    await expect.poll(() => ui.calls.find((call) => call.method === 'PUT')).toMatchObject({ path: '/api/settings/generation-providers/unifically',
      body: { enabled: false, apiKey: 'uni-secret' } });
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
