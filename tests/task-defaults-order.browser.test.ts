import fs from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { MANIFESTS } from '../src/contrib/manifests.js';

for (const scope of ['project', 'global']) {
  it(`orders ${scope} task defaults and saves the agent routes without losing branch defaults`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const inherited = { confirm: { layers: [{ kind: 'human', audience: ['@creator'] }] },
        responder: { kind: 'human', audience: ['@creator'] } };
      let common = { base: 'develop', target: 'main', remote: 'pr', gitProfile: 'personal',
        confirm: { layers: [{ kind: 'human', audience: ['@owners'] }] },
        responder: { kind: 'human', audience: ['@project'] } };
      let saves = 0;
      await page.route('http://defaults.test/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname.includes('/api/defaults/')) return route.fulfill({ json: {
          [scope]: { own: common, inherited },
          [scope === 'project' ? 'projectQuick' : 'globalQuick']: { own: {}, inherited: {} },
        } });
        if (url.pathname.endsWith('/__common__')) {
          if (route.request().method() === 'PUT') { common = route.request().postDataJSON().values; saves++; }
          return route.fulfill({ json: common });
        }
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
        return route.fulfill({ contentType: 'text/html', body: '<main id="main"></main>' });
      });
      await page.goto('http://defaults.test/');
      await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '') });
      await page.evaluate(({ scope, schema }) => (globalThis as any).eval(`(async () => {
        S.schema = ${JSON.stringify(schema)};
        S.organizationId = 'org';
        S.organizations = [{ id: 'org', name: 'Organization' }];
        S.projects = [{ id: 'project', name: 'Project', organizationId: 'org' }];
        S.projectId = 'project';
        document.querySelector('#main').innerHTML = ${scope === 'project' ? "settingsView(S.projects[0])" : 'globalSettingsView(true)'};
        await hydrateSettingsForms('${scope}', ${scope === 'project' ? "'project'" : 'undefined'}, 'org');
        await hydrateReviewRoute('${scope}', ${scope === 'project' ? "'project'" : 'undefined'}, 'org');
        await hydrateQuickSettingsForms('${scope}', ${scope === 'project' ? "'project'" : 'undefined'}, 'org');
      })()`), { scope, schema: MANIFESTS });

      const order = await page.locator('[data-wf="__common__"], .agent-profile-settings, [data-qwf], .resource-defaults, .explanation-settings, details[data-wf], #project-conversation-sharing').evaluateAll(elements =>
        elements.map(el => el.matches('[data-wf="__common__"]') ? 'branches'
          : el.matches('.agent-profile-settings') ? 'agent'
          : el.matches('[data-qwf]') ? 'quick'
          : el.matches('.resource-defaults') ? 'resources'
          : el.matches('.explanation-settings') ? 'explanation'
          : el.matches('details') ? 'workflow' : 'sharing'));
      expect(order).toEqual(['branches', 'agent', 'quick', 'resources', 'explanation', 'workflow', ...(scope === 'project' ? ['sharing'] : [])]);
      const branch = page.locator('[data-wf="__common__"]');
      expect(await branch.locator('[data-field="remote"]').count()).toBe(1);
      expect(await branch.locator('[data-field="landingAuthority"]').count()).toBe(1);
      expect(await branch.locator('[data-row="responder"]').count()).toBe(0);
      const agent = page.locator('.agent-profile-settings');
      expect(await agent.locator('[data-row="confirm"]').count()).toBe(1);
      expect(await agent.locator('[data-row="responder"]').count()).toBe(1);
      expect(await agent.locator('.rf-audience').inputValue()).toBe('@project');
      await agent.locator('.rf-audience').fill('@owners');
      await agent.locator('[data-save-review-route]').click();
      await expect.poll(() => saves).toBe(1);
      expect(common).toMatchObject({ base: 'develop', target: 'main', remote: 'pr', gitProfile: 'personal',
        confirm: { layers: [{ kind: 'human', audience: ['@owners'] }] },
        responder: { kind: 'human', audience: ['@owners'] } });
      await page.evaluate(scope => (globalThis as any).eval(`hydrateReviewRoute('${scope}', ${scope === 'project' ? "'project'" : 'undefined'}, 'org')`), scope);
      expect(await agent.locator('.rf-audience').inputValue()).toBe('@owners');
      await agent.locator('[data-reset="responder"]').click();
      expect(await agent.locator('.rf-audience').inputValue()).toBe('@creator');
      await agent.locator('[data-save-review-route]').click();
      await expect.poll(() => saves).toBe(2);
      expect(common).not.toHaveProperty('responder');
      expect(common).toMatchObject({ base: 'develop', gitProfile: 'personal',
        confirm: { layers: [{ kind: 'human', audience: ['@owners'] }] } });
      await page.locator('.quick-defaults-enabled').check();
      expect(await page.locator('.quick-defaults-body').isVisible()).toBe(true);
      await page.locator('.quick-defaults-enabled').uncheck();
      expect(await page.locator('.quick-defaults-body').isVisible()).toBe(false);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
}
