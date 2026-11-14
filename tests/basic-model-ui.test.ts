// The task form of an organization with no login of its own: its default agent
// is tavya's included model, and the form says so under the agent picker
// (wiki features/included-model § Default).
import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

const included = { provider: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017', effort: 'max' };
const schema = [{ name: 'software-dev', params: [
  { name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' },
  { name: 'agent:do', type: 'agent', label: 'Agent', scopes: ['task'], bind: 'profile', role: 'do' },
], stages: [{ key: 'do', label: 'Working' }] }];

async function taskForm(readiness: () => Record<string, unknown>) {
  const route = (call: { path: string }) => call.path.split('?')[0];
  const ui = await consolePage({ path: '/org/workspace', api: signedIn((call) => route(call) === '/api/schema' ? schema
    : route(call) === '/api/projects/p/readiness' ? readiness() : emptySettings(call)) });
  await ui.run('boot()');
  await ui.page.locator('#rail').first().waitFor({ state: 'attached' });
  await ui.run(`openTaskForm('software-dev')`);
  await ui.page.locator('#tf-page').waitFor();
  return ui;
}

describe('the task form on the included model', () => {
  it('says the default is a basic model and links to connecting logins, until the organization has one', async () => {
    const ui = await taskForm(() => ({ agents: [{ ...included, ready: true, cost: 1, included: true }], agentLogin: false, compute: { ready: true } }));
    const note = ui.page.locator('#tf-basic-model');
    await note.waitFor();
    expect(await note.innerText()).toBe('Default basic model. To use Claude or GPT, connect your logins.');
    expect(await note.locator('a').getAttribute('href')).toBe('/org/settings#settings-agents');
    // Nothing is missing: no "Can't start yet".
    expect(await ui.page.locator('#tf-ready').isHidden()).toBe(true);
    await ui.close();
    // With a login of its own, the model is a choice, not a stand-in: no note.
    const own = await taskForm(() => ({ agents: [{ ...included, ready: true, cost: 1, included: true }], agentLogin: true, compute: { ready: true } }));
    await expect.poll(() => own.calls.some((call) => call.path.startsWith('/api/projects/p/readiness'))).toBe(true);
    await own.page.waitForTimeout(100);
    expect(await own.page.locator('#tf-basic-model').isHidden()).toBe(true);
    await own.close();
  });

  it('says nothing for an agent that is not the included model', async () => {
    const ui = await taskForm(() => ({ agents: [{ provider: 'claude', model: 'claude-opus-5-5', ready: true }], agentLogin: true, compute: { ready: true } }));
    await expect.poll(() => ui.calls.some((call) => call.path.startsWith('/api/projects/p/readiness'))).toBe(true);
    await ui.page.waitForTimeout(100);
    expect(await ui.page.locator('#tf-basic-model').isHidden()).toBe(true);
    await ui.close();
  });
});
