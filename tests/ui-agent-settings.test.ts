import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

describe('agent settings UI', () => {
  it('does not offer the hermetic mock adapter as an agent provider', async () => {
    const ui = await consolePage();
    await ui.run(`document.getElementById('main').innerHTML = renderAgentField({ name: 'agent:do', role: 'do' }, null, {})`);
    const providers = await ui.page.locator('.af-provider option').allTextContents();
    expect(providers).toEqual(expect.arrayContaining(['claude', 'codex']));
    expect(providers).not.toContain('mock');
    await ui.close();
  });

  // The schema side (one `agent:do` field, no `agent:merge`) is in forms.test.ts.
  it('has no separate Do/Merge agent editor', async () => {
    const schema = [{ name: 'software-dev', params: [
      { name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' },
      { name: 'agent:do', type: 'agent', role: 'do', label: 'Agent', scopes: ['task'] },
    ], stages: [{ key: 'do', label: 'Working' }] }];
    const ui = await consolePage({ api: ({ path }) => path.endsWith('/defaults') ? { effective: {}, inherited: {} } : undefined });
    await ui.run(`S.schema = ${JSON.stringify(schema)}; S.projects = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }];
      S.projectId = 'p'; openTaskForm('software-dev')`);
    await ui.page.locator('#tf-page .agent-field').first().waitFor();
    expect(await ui.page.locator('#tf-page .agent-field').count()).toBe(1);
    expect(await ui.page.locator('#tf-page').textContent()).not.toMatch(/separate/i);
    await ui.close();
  });
});
