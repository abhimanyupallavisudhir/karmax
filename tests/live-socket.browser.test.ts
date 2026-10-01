import { afterAll, expect, it } from 'vitest';
import type { WebSocketRoute } from 'playwright';
import { closeConsoleBrowser, consolePage, signedIn } from './helpers/console-page.js';

/**
 * A socket that dies without a close (the laptop slept, the network changed)
 * used to look open forever: no event arrived, no reconnect happened, and the
 * task list kept saying "working" for a task that had long been waiting for
 * input, until the page was reloaded.
 */
afterAll(closeConsoleBrowser);

function fixture(options: { answerFirstSocket: boolean }) {
  const sockets: Array<{ route: WebSocketRoute; received: string[] }> = [];
  let status: 'active' | 'waiting' = 'active';
  const task = () => ({ id: 't1', num: 1, projectId: 'p', title: 'Ship the fix', workflow: 'software-dev',
    lastView: status === 'active' ? { stage: 'do', status: 'active' }
      : { stage: 'do', status: 'waiting', waitingFor: { kind: 'human' } } });
  return {
    sockets,
    setWaiting: () => { status = 'waiting'; },
    webSocket: (route: WebSocketRoute) => {
      const socket = { route, received: [] as string[] };
      const answers = sockets.push(socket) > 1 || options.answerFirstSocket;
      route.onMessage((message) => {
        socket.received.push(String(message));
        if (answers && JSON.parse(String(message)).type === 'ping') route.send('{"type":"pong"}');
      });
    },
    api: signedIn(({ method, path }) => {
      if (method !== 'GET') return undefined;
      if (path.startsWith('/api/projects/p/tasks?')) return { tasks: [task()], total: 1 };
      if (path.startsWith('/api/projects/p/search?')) return { tasks: [task()] };
      return undefined;
    }),
  };
}

async function openList(options: { answerFirstSocket: boolean }) {
  const f = fixture(options);
  const ui = await consolePage({ api: f.api, webSocket: f.webSocket, clock: true });
  await ui.run(`(async () => {
    S.projects = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }];
    S.projectId = 'p'; S.tab = 'tasks'; S.selected = null;
    await loadTasks(); await runSearch(); renderMain();
    connectWs(); watchWsLiveness();
  })()`);
  await expect.poll(() => f.sockets.length).toBe(1);
  await expect.poll(() => ui.page.locator('#main').textContent()).toContain('working');
  return { ui, ...f };
}

it('notices a socket that went silent, reconnects and shows the task as it is now', async () => {
  const { ui, sockets, setWaiting } = await openList({ answerFirstSocket: false });
  try {
    setWaiting(); // the event saying so is lost with the dead socket
    await ui.page.clock.runFor(45_000);
    expect(sockets[0]!.received.map((m) => JSON.parse(m).type)).toContain('ping');
    await expect.poll(() => sockets.length).toBe(2);
    await expect.poll(() => ui.page.locator('#main').textContent()).toContain('Needs input');
    expect(ui.errors).toEqual([]);
  } finally { await ui.close(); }
});

it('keeps a socket that answers, however long it stays quiet', async () => {
  const { ui, sockets } = await openList({ answerFirstSocket: true });
  try {
    await ui.page.clock.runFor(10 * 60_000);
    expect(sockets[0]!.received.filter((m) => JSON.parse(m).type === 'ping').length).toBeGreaterThan(5);
    expect(sockets.length).toBe(1);
    expect(ui.errors).toEqual([]);
  } finally { await ui.close(); }
});

it('reconnects at once when the browser comes back online', async () => {
  const { ui, sockets, setWaiting } = await openList({ answerFirstSocket: true });
  try {
    setWaiting();
    await ui.run("window.dispatchEvent(new Event('online'))");
    await expect.poll(() => sockets.length).toBe(2);
    await expect.poll(() => ui.page.locator('#main').textContent()).toContain('Needs input');
  } finally { await ui.close(); }
});
