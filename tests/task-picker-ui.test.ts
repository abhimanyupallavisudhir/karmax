import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, signedIn } from './helpers/console-page.js';

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

// UI-42: tag chips route to their list section everywhere, but a picker row is
// one choice — clicking it anywhere, chips included, picks that task. And tag
// navigation never removes dialogs behind their own close handlers.
describe('tag chips in the task picker', () => {
  const tag = { id: 'tag_ui', name: 'frontend', kind: 'topic', projectId: 'p' };
  const task = { id: 'task_7', num: 7, projectId: 'p', title: 'Polish the picker', workflow: 'software-dev', tags: [tag.id],
    params: {}, lastView: { status: 'active' } };

  async function picker() {
    const ui = await consolePage({ path: '/org/workspace', api: signedIn(({ method, path }) => {
      const pathname = path.split('?')[0];
      if (method === 'GET' && pathname === '/api/projects/p/tags') return [tag];
      if (method === 'GET' && pathname === '/api/projects/p/search') return { tasks: [task] };
      return undefined;
    }) });
    await ui.run('boot()');
    await ui.page.locator('#main .task-row').first().waitFor();
    // Another dialog already open beneath the picker, with its own close handler.
    await ui.run(`window.closedBeneath = 0; const beneath = document.createElement('div'); beneath.id = 'beneath';
      beneath.innerHTML = '<div role="dialog">Beneath</div>'; document.getElementById('modal-root').appendChild(beneath);
      window.picked = []; openTaskPicker({ title: 'Pick a task', onPick: (t) => window.picked.push(t.id) })`);
    return ui;
  }

  it('picks the task when its chip is clicked, leaving other dialogs and the page alone', async () => {
    const ui = await picker();
    const before = ui.page.url();
    await ui.page.locator('#modal-root .picker .pick-row .tag-chip').click();
    await expect.poll(() => ui.run('window.picked')).toEqual(['task_7']);
    expect(await ui.page.locator('#modal-root .picker').count()).toBe(0);
    expect(await ui.page.locator('#modal-root #beneath').count()).toBe(1);
    expect(ui.page.url()).toBe(before);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('navigates to a tag section without removing open dialogs', async () => {
    const ui = await picker();
    await ui.run(`navigateToTagSection('tag_ui')`);
    await expect.poll(() => new URL(ui.page.url()).searchParams.get('q')).toBe('group:tag-topic');
    expect(await ui.page.locator('#modal-root #beneath').count()).toBe(1);
    expect(await ui.page.locator('#modal-root .picker').count()).toBe(1);
    await ui.close();
  });

  it('closes the tags manager through its own close when a chip there navigates', async () => {
    const ui = await picker();
    await ui.page.keyboard.press('Escape');
    await ui.run(`document.getElementById('beneath').remove(); openTagsManager()`);
    await ui.page.locator('#modal-root .tagm-row .tag-chip').click();
    await expect.poll(() => new URL(ui.page.url()).searchParams.get('q')).toBe('group:tag-topic');
    expect(await ui.page.locator('#modal-root').innerHTML()).toBe('');
    await ui.close();
  });
});

// Forking is not confined to the open project: the agent picker searches the
// organization, starting at `project:<this project>`; clearing that token
// reaches every project, whose rows say where they are.
describe('fork picker across projects', () => {
  it('starts at this project and widens to the organization', async () => {
    const queries: string[] = [];
    const projects = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }, { id: 'q', organizationId: 'o', name: 'Website', config: {} }];
    const ui = await consolePage({ path: '/org/workspace', api: signedIn(({ method, path }) => {
      const pathname = path.split('?')[0];
      if (method === 'GET' && pathname === '/api/organizations/o/search') {
        const q = new URL(`http://x${path}`).searchParams.get('q') || '';
        queries.push(q);
        return { tasks: [
          { id: 'task_p', num: 1, projectId: 'p', title: 'Here', workflow: 'software-dev', params: {}, lastView: { status: 'done' } },
          ...(q.includes('project:workspace') ? [] : [{ id: 'task_q', num: 2, projectId: 'q', title: 'Elsewhere', workflow: 'software-dev', params: {}, lastView: { status: 'done' } }]),
        ] };
      }
      return undefined;
    }, { projects }) });
    await ui.run('boot()');
    await ui.page.locator('#main').waitFor();
    await ui.run(`openTaskPicker({ title: 'Fork a previous agent', mode: 'agent', defaults: ['run'], onPick: () => {} })`);
    const search = ui.page.locator('#pk-search');
    await expect.poll(() => search.inputValue()).toBe('project:workspace');
    await ui.page.locator('#pk-list .pick-row').filter({ hasText: 'Here' }).waitFor();
    expect(queries[0]).toContain('project:workspace');
    await search.fill('');
    const elsewhere = ui.page.locator('#pk-list .pick-row').filter({ hasText: 'Elsewhere' });
    await elsewhere.waitFor();
    expect(await elsewhere.locator('.task-project').innerText()).toBe('website');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
