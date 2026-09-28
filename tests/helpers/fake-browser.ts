import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/** One tab of the fake browser. `fields` are the CSS selectors of its inputs in
 * tab order; the first starts focused, as after a browser tool clicked it. */
export interface FakePage {
  url: string;
  /** What `location.origin` evaluates to live; defaults to the url's origin.
   * Differs from `url` to model a target list that lags or lies. */
  origin?: string;
  fields?: string[];
  type?: string;
  /** List the target without a webSocketDebuggerUrl. */
  noSocket?: boolean;
}

export interface FakeBrowserCall { page: number; method: string; params?: any }

/**
 * A loopback Chrome DevTools endpoint: `/json/list` plus one WebSocket per page
 * that understands the handful of methods karmax's fill paths send. Text typed
 * with Input.insertText lands in the focused field, so a test can assert what
 * ended up where rather than which messages were sent.
 */
export async function fakeBrowser(pages: FakePage[], opts: {
  /** Status for /json/list; anything but 200 fails target discovery. */
  listStatus?: number;
  /** method → CDP error message returned instead of a result. */
  errors?: Record<string, string>;
  /** Methods the page never answers (to exercise call timeouts). */
  silent?: string[];
} = {}) {
  const calls: FakeBrowserCall[] = [];
  const state = pages.map((page) => ({
    focus: page.fields?.length ? 0 : -1,
    values: Object.fromEntries((page.fields ?? []).map((field) => [field, ''])) as Record<string, string>,
  }));
  const sockets = new Set<WebSocket>();
  let closed = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/list') return void res.writeHead(404).end();
    if (opts.listStatus && opts.listStatus !== 200) return void res.writeHead(opts.listStatus).end();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(pages.map((page, index) => ({
      type: page.type ?? 'page', url: page.url,
      ...(page.noSocket ? {} : { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${index}` }),
    }))));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    const index = Number(req.url?.split('/').pop());
    const page = pages[index]!;
    const tab = state[index]!;
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); closed++; });
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      calls.push({ page: index, method: msg.method, params: msg.params });
      if (opts.silent?.includes(msg.method)) return;
      if (opts.errors?.[msg.method]) return void socket.send(JSON.stringify({ id: msg.id, error: { message: opts.errors[msg.method] } }));
      socket.send(JSON.stringify({ id: msg.id, result: answer(page, tab, msg.method, msg.params ?? {}) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    calls,
    /** Field selector → typed text, for page `index`. */
    values: (index = 0) => ({ ...state[index]!.values }),
    get openSockets() { return sockets.size; },
    get closedSockets() { return closed; },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.terminate();
      wss.close();
      server.close(() => resolve());
    }),
  };
}

function answer(page: FakePage, tab: { focus: number; values: Record<string, string> }, method: string, params: any): unknown {
  const fields = page.fields ?? [];
  if (method === 'Runtime.evaluate') {
    if (params.expression === 'location.origin') return { result: { value: page.origin ?? new URL(page.url).origin } };
    // The focus-by-selector expression fill.ts and card-fill.ts send.
    const selector = /document\.querySelector\(("(?:[^"\\]|\\.)*")\)/.exec(String(params.expression))?.[1];
    if (selector !== undefined) {
      const found = fields.indexOf(JSON.parse(selector));
      if (found >= 0) tab.focus = found;
      return { result: { value: found >= 0 } };
    }
    return { result: {} };
  }
  if (method === 'Input.dispatchKeyEvent' && params.key === 'Tab' && params.type === 'keyDown') {
    if (fields.length) tab.focus = (tab.focus + 1) % fields.length;
    return {};
  }
  if (method === 'Input.insertText') {
    if (tab.focus >= 0) tab.values[fields[tab.focus]!] += String(params.text);
    return {};
  }
  return {};
}
