#!/usr/bin/env node
/**
 * In-world credential fill (wiki plans/PLAN-passwords §5B, cloud path).
 *
 * For a LOCAL world the gateway types the secret over CDP itself (fill.ts). For
 * a REMOTE world the browser lives inside the sandbox and the gateway cannot
 * open a private socket to the sandbox's loopback — so this helper runs INSIDE
 * the world (via world.exec) and does the CDP typing there. It mirrors
 * cdp.ts/fill.ts exactly: loopback-only endpoint, page picked by the item's
 * domains, the LIVE page origin re-verified over CDP before anything is typed
 * (anti-phishing), then Input.insertText.
 *
 * The secret is read from STDIN, never argv/env/a file — so the co-resident
 * agent cannot read it from /proc or disk. It is never echoed. Non-secret args:
 *   argv[2] selector        CSS selector, or "@focused" / "@tab"
 *   argv[3] expectDomains   comma-separated domains the page origin must match
 *   argv[4] cdpUrl          loopback DevTools endpoint (default 127.0.0.1:9222)
 * On success prints {"origin":"https://..."} to stdout; on failure prints
 * {"error":"..."} and exits 1. Uses only Node built-ins and a hand-rolled
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

async function main() {
  if (!expectDomains.length) fail('browser fill requires credential domains');
  const checkOnly = process.argv[5] === '--check';
  const secret = await readStdin();
  if (!checkOnly && !secret) fail('no secret on stdin');
  const base = assertLoopback(cdpUrl);
  const list = await (await fetch(new URL('/json/list', base), { signal: AbortSignal.timeout(TIMEOUT) })).json();
  if (process.env.KARMAX_CDP_DEBUG)
    process.stderr.write(`[cdp-fill] /json/list: ${JSON.stringify(list.map((t) => ({ type: t.type, url: t.url, ws: !!t.webSocketDebuggerUrl })))}\n`);
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page = expectDomains.length
    ? pages.find((t) => { try { return expectDomains.some((d) => domainMatches(new URL(t.url).hostname, d)); } catch { return false; } })
    : pages[0];
  if (!page) fail(expectDomains.length
    ? `no open page matches ${expectDomains.join(', ')} — navigate to the login page first`
    : 'no open page at the CDP endpoint');

  const session = await connect(page.webSocketDebuggerUrl);
  try {
    const originResult = await session.call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
    const origin = String(originResult?.result?.value ?? '');
    if (expectDomains.length) {
      let host = '';
      try { host = new URL(origin).hostname; } catch { /* about:blank */ }
      if (!host || !expectDomains.some((d) => domainMatches(host, d)))
        fail(`refusing: the page origin (${origin || 'unknown'}) does not match the expected domains (${expectDomains.join(', ')})`);
    }
    if (selector === '@tab') {
      if (!checkOnly) {
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
      }
    } else if (selector !== '@focused') {
      const focus = await session.call('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`,
        returnByValue: true,
      });
      if (focus?.result?.value !== true) fail(`no element matches selector ${selector}`);
    }
    if (!checkOnly) await session.call('Input.insertText', { text: secret });
    process.stdout.write(JSON.stringify({ origin }));
  } finally {
    session.close();
  }
}

main().then(() => process.exit(0)).catch((e) => fail(e?.message ?? String(e)));
