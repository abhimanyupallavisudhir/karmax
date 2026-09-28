import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

type Console = Awaited<ReturnType<typeof consolePage>>;
const confirm = { name: 'confirm', role: 'confirm', type: 'confirmer', label: 'Review', scopes: ['task', 'project'] };
const responder = { name: 'responder', role: 'responder', type: 'responder', label: 'Responder', scopes: ['task', 'project'] };
const human = (who: string) => ({ kind: 'human', audience: [who] });

/**
 * The Review and Responder controls as a task form renders them: each set to
 * `user:bob` over an inherited `@creator`, with reset buttons wired. Every
 * `change` that bubbles out of the form (what draft autosave listens for) is
 * recorded in `window.changes`.
 */
async function form(): Promise<Console> {
  const ui = await consolePage();
  await ui.run(`const main = document.getElementById('main');
    main.innerHTML = renderField(${JSON.stringify(confirm)}, { layers: [${JSON.stringify(human('user:bob'))}] }, { layers: [${JSON.stringify(human('@creator'))}] })
      + renderField(${JSON.stringify(responder)}, ${JSON.stringify(human('user:bob'))}, ${JSON.stringify(human('@creator'))});
    wireAgentFields(main); wireFieldResets(main, [${JSON.stringify(confirm)}, ${JSON.stringify(responder)}]);
    window.changes = []; main.addEventListener('change', (event) => changes.push(event.target.className))`);
  return ui;
}
const changes = (ui: Console) => ui.run<string[]>('changes');
const read = (ui: Console) => ui.run<Record<string, unknown>>(`collectParamEdits(document.getElementById('main'),
  [${JSON.stringify(confirm)}, ${JSON.stringify(responder)}])`);

describe('review-route form behavior', () => {
  it('notifies autosave when the composite confirmer field is reset', async () => {
    const ui = await form();
    const reset = ui.page.locator('.field-reset[data-reset="confirm"]');
    expect(await reset.isVisible()).toBe(true);
    await reset.click();
    expect(await changes(ui)).toContain('confirmer-field');
    expect((await read(ui)).confirm).toEqual({ layers: [human('@creator')] });
    expect(await reset.isVisible()).toBe(false); // back to the inherited value
    await ui.close();
  });
});

describe('single-stage Responder form behavior', () => {
  let ui: Console;
  beforeAll(async () => { ui = await form(); });
  afterAll(async () => { await ui.close(); });

  it('uses the route renderer on task/default forms without Review layer controls', async () => {
    const box = ui.page.locator('.responder-field');
    expect(await box.locator('.rf-kind option').allTextContents()).toEqual(['Human responds', 'Agent responds']);
    expect(await box.locator('.cf-add, .cf-move, .cf-del').count()).toBe(0);
    // Choosing an agent shows the agent and its prompt in place of the audience.
    await box.locator('.rf-kind').selectOption('agent');
    expect([await box.locator('.rf-agent').isVisible(), await box.locator('.rf-human').isVisible()]).toEqual([true, false]);
    await box.locator('.rf-kind').selectOption('human');
    // The Responder is edited in the Agent card beside the Review route, not
    // among the common task defaults, though both are stored as shared values.
    expect(await ui.run(`S.schema = [{ name: 'software-dev', params: [${JSON.stringify(responder)},
      { name: 'prompt', type: 'text', scopes: ['task', 'project'] }] }];
      [agentRouteSettingsFields('project').map((field) => field.name), commonSettingsFields('project').map((field) => field.name)]`))
      .toEqual([['responder'], []]);
  });

  it('collects the composite Responder from the live parameters form', async () => {
    expect((await read(ui)).responder).toEqual(human('user:bob'));
    await ui.page.locator('.responder-field .rf-kind').selectOption('agent');
    expect((await read(ui)).responder).toMatchObject({ kind: 'agent' });
    await ui.page.locator('.responder-field .rf-kind').selectOption('human');
  });

  it('resets the composite Responder and notifies draft autosave', async () => {
    await ui.run('changes.length = 0');
    await ui.page.locator('.field-reset[data-reset="responder"]').click();
    expect(await changes(ui)).toContain('responder-field');
    expect((await read(ui)).responder).toEqual(human('@creator'));
  });
});
