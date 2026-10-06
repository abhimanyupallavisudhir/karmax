import { afterAll, expect, it } from 'vitest';
import { MANIFESTS } from '../src/contrib/manifests.js';
import { closeConsoleBrowser, consolePage, emptySettings } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/**
 * Task defaults mirror the task form (wiki planned/collaboration-model): the
 * default Agent — whose collapsed Authorization row holds the authorization,
 * vault and payment defaults — then the Responder, the Review route, and where
 * tasks run, saved together without disturbing what the card does not own.
 */
for (const scope of ['project', 'global'] as const) {
  it(`lays out ${scope} task defaults like the task form and saves them together`, async () => {
    const inherited = { confirm: { layers: [{ kind: 'human', audience: ['@creator'] }] },
      responder: { kind: 'human', audience: ['@creator'] } };
    let common: Record<string, unknown> = { base: 'develop', target: 'main', remote: 'pr', gitProfile: 'personal',
      confirm: { layers: [{ kind: 'human', audience: ['@owners'] }] },
      responder: { kind: 'human', audience: ['@project'] } };
    const puts: Array<{ path: string; values: any }> = [];
    const settings = scope === 'project' ? '/api/settings/project/project' : '/api/organizations/org/settings';
    const ui = await consolePage({ api: (call) => {
      const path = call.path.split('?')[0]!;
      if (call.method === 'PUT') {
        puts.push({ path, values: call.body.values });
        if (path.endsWith('/__common__')) common = call.body.values;
        return { ok: true };
      }
      if (path.includes('/api/defaults/')) return { [scope]: { own: common, inherited },
        [scope === 'project' ? 'projectQuick' : 'globalQuick']: { own: {}, inherited: {} } };
      if (path.endsWith('/__common__')) return common;
      if (path === '/api/profiles') return [{ id: 'prof_do', role: 'do', name: 'Default agent', provider: 'claude', scope: 'inherited', inherited: {} }];
      if (path === `${settings}/vault`) return { credentialGrants: ['use-credential:item:gh'] };
      if (path.endsWith('/settings/vault')) return {};
      if (path.endsWith('/settings/authorization')) return {};
      if (path.endsWith('/settings/payments')) return { cardIds: [], budget: 0, currency: 'usd' };
      if (path === '/api/vault/items') return [{ id: 'gh', label: 'GitHub', type: 'login', policy: {} }];
      if (path === '/api/cards') return [];
      if (path.includes('explanation-settings')) return { own: {}, inherited: { endpoint: 'e', model: 'm', prompt: 'p' }, effective: { model: 'm' } };
      return emptySettings(call) ?? [];
    } });
    const { page } = ui;
    try {
      const projectId = scope === 'project' ? "'project'" : 'undefined';
      await ui.run(`(async () => {
        S.schema = ${JSON.stringify(MANIFESTS)};
        S.organizationId = 'org'; S.organizations = [{ id: 'org', name: 'Organization' }];
        S.projects = [{ id: 'project', name: 'Project', organizationId: 'org' }]; S.projectId = 'project';
        document.querySelector('#main').innerHTML = ${scope === 'project' ? 'settingsView(S.projects[0])' : 'organizationView()'};
        await hydrateSettingsForms('${scope}', ${projectId}, 'org');
        await hydrateProfiles('${scope}', ${projectId}, 'org');
        await hydrateReviewRoute('${scope}', ${projectId}, 'org');
        await hydrateQuickSettingsForms('${scope}', ${projectId}, 'org');
        wireTaskDefaultsSave('${scope}', ${projectId}, 'org');
      })()`);
      const card = page.locator(`#task-defaults-${scope}`);
      // Agent → Responder → Review route → where tasks run, then Quick tasks.
      expect(await card.locator('[data-profile], [data-row="responder"], [data-row="confirm"], [data-row="base"]').evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-profile') ? 'agent' : row.getAttribute('data-row')))).toEqual(['agent', 'responder', 'confirm', 'base']);
      expect(await page.locator('.task-defaults ~ [data-qwf]').count()).toBe(1);
      expect(await card.locator('[data-row="multiPr"]').count()).toBe(1);
      expect(await card.locator('[data-field="remote"]').count()).toBe(1);
      // The authorization, vault and payment defaults are the default Agent's.
      const authority = card.locator('[data-profile] .agent-authority');
      expect(await authority.evaluate((el) => (el as unknown as { open: boolean }).open)).toBe(false);
      expect(await authority.locator('[data-resource-defaults] .authz-editor, .resource-vault, .task-payments').count()).toBe(3);
      await expect.poll(() => authority.locator('.aa-summary').textContent()).toContain('1 credential');

      expect(await card.locator('.rf-audience').inputValue()).toBe('@project');
      await card.locator('.rf-audience').fill('@owners');
      // A Reviewer default with its own, narrower authority.
      await card.locator('.cf-add').click();
      const reviewer = card.locator('.cf-layer[data-kind="agent"] .agent-block');
      await reviewer.locator('.agent-authority > summary').click();
      await expect.poll(() => reviewer.locator('.authz-level-select').inputValue()).toBe('developer');
      await reviewer.locator('.authz-level-select').selectOption('viewer');
      // The default task authorization.
      await authority.locator('summary').click();
      await authority.locator('.authz-level-select').selectOption('maintainer');
      await card.locator('[data-save-task-defaults]').click();
      await expect.poll(() => puts.map((put) => put.path)).toEqual([`${settings}/authorization`, `${settings}/__common__`]);
      expect(puts[0]!.values).toEqual({ level: 'maintainer', scope: 'projects' });
      expect(common).toMatchObject({ base: 'develop', target: 'main', remote: 'pr', gitProfile: 'personal',
        responder: { kind: 'human', audience: ['@owners'] },
        confirm: { layers: [{ kind: 'agent', authority: { authorization: { level: 'viewer' }, credentialGrants: ['use-credential:item:gh'] } },
          { kind: 'human', audience: ['@owners'] }] } });
      // The untouched default Agent did not become an override.
      expect(puts.some((put) => put.path === '/api/profiles')).toBe(false);

      await card.locator('[data-reset="responder"]').click();
      expect(await card.locator('.rf-audience').inputValue()).toBe('@creator');
      await card.locator('[data-save-task-defaults]').click();
      await expect.poll(() => puts.length).toBe(3);
      expect(common).not.toHaveProperty('responder');
      await page.locator('.quick-defaults-enabled').check();
      expect(await page.locator('.quick-defaults-body').isVisible()).toBe(true);
      expect(ui.errors).toEqual([]);
    } finally { await ui.close(); }
  });
}
