import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { seedProfiles } from '../src/agent/profiles.js';
import { findFreePortFrom } from '../src/util/ports.js';

// Uses a new tab on an explicitly supplied test browser. No personal tabs,
// cookies, model credentials or production Karmax data are read or modified.
const cdp = process.env.KARMAX_MCP_BROWSER_CDP;
describe.skipIf(!cdp)('MCP settings in a real browser', () => {
  let dir: string, priorHome: string | undefined, store: Store, socket: WebSocket, tab: any, base: string, projectId: string, close: () => Promise<void>;
  let sequence = 0; const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  function rpc(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } }); socket.send(JSON.stringify({ id, method, params })); });
  }
  async function js(expression: string) {
    const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  }
  async function wait(expression: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { try { if (await js(expression) === true) return; } catch { /* page may still be loading */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error(`Browser condition timed out: ${expression}; status=${await js('JSON.stringify({message:document.querySelector(".mcp-message")?.textContent,forms:[...document.querySelectorAll(".mcp-connection-form")].map(f=>({valid:f.checkValidity(),invalid:[...f.querySelectorAll(":invalid")].map(i=>({cls:i.className,value:i.value,message:i.validationMessage}))}))})')}`);
  }
  async function reload() {
    await js('window.mcpBeforeReload = true');
    await rpc('Page.reload');
    await wait('window.mcpBeforeReload === undefined && document.readyState === \"complete\" && !!document.querySelector(\"[data-profile] .mcp-picker\")');
  }
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-browser-')); priorHome = process.env.KARMAX_HOME; process.env.KARMAX_HOME = dir;
    store = new Store(':memory:'); const tokens = new TokenAuthority(), worlds = new WorldRegistry();
    const project = store.createProject('MCP browser'); projectId = project.id; seedProfiles(store, 'mock');
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'browser-test', contentDir: dir });
    const gateway = new Gateway({ store, tokens, worlds, client, api, broker: new CredentialBroker(new Vault(path.join(dir, 'vault'))), bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'browser-test', staticDir: path.resolve('web'), agentInfo: { provider: 'mock', reason: 'Test' } });
    const running = await gateway.listen(await findFreePortFrom(48_700)); base = running.url; close = running.close;
    tab = await (await fetch(`${cdp}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
    socket = new WebSocket(tab.webSocketDebuggerUrl); await once(socket, 'open');
    socket.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); });
    await rpc('Page.enable'); await rpc('Runtime.enable');
    await rpc('Page.navigate', { url: base + '/personal/mcp-browser/settings#project-tools' });
    await wait('!!document.querySelector("#project-mcp-manage")');
  }, 30_000);
  afterAll(async () => {
    socket?.close(); if (tab) await fetch(`${cdp}/json/close/${tab.id}`).catch(() => {});
    await close?.(); store?.close(); if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  it('validates custom connections, escapes hostile labels, refreshes choices, persists explicit selection and supports mobile keyboard use', async () => {
    await js('document.querySelector("#project-mcp-manage").click()');
    await wait('!!document.querySelector(".mcp-add")');
    await js('document.querySelector(".mcp-add").click()');
    const label = '<img src=x onerror="window.mcpXss=1">';
    await js(`document.querySelector('.mcp-label').value=${JSON.stringify(label)};document.querySelector('.mcp-url').value='https://127.0.0.1/private';document.querySelector('.mcp-connection-form').requestSubmit()`);
    await wait('document.querySelector(".mcp-message").textContent.includes("Private")');
    await wait('!document.querySelector(".mcp-connection-form [type=submit]").classList.contains("action-pending")');
    await js("document.querySelector('.mcp-url').value='https://example.com/mcp';document.querySelector('.mcp-connection-form').requestSubmit()");
    await wait('document.querySelector(".mcp-message").textContent.includes("Connection saved")');
    expect(await js('window.mcpXss === undefined && document.querySelectorAll(".mcp-connection-row img").length === 0')).toBe(true);
    await wait('document.querySelectorAll(".mcp-picker input[value^=mcp_]").length > 0');
    await js("document.querySelector('.mcp-close').click();document.querySelector('a[href=\"#project-defaults\"]').click()");
    await wait('!!document.querySelector("[data-profile] .mcp-picker input[value^=mcp_]")');
    await js("document.querySelector('[data-profile] .mcp-picker input[value^=mcp_]').click();document.querySelector('[data-saveprofile]').click()");
    await wait('document.querySelector("[data-saveprofile]").textContent.includes("Saved")');
    const own = store.getProfile(`${projectId}::do-default`)!; expect(own.mcpConnections).toHaveLength(1);
    await reload(); await wait('!!document.querySelector("[data-profile] .mcp-picker input[value^=mcp_]:checked")');
    // Selecting one browser replaces the other, then clearing every checkbox is
    // an explicit empty set, not an accidental return to inherited defaults.
    await js("document.querySelector('[data-profile] input[value=\"browser:chrome-devtools\"]').click();document.querySelector('[data-profile] input[value=\"browser:playwright\"]').click()");
    expect(await js('document.querySelectorAll("[data-profile] .mcp-options input:checked").length')).toBe(2);
    await js("while(document.querySelector('[data-profile] .mcp-options input:checked')) document.querySelector('[data-profile] .mcp-options input:checked').click();document.querySelector('[data-saveprofile]').click()");
    await wait('document.querySelector("[data-saveprofile]").textContent.includes("Saved")'); expect(store.getProfile(`${projectId}::do-default`)!.mcpConnections).toEqual([]);
    await reload(); await wait('document.querySelector("[data-profile] .mcp-picker summary")?.textContent === "Karmax tools only"');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await js("document.querySelector('a[href=\"#project-defaults\"]').click(); document.querySelector('[data-profile] .mcp-picker summary').focus()");
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    expect(await js('({active:document.activeElement.outerHTML.slice(0,500),open:document.querySelector("[data-profile] .mcp-choices").open,rect:document.querySelector("[data-profile] .mcp-picker summary").getBoundingClientRect().toJSON()})')).toEqual(expect.objectContaining({active:expect.stringContaining('Search tool connections')}));
    await js("document.querySelector('[data-profile] .mcp-manage').click()");
    expect(await js('document.querySelector(".mcp-dialog").getBoundingClientRect().width <= innerWidth')).toBe(true);
    expect(await js('document.querySelector(".mcp-dialog").getAttribute("aria-label")')).toBe('MCP connections');
  }, 45_000);
});
