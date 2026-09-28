import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

describe('fork-source task picker', () => {
  // Selection behavior is exercised by web/agent-picker.test.cjs, which
  // web-regressions.test.ts runs in CI. It covers delayed single-agent
  // selection, attempts, sub-tasks and stale responses; this checks what the
  // agent field opens and tells the user.
  it('describes the direct and multiple-agent selection paths', async () => {
    const ui = await consolePage();
    await ui.run(`S.projectId = 'p'; const main = document.getElementById('main');
      main.innerHTML = renderAgentField({ name: 'do', role: 'do' }, null, {}); wireAgentFields(main)`);
    const pick = ui.page.getByRole('button', { name: '⌕ Search tasks to fork from…' });
    expect(await pick.isVisible()).toBe(false);
    await ui.page.getByLabel('Fork a previous agent').check();
    await pick.click();
    const picker = ui.page.locator('#modal-root .picker');
    expect(await picker.locator('.fp-head').innerText()).toMatch(/^Fork a previous agent\n/);
    expect(await picker.locator('.pk-hint').innerText())
      .toBe('Archived tasks are included — click a task to fork its agent, or choose one when it has multiple agents.');
    await ui.close();
  });
});
