#!/usr/bin/env node
/**
 * In-world credential fill (wiki plans/PLAN-passwords §5B, cloud path).
 *
 * For a LOCAL world the gateway types the secret over CDP itself (fill.ts). For
 * a REMOTE world the browser lives inside the sandbox and the gateway cannot
 * open a private socket to the sandbox's loopback — so this helper runs INSIDE
 * the world (via world.exec) and does the CDP typing there. It mirrors
 * cdp.ts/fill.ts exactly: loopback-only endpoint, page picked by the item's
 * domains, then one in-page step that re-checks the LIVE page origin (https,
 * or http on loopback) and the field, and writes the value (anti-phishing; AU-38:
 * a separate check and typing call let a navigation or a focused frame in
 * between receive the secret).
 *
 * The secret is read from STDIN, never argv/env/a file — so the co-resident
 * agent cannot read it from /proc or disk. It is never echoed. Non-secret args:
 *   argv[2] selector        CSS selector, or "@focused" / "@tab"
 *   argv[3] expectDomains   comma-separated domains the page origin must match
 *   argv[4] cdpUrl          loopback DevTools endpoint (default 127.0.0.1:9222)
 * On success prints {"origin":"https://..."} to stdout; on failure prints
 * {"error":"..."} and exits 1.
 *
 * `--bridge <nonce> <expectDomains> <cdpUrl> [--any]` instead relays the matching
 * page's CDP session over this process's terminal (world-fill.ts
 * openWorldPage), so the gateway can hold a passkey authenticator in a remote
 * world's browser across the agent's click. Lines in are base64 CDP messages;
 * lines out are `@@<nonce>@@ <json>`, which the command's own echo never is. Uses only Node built-ins and a hand-rolled
 * WebSocket client over node:net, so it runs on the sandbox's own node — the
 * default E2B template ships Node 20, which has no global WebSocket.
 */
import net from 'node:net';
import crypto from 'node:crypto';

const [, , selector = '', expectCsv = '', cdpUrlArg = ''] = process.argv;
const cdpUrl = cdpUrlArg || `http://127.0.0.1:${process.env.KARMAX_CDP_PORT || 9222}`;
const expectDomains = expectCsv ? expectCsv.split(',').map((s) => s.trim()).filter(Boolean) : [];
const TIMEOUT = 15_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function fail(msg) { process.stdout.write(JSON.stringify({ error: msg })); process.exit(1); }

// Mirror of vault-items.domainMatches.
function domainMatches(host, domain) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const d = String(domain).toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return h === d || h.endsWith(`.${d}`);
}

// Identical to WRITE_IN_PAGE in fill.ts (tests/fill-origin.browser.test.ts pins it).
const WRITE_IN_PAGE = `(selector, domains, value) => {
  const host = location.hostname.toLowerCase().replace(/\\.$/, '');
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  if (location.protocol !== 'https:' && !(location.protocol === 'http:' && loopback))
    return { error: 'refusing: ' + (location.origin === 'null' ? location.href : location.origin) + ' is not a secure page' };
  const matches = domains.some((domain) => {
    const d = String(domain).toLowerCase().replace(/^\\*\\./, '').replace(/\\.$/, '');
    return host === d || host.endsWith('.' + d);
  });
  if (!matches) return { error: 'refusing: the page origin (' + location.origin + ') does not match the expected domains (' + domains.join(', ') + ')' };
  if (selector === null) return { origin: location.origin };
  let target = selector === '@focused' ? document.activeElement : document.querySelector(selector);
  while (selector === '@focused' && target && target.shadowRoot && target.shadowRoot.activeElement) target = target.shadowRoot.activeElement;
  if (!target || (selector === '@focused' && target === document.body)) return { error: 'no element matches selector ' + selector };
  if (target.tagName === 'IFRAME' || target.tagName === 'FRAME') return { error: 'refusing: the field is in another frame' };
  const input = target instanceof HTMLInputElement && ['text', 'password', 'email', 'tel', 'url', 'search', 'number'].includes(target.type);
  if (!input && !(target instanceof HTMLTextAreaElement) && !target.isContentEditable)
    return { error: 'refusing: ' + selector + ' is not a text field' };
  if (value === null) return { origin: location.origin };
  target.focus();
  if (target.isContentEditable) target.textContent = value;
  else Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value').set.call(target, value);
  target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return { origin: location.origin };
}`;

function assertLoopback(u) {
  const base = new URL(u);
  if (base.protocol !== 'http:' || !LOOPBACK.has(base.hostname))
    throw new Error('cdpUrl must be a loopback http endpoint (http://127.0.0.1:<port>)');
  return base;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Minimal client-side WebSocket over a raw TCP socket (RFC 6455). Enough for
// CDP's small JSON text frames; avoids depending on a global WebSocket (absent
// on Node 20) or an installed `ws` package. Client frames are masked; server
// frames are not. Handles 7/16/64-bit lengths, fragmentation, and ping.
function wsClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const sock = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
    sock.setNoDelay(true); // CDP frames are tiny and latency-sensitive
    const listeners = new Set();
    let buf = Buffer.alloc(0);
    let handshook = false;
    let frag = { op: 0, chunks: [] };
    const t = setTimeout(() => { sock.destroy(); reject(new Error('CDP connection timed out')); }, TIMEOUT);

    const sendFrame = (opcode, payload) => {
      const len = payload.length;
      const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
        : len < 65536 ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(len); return b; })()])
          : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      sock.write(Buffer.concat([head, mask, masked]));
    };

    let closed;
    const ended = new Promise((resolve) => { closed = resolve; });
    sock.on('close', () => closed());
    const onMessage = (text) => {
      for (const l of listeners) l(text);
    };

    const parseFrames = () => {
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x9) { sendFrame(0xa, payload); continue; } // ping → pong
        if (opcode === 0x8) { sock.end(); return; }               // close
        if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
          if (opcode !== 0x0) frag = { op: opcode, chunks: [] };
          frag.chunks.push(Buffer.from(payload));
          if (fin) { const text = Buffer.concat(frag.chunks).toString('utf8'); frag = { op: 0, chunks: [] }; onMessage(text); }
        }
      }
    };

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = buf.subarray(0, end).toString('utf8');
        if (!/HTTP\/1\.1 101/i.test(header)) { clearTimeout(t); sock.destroy(); return reject(new Error('CDP connection failed (handshake)')); }
        buf = buf.subarray(end + 4);
        handshook = true;
        clearTimeout(t);
        resolve(makeSession());
      }
      if (handshook) parseFrames();
    });
    sock.on('error', () => { clearTimeout(t); reject(new Error('CDP connection failed')); });

    const makeSession = () => {
      let nextId = 1;
      const pending = new Map();
      listeners.add((text) => {
        let msg; try { msg = JSON.parse(text); } catch { return; }
        const w = msg.id !== undefined ? pending.get(msg.id) : undefined;
        if (!w) return;
        pending.delete(msg.id);
        if (msg.error) w.reject(new Error(`CDP error: ${msg.error.message ?? 'unknown'}`));
        else w.resolve(msg.result);
      });
      return {
        call: (method, params) => new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          sendFrame(0x1, Buffer.from(JSON.stringify({ id, method, params })));
          setTimeout(() => { if (pending.delete(id)) rej(new Error(`CDP ${method} timed out`)); }, TIMEOUT);
        }),
        close: () => sock.destroy(),
        raw: { send: (text) => sendFrame(0x1, Buffer.from(text)), listen: (listener) => listeners.add(listener), ended },
      };
    };

    // Perform the upgrade handshake.
    const wsKey = crypto.randomBytes(16).toString('base64');
    sock.on('connect', () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.hostname}:${u.port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  });
}

const connect = wsClient;

/** The page whose target-list url matches `domains`; its live origin is checked by the caller. */
async function findPage(cdpUrl, domains, anyPage = false) {
  const base = assertLoopback(cdpUrl);
  const list = await (await fetch(new URL('/json/list', base), { signal: AbortSignal.timeout(TIMEOUT) })).json();
  if (process.env.KARMAX_CDP_DEBUG)
    process.stderr.write(`[cdp-fill] /json/list: ${JSON.stringify(list.map((t) => ({ type: t.type, url: t.url, ws: !!t.webSocketDebuggerUrl })))}\n`);
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page = (domains.length
    ? pages.find((t) => { try { return domains.some((d) => domainMatches(new URL(t.url).hostname, d)); } catch { return false; } })
    : pages[0]) ?? (anyPage ? pages[0] : undefined);
  if (!page) throw new Error(domains.length
    ? `no open page matches ${domains.join(', ')} — navigate to the login page first`
    : 'no open page at the CDP endpoint');
  return page;
}

async function bridge(nonce, domainCsv, bridgeCdpUrl, anyPage = false) {
  const emit = (message) => process.stdout.write(`@@${nonce}@@ ${JSON.stringify(message)}\n`);
  try {
    const domains = domainCsv.split(',').map((s) => s.trim()).filter(Boolean);
    if (!/^[0-9a-f]{16,}$/.test(nonce) || !domains.length) throw new Error('bridge needs a nonce and target domains');
    const session = await connect((await findPage(bridgeCdpUrl, domains, anyPage)).webSocketDebuggerUrl);
    session.raw.listen((text) => emit({ cdp: text }));
    session.raw.ended.then(() => process.exit(0));
    let pending = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      pending += chunk;
      for (let end; (end = pending.search(/[\r\n]/)) >= 0; pending = pending.slice(end + 1)) {
        const line = pending.slice(0, end).trim();
        if (line) session.raw.send(Buffer.from(line, 'base64').toString('utf8'));
      }
    });
    process.stdin.on('end', () => { session.close(); process.exit(0); });
    emit({ ready: true });
  } catch (e) { emit({ error: e?.message ?? String(e) }); process.exit(1); }
}

async function main() {
  if (!expectDomains.length) fail('browser fill requires credential domains');
  const checkOnly = process.argv[5] === '--check';
  const secret = await readStdin();
  if (!checkOnly && !secret) fail('no secret on stdin');
  let page;
  try { page = await findPage(cdpUrl, expectDomains); } catch (e) { fail(e.message); }

  const session = await connect(page.webSocketDebuggerUrl);
  try {
    // An isolated world, as in fill.ts: the page's realm cannot redefine the
    // builtins the check compares with, and a navigation destroys the world.
    const frameId = (await session.call('Page.getFrameTree'))?.frameTree?.frame?.id;
    const contextId = (await session.call('Page.createIsolatedWorld', { frameId, worldName: 'karmax-fill' }))?.executionContextId;
    if (!frameId || !contextId) fail('could not open an isolated world in the page');
    const inPage = async (target, value) => {
      const result = await session.call('Runtime.evaluate', { returnByValue: true, contextId,
        expression: `(${WRITE_IN_PAGE})(${JSON.stringify(target)}, ${JSON.stringify(expectDomains)}, ${JSON.stringify(value)})` });
      const outcome = result?.result?.value;
      if (!outcome || typeof outcome !== 'object' || outcome.error) fail(outcome?.error ?? 'the page did not answer the fill');
      return outcome;
    };
    // A check only reads: it never moves focus, so @tab's target is not known yet.
    if (checkOnly) {
      const { origin } = await inPage(selector === '@tab' ? null : selector, null);
      process.stdout.write(JSON.stringify({ origin }));
      return;
    }
    if (selector === '@tab') {
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
    }
    const { origin } = await inPage(selector === '@tab' ? '@focused' : selector, secret);
    process.stdout.write(JSON.stringify({ origin }));
  } finally {
    session.close();
  }
}

if (process.argv[2] === '--bridge') void bridge(process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '', process.argv[6] === '--any');
else main().then(() => process.exit(0)).catch((e) => fail(e?.message ?? String(e)));
