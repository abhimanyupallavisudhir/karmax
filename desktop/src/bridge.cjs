// Main's side of the native bridge (src/preload.cjs is the page's side). A
// plugin is {methods: {name: async (options, context) => value}, events: [names]}.
// Calls are answered only for the console's own origin, in its top frame; an
// answer is {ok, value} or {ok: false, error: {code, message}} (a thrown
// {code, message} object passes through; anything else becomes 'failed').
'use strict';

class Bridge {
  constructor({ origin, log = () => {} }) {
    this.origin = origin;
    this.log = log;
    this.plugins = new Map();
    this.listening = new Map(); // webContents id → Set<"Plugin.event">
  }

  register(name, plugin) {
    if (plugin) this.plugins.set(name, plugin);
    return this;
  }

  /** Whether a message comes from the console itself (top frame, console origin). */
  trusted(event) {
    const frame = event.senderFrame;
    if (!frame || frame.parent) return false;
    try { return new URL(frame.url).origin === this.origin; } catch { return false; }
  }

  manifest() {
    const plugins = {};
    for (const [name, plugin] of this.plugins) plugins[name] = { methods: Object.keys(plugin.methods || {}), events: plugin.events || [] };
    return { plugins };
  }

  async call(event, pluginName, method, options) {
    if (!this.trusted(event)) return { ok: false, error: { code: 'forbidden', message: 'Not the console.' } };
    const plugin = this.plugins.get(pluginName);
    const run = plugin && Object.hasOwn(plugin.methods || {}, method) ? plugin.methods[method] : null;
    if (!run) return { ok: false, error: { code: 'unimplemented', message: `${pluginName}.${method} is not available.` } };
    try {
      const value = await run(options ?? {}, { webContents: event.sender });
      return { ok: true, value: value === undefined ? undefined : value };
    } catch (error) {
      if (error && typeof error === 'object' && typeof error.code === 'string' && !(error instanceof Error))
        return { ok: false, error: { code: error.code, message: String(error.message || '') } };
      this.log(`${pluginName}.${method} failed`, error);
      return { ok: false, error: { code: 'failed', message: error?.message || String(error) } };
    }
  }

  listen(event, pluginName, eventName, on) {
    if (!this.trusted(event)) return;
    const id = event.sender.id;
    if (!this.listening.has(id)) this.listening.set(id, new Set());
    const set = this.listening.get(id);
    const key = `${pluginName}.${eventName}`;
    if (on) set.add(key); else set.delete(key);
    if (on) this.plugins.get(pluginName)?.onListen?.(eventName, event.sender);
  }

  /** A new document has no listeners. */
  reset(webContents) { this.listening.delete(webContents.id); }

  isListening(webContents, pluginName, eventName) {
    return !!webContents && !webContents.isDestroyed() && !!this.listening.get(webContents.id)?.has(`${pluginName}.${eventName}`);
  }

  emit(webContents, pluginName, eventName, data) {
    if (!this.isListening(webContents, pluginName, eventName)) return false;
    webContents.send('tavya:event', pluginName, eventName, data);
    return true;
  }

  /** Wire the IPC channels the preload uses. */
  attach(ipcMain) {
    ipcMain.on('tavya:manifest', (event) => { event.returnValue = this.trusted(event) ? this.manifest() : {}; });
    ipcMain.handle('tavya:call', (event, plugin, method, options) => this.call(event, plugin, method, options));
    ipcMain.on('tavya:listen', (event, plugin, eventName, on) => this.listen(event, plugin, eventName, on));
  }
}

module.exports = { Bridge };
