import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';
import { MANIFESTS } from '../src/contrib/manifests.js';

afterAll(closeConsoleBrowser);

/**
 * A task on a fork waits after Review for its person to open the pull request
 * on the upstream (wiki features/fork-contributions). The ask is two links: the
 * prefilled GitHub page, and where to save a token to skip it next time.
 */
const compare = 'https://github.com/acme/widgets/compare/main...octo:widgets:tavya/fixture?quick_pull=1&title=Fix';
const record = { id: 'fixture', projectId: 'p1', workflow: 'software-dev', workflowVersion: '1.28.0', title: 'Fix', params: { prompt: 'Fix' } };
const view = {
  taskId: 'fixture', title: 'Fix', workflow: 'software-dev', stage: 'merge', status: 'waiting', agents: {}, updatedAt: 1710000000000,
  messages: [{ id: 'm1', role: 'user', text: 'Fix', ts: 1 }], prs: [],
  actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm PR', enabled: true }, { name: 'followUp', kind: 'signal', label: 'Send follow-up', roles: ['do'], enabled: true }],
  waitingFor: { kind: 'human', audience: ['@creator'], reason: 'merge', summary: 'Open the pull request on GitHub',
    detail: `[Open the pull request on acme/widgets](${compare})\n\nTo skip this step next time, [save a GitHub token](/profile#github-token).` },
};

it('shows the upstream pull-request ask as working links, on the overview and in the conversation', async () => {
  const ui = await consolePage({ api: (call) => {
    const path = call.path.split('?')[0]!;
    if (path === '/api/tasks/fixture') return view;
    if (path === '/api/tasks/fixture/attempts') return null;
    if (path.endsWith('/tasks')) return [record];
    if (path.includes('explanation-settings')) return { effective: { enabled: false } };
    return [];
  } });
  try {
    await ui.run(`(async () => {
      S.schema = ${JSON.stringify(MANIFESTS)};
      S.tasks = [${JSON.stringify(record)}];
      S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'org', name: 'Org' }];
      S.meta = { workflows: [] };
      await openTask('fixture', 'overview');
    })()`);
    const open = ui.page.locator('a', { hasText: 'Open the pull request on acme/widgets' }).first();
    await open.waitFor();
    expect(await open.getAttribute('href')).toBe(compare);
    expect(await open.getAttribute('target')).toBe('_blank');
    const token = ui.page.locator('a', { hasText: 'save a GitHub token' }).first();
    expect(await token.getAttribute('href')).toBe('/profile#github-token');
    expect(await ui.page.locator('body').innerText()).not.toContain('](');
    // Confirm here means "it is open now, look again", not a merge authorization.
    expect(await ui.page.locator('.actions').innerText()).toContain('I opened it');
    expect(await ui.page.locator('.actions').innerText()).not.toContain('Authorize GitHub merge');
    await ui.page.setViewportSize({ width: 1100, height: 700 });
    if (process.env.KARMAX_SHOT) await ui.page.screenshot({ path: process.env.KARMAX_SHOT });
  } finally {
    await ui.close();
  }
});
