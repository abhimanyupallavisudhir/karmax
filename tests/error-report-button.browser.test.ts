import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/**
 * Reporting an error from the console (wiki features/error-reports): one click
 * on an error tavya showed. A task's error is named by its task (the server
 * reads the text); a failed request is reported from its toast.
 */
describe('reporting an error the console showed', () => {
  const error = 'infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake → Timed out while waiting for handshake (still failing after 5 waits)';
  const stopped = (meta: Record<string, unknown>) => `S.meta = ${JSON.stringify(meta)};
    document.getElementById('main').innerHTML = '<div class="conversation" style="max-width:760px;margin:24px">'
      + conversationError({ taskId: 'task_137', projectId: 'p', error: ${JSON.stringify(error)} }) + '</div>'`;

  it('reports a stopped task\'s error in one click, once', async () => {
    const ui = await consolePage({ api: ({ method, path: route }: ApiCall) => method === 'POST' && route === '/api/error-reports' ? { reported: true } : undefined });
    await ui.run(stopped({ errorReports: true }));
    const report = ui.page.locator('#main button.report-error');
    expect(await report.innerText()).toBe('Report');
    expect(await report.getAttribute('title')).toBe('Tell tavya this should not have happened');
    if (process.env.ERROR_REPORT_SCREENSHOT) {
      fs.mkdirSync(path.dirname(process.env.ERROR_REPORT_SCREENSHOT), { recursive: true });
      await ui.page.locator('#main .conversation').screenshot({ path: process.env.ERROR_REPORT_SCREENSHOT });
    }
    await report.click();
    await expect.poll(() => report.innerText()).toBe('Reported ✓');
    expect(await report.isDisabled()).toBe(true);
    // The task says which error: the text is the server's, not the page's.
    expect(ui.calls.filter((call) => call.path === '/api/error-reports')).toEqual([{ method: 'POST', path: '/api/error-reports', body: { taskId: 'task_137' } }]);
    await report.click({ force: true });
    expect(ui.calls.filter((call) => call.path === '/api/error-reports')).toHaveLength(1);
    await ui.close();
  });

  it('offers nothing where reports go nowhere, or where a setting is the fix', async () => {
    const ui = await consolePage();
    await ui.run(stopped({}));
    expect(await ui.page.locator('#main button.report-error').count()).toBe(0);
    await ui.run(`S.meta = { errorReports: true }; S.organizations = [{ id: 'o', name: 'Org', slug: 'org' }]; S.organizationId = 'o';
      document.getElementById('main').innerHTML = conversationError({ taskId: 't', error: 'No computer is connected: connect one under Settings → Computers.' })`);
    expect(await ui.page.locator('#main a.setup-fix').count()).toBe(1);
    expect(await ui.page.locator('#main button.report-error').count()).toBe(0);
    await ui.close();
  });

  it('reports a request that failed on tavya\'s side from its toast, not a refusal', async () => {
    const ui = await consolePage({ path: '/org/web/tasks/137', api: ({ method, path: route }: ApiCall) =>
      method === 'POST' && route === '/api/error-reports' ? { reported: true } : undefined });
    await ui.run(`S.meta = { errorReports: true }; toast(Object.assign(new Error('HTTP 502'), { status: 502 }), true)`);
    const action = ui.page.locator('#toasts .toast-action', { hasText: 'Report' });
    await action.click();
    await expect.poll(() => ui.calls.filter((call) => call.path === '/api/error-reports')).toEqual([
      { method: 'POST', path: '/api/error-reports', body: { message: 'HTTP 502', where: '/org/web/tasks/:n' } }]);
    // A refusal is the person's to act on: no Report.
    await ui.run(`document.getElementById('toasts').innerHTML = ''; toast(Object.assign(new Error('a task needs a title'), { status: 400 }), true)`);
    expect(await ui.page.locator('#toasts .toast').count()).toBe(1);
    expect(await ui.page.locator('#toasts .toast-action').count()).toBe(0);
    await ui.close();
  });
});
