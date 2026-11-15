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
    document.body.insertAdjacentHTML('beforeend', '<span class="ws-offline hidden" id="ws-offline" role="status">Reconnecting</span>');
    await loadTasks(); await runSearch(); renderMain();
    connectWs(); watchWsLiveness();
  })()`);
  await expect.poll(() => f.sockets.length).toBe(1);
  await expect.poll(() => ui.page.locator('#main').textContent()).toContain('Working');
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
    // Step the fake clock one liveness tick at a time and let each pong (a
    // real socket message) land: a single long jump would outrun every answer.
    for (let tick = 0; tick < 120; tick++) {
      await ui.page.clock.runFor(5_000);
      await expect.poll(() => ui.run('wsPingSentAt')).toBe(0);
    }
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

/**
 * A tab the browser froze in the background, or a laptop that slept, stops
 * answering the gateway's pings, and the gateway drops its socket. The console
 * then said "Reconnecting — live updates paused" for at least the 1.5 s before
 * its first retry, every time someone came back to the tab, although the next
 * connection worked at once and the page re-read what it had missed.
 */
it('a dropped socket comes straight back without saying live updates paused', async () => {
  const { ui, sockets, setWaiting } = await openList({ answerFirstSocket: true });
  try {
    setWaiting();
    await sockets[0]!.route.close({ code: 1001 });
    await ui.page.clock.runFor(100);
    await expect.poll(() => sockets.length).toBe(2);
    await expect.poll(() => ui.page.locator('#main').textContent()).toContain('Needs input');
    await ui.page.clock.runFor(10_000);
    expect(await ui.page.locator('#ws-offline').isVisible()).toBe(false);
    expect(ui.errors).toEqual([]);
  } finally { await ui.close(); }
});

it('says live updates are paused only while the gateway stays away', async () => {
  const { ui, sockets } = await openList({ answerFirstSocket: true });
  try {
    // The gateway is down (a deploy): every new connection fails.
    await ui.run(`window.gatewayDown = true; const Native = WebSocket;
      window.WebSocket = class extends Native {
        constructor(url) { super(window.gatewayDown ? 'ws://127.0.0.1:9/down' : url); }
      }`);
    await sockets[0]!.route.close({ code: 1001 });
    await ui.page.clock.runFor(1_000);
    expect(await ui.page.locator('#ws-offline').isVisible()).toBe(false);
    await expect.poll(async () => { await ui.page.clock.runFor(1_000); return ui.page.locator('#ws-offline').isVisible(); }).toBe(true);
    // Back up: the next retry connects and the notice goes.
    await ui.run('window.gatewayDown = false');
    await expect.poll(async () => { await ui.page.clock.runFor(1_000); return sockets.length; }).toBe(2);
    await expect.poll(() => ui.page.locator('#ws-offline').isVisible()).toBe(false);
  } finally { await ui.close(); }
});

/**
 * A hidden tab used to drop every event, the ones that ask for its person
 * included: the count in the tab's title, the notification and its sound came
 * only once they looked at the tab again — when none of them was needed.
 */
it('a background tab still counts and announces what asks for its person', async () => {
  const sockets: WebSocketRoute[] = [];
  let inbox: unknown[] = [];
  const ui = await consolePage({ webSocket: (route) => { sockets.push(route); route.onMessage(() => {}); },
    api: signedIn(({ method, path }) => (method === 'GET' && path.startsWith('/api/inbox?') ? inbox : undefined)) });
  try {
    await ui.run(`(async () => {
      window.announced = [];
      window.Notification = class { static permission = 'granted'; constructor(title, options) { window.announced.push(title + ' — ' + options.body); } close() {} };
      S.organizations = [{ id: 'o', name: 'Organization', slug: 'org' }];
      S.projects = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }];
      S.organizationId = 'o'; S.projectId = 'p'; S.tab = 'tasks'; S.selected = null;
      await loadInbox();
      connectWs();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await expect.poll(() => sockets.length).toBe(1);
    const before = ui.calls.length;
    inbox = [{ id: 'i1', organizationId: 'o', taskId: 't1', kind: 'escalated', urgency: 'high', unread: true, actionable: true,
      task: { id: 't1', num: 7, title: 'Pick the launch date', projectId: 'p' } }];
    // Work the hidden page does not show changes nothing; an ask is fetched and announced.
    sockets[0]!.send(JSON.stringify({ type: 'agent.activity', taskId: 't1', projectId: 'p', payload: {} }));
    sockets[0]!.send(JSON.stringify({ type: 'task.escalated', taskId: 't1', projectId: 'p', payload: {} }));
    await expect.poll(() => ui.page.title()).toMatch(/^\(1\) /);
    expect(await ui.run('window.announced')).toEqual(['Pick the launch date — HIGH · #7 · escalated']);
    // Only the inbox was read: the list and the sidebar wait until someone looks.
    expect(ui.calls.slice(before).map((call) => call.path.split('?')[0])).toEqual(['/api/inbox']);
    expect(await ui.run('S.liveUpdatesStale')).toBe(true);
    expect(ui.errors).toEqual([]);
  } finally { await ui.close(); }
});
