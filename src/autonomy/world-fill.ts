import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { World } from '../world/types.js';
import { verifiedPage, type CdpSession } from './cdp.js';

/**
 * Remote-world credential fill (wiki plans/PLAN-passwords §5B, cloud path).
 *
 * For a LOCAL world the gateway types the secret over CDP itself (fill.ts) —
 * agent and gateway share a host, so `127.0.0.1:<port>` is the same browser.
 * For a REMOTE world the browser runs inside the sandbox and the gateway has no
 * private socket to the sandbox's loopback, so it runs the `cdp-fill.mjs`
 * helper INSIDE the world via `world.exec`. The secret is resolved host-side
 * (the vault never leaves the gateway) and handed to the helper over STDIN —
 * never argv/env/a file. The agent still controls the browser and sandbox; this
 * avoids exposing secrets in tool results, not access by a hostile agent. The helper
 * re-verifies the live page origin against the item's domains before typing,
 * exactly like the local path.
 */
const HELPER_SOURCE = fs.readFileSync(fileURLToPath(new URL('./cdp-fill.mjs', import.meta.url)), 'utf8');
const HELPER_REL = '.karmax/cdp-fill.mjs';

export async function fillInWorld(world: World, args: {
  selector: string;
  expectDomains?: string[];
  cdpUrl: string;
  /** Resolves the secret host-side; called once, its result goes only to stdin. */
  resolveText: () => string | Promise<string>;
  timeoutMs?: number;
}): Promise<{ origin: string }> {
  if (!args.expectDomains?.length) throw new Error('browser fill requires credential domains');
  await world.writeFile(HELPER_REL, HELPER_SOURCE);
  // writeFile is root-relative but exec defaults to the workdir, which a
  // single-repo world nests below the root — run from where the helper lives.
  const preflight = await world.exec('node', [HELPER_REL, args.selector, args.expectDomains.join(','), args.cdpUrl, '--check'], {
    cwd: world.handle.root, input: '', timeoutMs: args.timeoutMs ?? 30_000,
  });
  if (preflight.code !== 0) {
    let error = 'remote credential target validation failed';
    try { error = JSON.parse(preflight.stdout).error || error; } catch {}
    throw new Error(error);
  }
  const res = await world.exec('node', [HELPER_REL, args.selector, (args.expectDomains ?? []).join(','), args.cdpUrl], {
    cwd: world.handle.root,
    input: (await args.resolveText()),
    timeoutMs: args.timeoutMs ?? 30_000,
  });
  let parsed: { origin?: string; error?: string } = {};
  try { parsed = JSON.parse((res.stdout || '').trim() || '{}'); } catch { /* fall through to error below */ }
  if (res.code !== 0 || parsed.error || !parsed.origin) {
    throw new Error(parsed.error || res.stderr.trim() || `in-world fill failed (exit ${res.code})`);
  }
  return { origin: parsed.origin };
}

const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * A CDP session on the world browser's page matching `expectDomains`, relayed
 * by the helper's `--bridge` mode over a world terminal (AU-12). A passkey's
 * virtual authenticator lives only as long as the session that added it, and
 * the gateway must hold it across the agent's click, which a one-shot
 * `world.exec` cannot. The live origin is verified here, as for a local page.
 * The trust boundary is `fillInWorld`'s: the stored credential is loaded into a
 * browser the agent controls, in a sandbox the agent controls.
 */
export async function openWorldPage(world: World, opts: {
  expectDomains: string[];
  cdpUrl: string;
  timeoutMs?: number;
  onClose?: () => void | Promise<void>;
  /** Prefer a page on `expectDomains`, else take any; the origin is then not checked. */
  anyPage?: boolean;
}): Promise<{ session: CdpSession; origin: string }> {
  if (!opts.expectDomains.length) throw new Error('a browser session requires target domains');
  // Some providers type the command into an interactive shell, where a newline
  // or control character in a domain would run as a command.
  for (const domain of opts.expectDomains)
    if (!HOST_NAME.test(domain)) throw new Error(`${JSON.stringify(domain)} is not a host name`);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  await world.writeFile(HELPER_REL, HELPER_SOURCE);
  const nonce = crypto.randomBytes(16).toString('hex');
  const marker = `@@${nonce}@@ `;
  const helper = path.posix.join(world.handle.root, HELPER_REL);
  // Raw mode: no echo of the relayed messages and no line-length limit. Some
  // providers type the command into an interactive shell, so it is one line.
  const pty = await world.openPty({ cwd: world.handle.root,
    command: `stty raw -echo 2>/dev/null; exec node ${[helper, '--bridge', nonce, opts.expectDomains.join(','), opts.cdpUrl, ...(opts.anyPage ? ['--any'] : [])].map(shellQuote).join(' ')}` });
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let ready!: (error?: Error) => void;
  const started = new Promise<void>((resolve, reject) => { ready = (error) => error ? reject(error) : resolve(); });
  let tail = '';
  const stopData = pty.onData((chunk) => {
    const lines = (tail + chunk).split(/\r?\n/);
    tail = lines.pop()!.slice(-1_000_000);
    for (const line of lines) {
      const at = line.indexOf(marker);
      if (at < 0) continue;
      let message: { ready?: boolean; error?: string; cdp?: string };
      try { message = JSON.parse(line.slice(at + marker.length)); } catch { continue; }
      if (message.ready) ready();
      else if (message.error) ready(new Error(message.error));
      else if (message.cdp) {
        let reply: any;
        try { reply = JSON.parse(message.cdp); } catch { continue; }
        const waiter = reply?.id !== undefined ? pending.get(reply.id) : undefined;
        if (!waiter) continue;
        pending.delete(reply.id);
        if (reply.error) waiter.reject(new Error(`CDP error: ${reply.error.message ?? 'unknown'}`));
        else waiter.resolve(reply.result);
      }
    }
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    stopData(); stopExit();
    for (const waiter of pending.values()) waiter.reject(new Error('the browser session closed'));
    pending.clear();
    try { await pty.close(); } finally { await opts.onClose?.(); }
  };
  const stopExit = pty.onExit(() => {
    ready(new Error('the world browser session ended before it was ready'));
    void close();
  });
  const session: CdpSession = {
    call: (method, params) => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('the browser session closed'));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      void Promise.resolve(pty.write(`${Buffer.from(JSON.stringify({ id, method, params })).toString('base64')}\n`)).catch(reject);
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`)); }, timeoutMs).unref?.();
    }),
    close,
  };
  const timer = setTimeout(() => ready(new Error('the world browser did not answer in time')), timeoutMs);
  try {
    await started;
  } catch (e) {
    await close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return verifiedPage(session, opts.anyPage ? undefined : opts.expectDomains);
}
