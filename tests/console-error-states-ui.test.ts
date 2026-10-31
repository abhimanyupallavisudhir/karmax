import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

describe('the console tells a person what went wrong, in words', () => {
  it('gives a sign-in refusal its real reason, not always "wrong password"', async () => {
    const ui = await consolePage();
    const refusal = (status: number, body: object = {}) =>
      ui.run<string>(`signInRefusal(new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status} }))`);
    expect(await refusal(401, { error: 'invalid email or password' })).toBe('Invalid email or password');
    expect(await refusal(429, { error: 'too many failed sign-in attempts; try again in a few minutes' }))
      .toBe('Too many attempts. Wait a few minutes, then try again.');
    expect(await refusal(403, { message: 'Email not verified' })).toBe('Email not verified.');
    expect(await refusal(502)).toBe('tavya is busy or restarting. Try again in a moment.');
    await ui.close();
  });

  it('tells of a failed request nothing else caught, and nothing else', async () => {
    const ui = await consolePage();
    const said = (reason: string) => ui.run<string>(`unhandledRequestFailure(${reason})`);
    expect(await said(`Object.assign(new Error('denied: task:create'), { status: 403 })`)).toBe('denied: task:create');
    expect(await said(`new TypeError('Failed to fetch')`)).toBe('Failed to fetch');
    expect(await said(`new Error('unauthorized')`)).toBe(''); // the sign-in page says it
    expect(await said(`new TypeError('x is undefined')`)).toBe(''); // a bug, for the log
    // An uncaught rejection from a click handler reaches the toast region.
    await ui.run(`void Promise.reject(Object.assign(new Error('HTTP 503'), { status: 503 }))`);
    await expect.poll(() => ui.page.locator('#toasts .toast.err span').first().innerText()).toBe('tavya is busy or restarting. Try again in a moment.');
    await ui.close();
  });

  it('says a task that does not exist does not, instead of "not started yet"', async () => {
    const ui = await consolePage();
    await ui.run(`renderTaskLoadingPage(undefined, null, true)`);
    expect(await ui.page.locator('#main .task-load-error').innerText()).toContain('No such task');
    expect(await ui.page.locator('#task-load-retry').count()).toBe(0);
    await ui.run(`renderTaskLoadingPage({ id: 't', title: 'Known' }, null, true)`);
    expect(await ui.page.locator('#main .task-load-error').innerText()).toContain('Not started yet');
    await ui.run(`renderTaskLoadingPage({ id: 't', title: 'Known' }, 'Failed to fetch')`);
    expect(await ui.page.locator('#main .task-load-error span').innerText()).toBe('Can’t reach tavya. Check your internet connection and try again.');
    await ui.close();
  });

  it('asks for a project before a task, instead of a form that cannot be saved', async () => {
    const ui = await consolePage();
    await ui.run(`S.tab = 'home'; S.organizationId = 'o'; S.projects = []; S.projectId = null; openNewTaskForm()`);
    const toast = ui.page.locator('#toasts .toast');
    expect(await toast.locator('span').innerText()).toBe('Create a project first');
    expect(await toast.locator('.toast-action').innerText()).toBe('New project');
    expect(await ui.page.locator('#tf-page').count()).toBe(0);
    await ui.close();
  });

  it('offers to try again when the console cannot load', async () => {
    let up = false;
    const ui = await consolePage({ api: () => up ? undefined : { status: 503, json: { error: 'runtime is not ready' } } });
    await ui.run(`bootFailed(Object.assign(new Error('runtime is not ready'), { status: 503 }))`);
    const failed = ui.page.locator('#app .boot-failed');
    expect(await failed.innerText()).toContain('tavya is busy or restarting. Try again in a moment.');
    up = true;
    await ui.page.locator('#boot-retry').click();
    await expect.poll(() => ui.calls.some((call) => call.path.startsWith('/api/'))).toBe(true);
    await ui.close();
  });
});
