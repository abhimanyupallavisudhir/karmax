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
    store = (await Store.create(':memory:')); const tokens = new TokenAuthority(), worlds = new WorldRegistry();
    const project = (await store.createProject('MCP browser')); projectId = project.id; (await seedProfiles(store, 'mock'));
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'browser-test', contentDir: dir });
    const gateway = (await Gateway.create({ store, tokens, worlds, client, api, broker: new CredentialBroker(new Vault(path.join(dir, 'vault'))), bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'browser-test', staticDir: path.resolve('web'), agentInfo: { provider: 'mock', reason: 'Test' } }));
    const running = await gateway.listen(await findFreePortFrom(48_700)); base = running.url; close = running.close;
    tab = await (await fetch(`${cdp}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
    socket = new WebSocket(tab.webSocketDebuggerUrl); await once(socket, 'open');
    socket.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); });
    await rpc('Page.enable'); await rpc('Runtime.enable');
    await rpc('Page.navigate', { url: base + '/personal/mcp-browser/settings#project-defaults' });
    await wait('!!document.querySelector("[data-profile] .mcp-chip")');
  }, 30_000);
  afterAll(async () => {
    socket?.close(); if (tab) await fetch(`${cdp}/json/close/${tab.id}`).catch(() => {});
    await close?.(); (await store?.close()); if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const field = '[data-profile] .mcp-picker';
  async function choose(id: string) {
    await js(`document.querySelector('${field} .mcp-filter').focus();document.querySelector('${field} [data-mcp-id="${id}"]').click()`);
  }
  async function saveProfile() {
    await js("document.querySelector('[data-save-task-defaults]').click()");
    await wait('document.querySelector("[data-save-task-defaults]").textContent.includes("Saved")');
  }
  it('prepopulates defaults, allows both browsers, saves custom MCPs directly into the field, and preserves explicit emptiness', async () => {
    expect(await js(`document.querySelector('[data-profile] .mcp-picker').dataset.value === 'null'`)).toBe(true);
    expect(await js(`document.querySelector('${field} .mcp-chips').textContent`)).toContain('chrome-devtools');
    await choose('browser:playwright'); await saveProfile();
    expect((await store.getProfile(`${projectId}::do-default`))!.mcpConnections).toEqual(['browser:chrome-devtools', 'browser:playwright']);
    await reload();
    await js(`document.querySelector('${field} .mcp-filter').focus();document.querySelector('${field} .mcp-custom').click()`);
    await wait('!!document.querySelector(".mcp-connection-form")');
    const label = '<img src=x onerror="window.mcpXss=1">';
    await js(`document.querySelector('.mcp-auth').value='none';document.querySelector('.mcp-auth').dispatchEvent(new Event('change'));document.querySelector('.mcp-label').value=${JSON.stringify(label)};document.querySelector('.mcp-url').value='https://127.0.0.1/private';document.querySelector('.mcp-connection-form').requestSubmit()`);
    await wait('document.querySelector(".mcp-message").textContent.includes("Private")');
    await wait('!document.querySelector(".mcp-connection-form [type=submit]").disabled && !document.querySelector(".mcp-connection-form [type=submit]").classList.contains("action-pending")');
    await js("document.querySelector('.mcp-url').value='https://example.com/mcp';document.querySelector('.mcp-connection-form').requestSubmit()");
    await wait('!document.querySelector(".mcp-dialog")');
    expect(await js(`window.mcpXss === undefined && document.querySelectorAll('${field} img').length === 0`)).toBe(true);
    expect(await js(`document.querySelectorAll('${field} .mcp-chip').length`)).toBe(3);
    await saveProfile(); await reload();
    expect((await store.getProfile(`${projectId}::do-default`))!.mcpConnections).toHaveLength(3);
    await js(`while(document.querySelector('${field} [data-remove]')) document.querySelector('${field} [data-remove]').click()`);
    await saveProfile(); expect((await store.getProfile(`${projectId}::do-default`))!.mcpConnections).toEqual([]);
    await reload(); expect(await js(`document.querySelectorAll('${field} .mcp-chip').length`)).toBe(0);
  }, 45_000);
  it('searches the registry, prefills an installation form, saves and selects it, and ignores stale searches', async () => {
    // Stub only external registry discovery. Saving uses the real gateway, vault and store.
    await js(`window.originalMcpFetch = fetch; window.fetch = async (url, init) => {
      if (typeof url !== 'string' || !url.startsWith('/api/mcp/registry')) return originalMcpFetch(url, init);
      const term = new URL(url, location.origin).searchParams.get('search');
      if (term === 'slow') await new Promise(resolve => setTimeout(resolve, 800));
      return new Response(JSON.stringify({ servers: [{ name: 'io.example/' + term, title: term + ' MCP', version: '1.0.0', description: 'Example registry server', options: [{ label: 'HTTPS', transport: { type: 'http', url: 'https://example.com/' + term }, fields: [{name:'Authorization',isSecret:true,isRequired:true}] }] }] }), {headers:{'content-type':'application/json'}});
    }`);
    const search = async (term: string) => js(`document.querySelector('${field} .mcp-filter').focus();document.querySelector('${field} .mcp-filter').value='${term}';document.querySelector('${field} .mcp-filter').dispatchEvent(new Event('input'))`);
    await search('slow');
    await wait(`document.querySelector('${field} .mcp-search-status').textContent.includes('Searching')`);
    await search('docs');
    await wait(`document.querySelector('${field} [data-registry]')?.textContent.includes('docs MCP') === true`);
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(await js(`document.querySelector('${field} [data-registry]').textContent`)).toContain('docs MCP');
    await js(`document.querySelector('${field} [data-registry]').click()`);
    await wait('!!document.querySelector(".mcp-connection-form")');
    expect(await js(`document.querySelector('.mcp-label').value`)).toBe('docs MCP');
    expect(await js(`document.querySelector('.mcp-url').value`)).toBe('https://example.com/docs');
    expect(await js(`document.querySelector('[data-registry-field]').type`)).toBe('password');
    await js(`document.querySelector('[data-registry-field]').value='test-fixture-secret'; document.querySelector('.mcp-connection-form').requestSubmit()`);
    await wait('!document.querySelector(".mcp-dialog")');
    expect(await js(`document.querySelector('${field} .mcp-chips').textContent`)).toContain('docs MCP');
    await saveProfile(); await reload();
    await wait(`document.querySelector('${field} .mcp-chips').textContent.includes('docs MCP')`);
    await js("document.querySelector('[data-resetprofile]').click()");
    await wait(`document.querySelector('${field} .mcp-chips').textContent.includes('chrome-devtools')`);
    expect((await store.getProfile(`${projectId}::do-default`))).toBeUndefined();
  }, 30_000);
  it('supports keyboard selection and keeps the custom action outside the mobile result scroll', async () => {
    await rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await js(`document.querySelector('${field} .mcp-filter').focus()`);
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    expect(await js(`document.querySelector('${field} .mcp-chips').textContent`)).toContain('playwright');
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    expect(await js(`document.querySelector('${field} .mcp-menu').hidden`)).toBe(true);
    await js(`document.querySelector('${field} .mcp-caret').click()`);
    expect(await js(`(() => { const menu = document.querySelector('${field} .mcp-menu'), footer = menu.querySelector('.mcp-custom'), options = menu.querySelector('.mcp-options'); return !options.contains(footer) && menu.getBoundingClientRect().right <= innerWidth; })()`)).toBe(true);
    await js(`document.querySelector('${field} .mcp-custom').click()`);
    expect(await js('document.querySelector(".mcp-dialog").getBoundingClientRect().width <= innerWidth')).toBe(true);
    await js("document.querySelector('.mcp-editor-cancel').click()");
  });
  it('uses organization defaults in the new-task form and persists chosen tools in a draft', async () => {
    (await store.upsertProfile({ id: 'organization:org_personal::do-default', name: 'Agent', role: 'do', provider: 'codex', mcpConnections: ['browser:playwright'] }));
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await rpc('Page.navigate', { url: base + '/personal/mcp-browser' });
    await wait('!!document.querySelector("#expand-task")');
    await js('document.querySelector("#expand-task").click()');
    const taskField = '#tf-page [data-agent="do"] .mcp-picker';
    await wait(`document.querySelector('${taskField} .mcp-chip')?.textContent.includes('playwright') === true`);
    expect(await js(`document.querySelector('${taskField}').textContent`)).not.toMatch(/inherited|Manage connections|account browser/);
    await js(`document.querySelector('${taskField} .mcp-filter').focus();document.querySelector('${taskField} [data-mcp-id="browser:chrome-devtools"]').click()`);
    expect(await js(`document.querySelector('#tf-page [data-reset="agent:do"]').hidden`)).toBe(false);
    await js(`document.querySelector('#tf-page [data-reset="agent:do"]').click()`);
    await wait(`document.querySelectorAll('${taskField} .mcp-chip').length === 1`);
    expect(await js(`document.querySelector('${taskField} .mcp-chips').textContent`)).toContain('playwright');
    await js(`document.querySelector('${taskField} .mcp-filter').focus();document.querySelector('${taskField} [data-mcp-id="browser:chrome-devtools"]').click()`);
    // Enough saved results to exercise the independent scroll area and fixed footer.
    await js(`window.fixtureFetch = fetch; window.fetch = async (url, init) => {
      if (typeof url !== 'string' || !url.startsWith('/api/mcp/registry')) return fixtureFetch(url, init);
      return new Response(JSON.stringify({servers: Array.from({length:20}, (_, i) => ({name:'io.example/docs-' + i, title:'Documentation ' + i, version:'1', options:[]}))}), {headers:{'content-type':'application/json'}});
    };document.querySelector('${taskField} .mcp-filter').value='docs';document.querySelector('${taskField} .mcp-filter').dispatchEvent(new Event('input'))`);
    await wait(`document.querySelectorAll('${taskField} [data-registry]').length === 20`);
    expect(await js(`(() => {const options=document.querySelector('${taskField} .mcp-options'), footer=document.querySelector('${taskField} .mcp-custom');const before=footer.getBoundingClientRect().top;options.scrollTop=options.scrollHeight;return options.scrollHeight>options.clientHeight && footer.getBoundingClientRect().top===before;})()`)).toBe(true);
    if (process.env.KARMAX_MCP_SCREENSHOTS) {
      fs.mkdirSync(process.env.KARMAX_MCP_SCREENSHOTS, { recursive: true });
      await js(`document.querySelector('${taskField} .mcp-options').scrollTop=0;document.querySelector('${taskField}').scrollIntoView({block:'center'});document.querySelector('${taskField} .mcp-filter').blur();document.querySelector('${taskField} .mcp-filter').focus()`);
      const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.KARMAX_MCP_SCREENSHOTS, 'mcp-combobox.png'), Buffer.from(screenshot.data, 'base64'));
      await js(`document.querySelector('${taskField} .mcp-custom').click()`);
      const editor = await rpc('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.KARMAX_MCP_SCREENSHOTS, 'mcp-custom-form.png'), Buffer.from(editor.data, 'base64'));
      await js(`document.querySelector('.mcp-editor-cancel').click()`);
    }
    await js(`document.querySelector('#tf-page textarea[data-field="prompt"]').value='MCP combobox draft';document.querySelector('#tf-page textarea[data-field="prompt"]').dispatchEvent(new Event('input', {bubbles:true}));document.querySelector('#tf-draft').click()`);
    await expect.poll(async () => (await store.listTasks(projectId)).find(task => task.params.prompt === 'MCP combobox draft')?.params?.['agent:do'], { timeout: 10_000 })
      .toMatchObject({ mcpConnections: ['browser:playwright', 'browser:chrome-devtools'] });
  }, 30_000);

});
