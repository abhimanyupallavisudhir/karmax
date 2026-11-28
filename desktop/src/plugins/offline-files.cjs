// TavyaOfflineFiles (wiki features/offline-files; sub-task E of task #1064):
// bytes of pinned files on disk, under the app's userData folder. Not built
// yet, so this returns null and the console sees no such plugin
// (isPluginAvailable('TavyaOfflineFiles') is false). To build it, return
// {methods: {name: async (options, {webContents}) => value}, events: [...]}
// with the same methods as the phone apps' plugin; main.cjs registers it and
// the preload picks the methods up by itself.
'use strict';

// main.cjs calls it with {app, origin}.
function offlineFilesPlugin() {
  return null;
}

module.exports = { offlineFilesPlugin };
