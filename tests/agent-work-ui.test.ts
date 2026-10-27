import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/**
 * The Queues page's Agent work (wiki features/quota-scheduling): running work,
 * then waiting work in the order it gets model quota, held work below a
 * divider; dragging a task between two others records that order, and its pin
 * returns it to the scheduler's own order.
 */
const row = (taskId: string, num: number, extra: Record<string, unknown> = {}) =>
  ({ taskId, root: taskId, projectId: 'p1', num, title: `Task ${num}`, priority: 'medium', ...extra });
const queue = {
  organizationId: 'org',
  running: [{ ...row('run', 1), turnId: 'r1', accountId: 'login:org:claude:a' }],
  waiting: [
    { ...row('next', 2, { priority: 'high' }), turnId: 'w1', status: 'next' },
    { ...row('sub', 5, { root: 'next', rootNum: 2, rootTitle: 'Task 2' }), turnId: 'w2', status: 'next' },
    { ...row('held', 3, { priority: 'low' }), turnId: 'w3', status: 'held', until: Date.UTC(2030, 0, 1, 14, 20) },
    { ...row('pinned', 4), turnId: 'w4', status: 'quota', until: Date.UTC(2030, 0, 1, 18, 50),
      pins: [{ above: 'held', below: 'pinned', by: 'user:1' }] },
  ],
};

describe('Agent work on the Queues page', () => {
  it('shows running work, then waiting trees in quota order with their sub-tasks, and a divider where holding back starts', async () => {
    const ui = await consolePage();
    const view = await ui.run<{ trees: string[]; subs: string[]; divider: number; status: string[]; pins: number }>(`
      S.agentWork = ${JSON.stringify(queue)};
      $('#main').innerHTML = agentWorkPanel();
      const rows = [...$('#main').querySelectorAll('.work-tree')];
      ({ trees: rows.map((r) => r.dataset.root),
         subs: [...$('#main').querySelectorAll('.work-sub')].map((r) => r.dataset.task),
         divider: [...$('#main').querySelector('.work-list').children].findIndex((e) => e.classList.contains('work-divider')),
         status: rows.map((r) => r.querySelector('.task-sub').textContent.trim()),
         pins: $('#main').querySelectorAll('[data-unpin]').length })
    `);
    expect(view.trees).toEqual(['run', 'next', 'held', 'pinned']);
    expect(view.subs).toEqual(['sub']);
    // Running, the waiting tree that starts next, then the divider, then held and out-of-quota work.
    expect(view.divider).toBe(2);
    expect(view.status[0]).toBe('Running');
    expect(view.status[1]).toBe('Next');
    expect(view.status[2]).toMatch(/^Held until /);
    expect(view.status[3]).toMatch(/^Quota resets /);
    expect(view.pins).toBe(1);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('records a drop between two trees, and returns a pinned task to automatic order', async () => {
    const ui = await consolePage({ api: () => ({ ok: true }) });
    await ui.run(`
      S.agentWork = ${JSON.stringify(queue)};
      $('#main').innerHTML = '<div class="work-host">' + agentWorkPanel() + '</div>';
      wireAgentWork($('#main').querySelector('.work-list'));
    `);
    // Drag "pinned" (#4) up between "next" (#2) and "held" (#3).
    await ui.page.locator('.work-tree[data-root="pinned"]').dragTo(ui.page.locator('.work-tree[data-root="held"]'), { targetPosition: { x: 20, y: 4 } });
    await expect.poll(() => ui.calls.find((c) => c.method === 'POST' && c.path.startsWith('/api/scheduling/order'))?.body)
      .toEqual({ taskId: 'pinned', above: 'next', below: 'held' });
    await ui.page.locator('[data-unpin="pinned"]').click();
    await expect.poll(() => ui.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/api/scheduling/order/pinned'))).toBe(true);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('explains a held task\'s wait on its own page', async () => {
    const ui = await consolePage();
    const text = await ui.run<string>(`waitingText({ kind: 'account', detail: 'Held for higher-priority work', until: Date.UTC(2030, 0, 1, 14, 20) })`);
    expect(text).toMatch(/^Held for higher-priority work until /);
    await ui.close();
  });
});
