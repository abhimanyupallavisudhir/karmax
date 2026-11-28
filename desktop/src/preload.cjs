// The native bridge (wiki planned/native-apps-round-2, contract 1): the same
// window.Capacitor shape the phone apps inject, so web/app.js finds the
// desktop's plugins with nativePlugin(name) and checks capabilities, never
// platform names. This preload runs sandboxed with context isolation: the
// page sees only the frozen object below, and every call is an IPC message
// that main answers only for the console's own origin.
//
// Which plugins and methods exist is main's to say (src/bridge.cjs), so this
// file never changes when a plugin is added (TavyaOfflineFiles, sub-task E).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const manifest = ipcRenderer.sendSync('tavya:manifest') || {};
const listeners = new Map(); // "Plugin.event" → Set<callback>

ipcRenderer.on('tavya:event', (_event, plugin, name, data) => {
  for (const callback of listeners.get(`${plugin}.${name}`) || []) {
    try { callback(data); } catch (error) { console.error(error); }
  }
});

function call(plugin, method, options) {
  return ipcRenderer.invoke('tavya:call', plugin, method, options === undefined ? undefined : options).then((answer) => {
    if (answer && answer.ok) return answer.value;
    // Capacitor rejects with an object carrying `code`; an Error would lose it crossing the bridge.
    const error = (answer && answer.error) || { code: 'failed', message: 'The app could not do that.' };
    return Promise.reject({ code: error.code || 'failed', message: error.message || 'The app could not do that.' });
  });
}

function plugin(name, spec) {
  const object = {};
  for (const method of spec.methods || []) object[method] = (options) => call(name, method, options);
  object.addListener = (eventName, callback) => {
    const key = `${name}.${eventName}`;
    if (typeof callback !== 'function' || !(spec.events || []).includes(eventName))
      return Promise.reject({ code: 'unavailable', message: `${name} has no event ${eventName}.` });
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(callback);
    ipcRenderer.send('tavya:listen', name, eventName, true);
    const remove = () => {
      listeners.get(key)?.delete(callback);
      if (!listeners.get(key)?.size) ipcRenderer.send('tavya:listen', name, eventName, false);
      return Promise.resolve();
    };
    return Promise.resolve({ remove });
  };
  object.removeAllListeners = () => {
    for (const eventName of spec.events || []) {
      listeners.delete(`${name}.${eventName}`);
      ipcRenderer.send('tavya:listen', name, eventName, false);
    }
    return Promise.resolve();
  };
  return object;
}

// Only the console gets a bridge (main sends no manifest to any other page).
if (manifest.plugins) {
  const Plugins = {};
  for (const [name, spec] of Object.entries(manifest.plugins)) Plugins[name] = plugin(name, spec);
  contextBridge.exposeInMainWorld('Capacitor', {
    isNativePlatform: () => true,
    getPlatform: () => 'electron',
    isPluginAvailable: (name) => Object.hasOwn(Plugins, name),
    Plugins,
  });
}
