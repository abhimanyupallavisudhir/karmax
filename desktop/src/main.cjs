// tavya for Mac and Linux (wiki features/desktop-apps): the hosted console in
// its own window, plus what a browser tab can't do — a tray with what's for
// you, a global Ask shortcut, io.tavya.app:// links, launch at login, sign-in
// through the system browser and updates. No console code lives here:
// web/app.js finds the native side through window.Capacitor (src/preload.cjs).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, Menu, Notification, dialog, Tray, globalShortcut, ipcMain, nativeImage, nativeTheme, safeStorage, session, shell,
  systemPreferences,
} = require('electron');
const { SCHEME, serverFromEnvironment } = require('./config.cjs');
const { argvTarget, linkTarget } = require('./links.cjs');
const { loopbackSignIn } = require('./loopback.cjs');
const { Hotkey, defaultAccelerator } = require('./hotkey.cjs');
const { Settings } = require('./settings.cjs');
const { createLaunchAtLogin } = require('./autostart.cjs');
const { Updates, updateKind } = require('./updates.cjs');
const { DeviceToken } = require('./device-token.cjs');
const { Bridge } = require('./bridge.cjs');
const { offlineFilesPlugin } = require('./plugins/offline-files.cjs');
const { integrateAppImage } = require('./appimage.cjs');

const MAC = process.platform === 'darwin';
const LINUX = process.platform === 'linux';
const ASSETS = path.join(__dirname, 'assets');
const PENDING_OPEN_MS = 2 * 60_000;
const log = (...args) => console.log('[tavya]', ...args);
const fromConsole = (url) => { try { return new URL(url).origin === ORIGIN; } catch { return false; } };

let server;
try {
  server = serverFromEnvironment();
} catch (error) {
  console.error(`[tavya] ${error.message}`);
  dialog.showErrorBox('tavya can’t start', error.message);
  process.exit(2);
}
const ORIGIN = server.origin;

// Tests and side-by-side builds keep their own profile (and their own single-instance lock).
if (process.env.TAVYA_DESKTOP_USER_DATA) app.setPath('userData', process.env.TAVYA_DESKTOP_USER_DATA);
// Wayland has no global key grabs; Chromium asks the desktop through the
// GlobalShortcuts portal instead (src/hotkey.cjs).
if (LINUX) app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  let win = null;
  let tray = null;
  let quitting = false;
  let forMe = 0;
  let pendingOpen = null; // {target, at}
  let signIn = null; // the attempt in flight
  let manualCheck = false;

  const bridge = new Bridge({ origin: ORIGIN, log });
  bridge.attach(ipcMain);

  // ── links: Mac open-url (may come before ready), Linux second instances ──
  const startTarget = argvTarget(process.argv, ORIGIN);
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const target = linkTarget(url, ORIGIN);
    if (target) openTarget(target);
  });
  app.on('second-instance', (_event, argv) => {
    const target = argvTarget(argv, ORIGIN);
    if (target) openTarget(target); else showWindow();
  });
  // A universal link (https://<console>/…) on a Mac, signed builds with Associated Domains.
  app.on('continue-activity', (event, type, details) => {
    if (type !== 'NSUserActivityTypeBrowsingWeb') return;
    const target = linkTarget(details?.webpageURL, ORIGIN);
    if (target) { event.preventDefault(); openTarget(target); }
  });
  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else if (MAC) {
    app.setAsDefaultProtocolClient(SCHEME);
  }

  app.on('before-quit', () => { quitting = true; signIn?.cancel(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* stays in the tray; Quit is in its menu */ });
  app.on('activate', () => showWindow());

  app.whenReady().then(() => {
    // web/app.js and the server's logs know the app by this suffix (as the phone apps).
    app.userAgentFallback = `${app.userAgentFallback} tavya-app`;
    const settings = new Settings(app.getPath('userData'));
    const launchAtLogin = createLaunchAtLogin(app);
    const deviceToken = new DeviceToken({ dir: app.getPath('userData'), safeStorage, origin: ORIGIN });
    if (LINUX && process.env.APPIMAGE && app.isPackaged) {
      try { integrateAppImage({ appImage: process.env.APPIMAGE, iconSource: path.join(ASSETS, 'icon.png') }); }
      catch (error) { log('AppImage desktop entry', error.message); }
    }

    // ── security: what the console may do, and nothing else may ──
    const consoleSession = session.defaultSession;
    const allowedPermission = (permission, origin, details = {}) => {
      if (!fromConsole(origin)) return false;
      if (permission === 'notifications') return true;
      // Copy buttons (navigator.clipboard.writeText); reading the clipboard stays refused.
      if (permission === 'clipboard-sanitized-write') return true;
      if (permission === 'media') {
        const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
        return types.length > 0 && types.every((type) => type === 'audio');
      }
      return false;
    };
    consoleSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = details?.requestingUrl || webContents.getURL();
      const allowed = allowedPermission(permission, origin, details);
      if (allowed && permission === 'media' && MAC && systemPreferences.getMediaAccessStatus('microphone') !== 'granted')
        return systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
      callback(allowed);
    });
    consoleSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
      allowedPermission(permission, requestingOrigin, { mediaType: details?.mediaType }));
    consoleSession.setDevicePermissionHandler(() => false);
    consoleSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));

    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event) => event.preventDefault());
      // The window shows the console and nothing else: any other page opens in the
      // system browser. Frames inside the console (previews, artifacts) may load anything.
      const guard = (event) => {
        if (!event.isMainFrame || fromConsole(event.url)) return;
        event.preventDefault();
        openExternal(event.url);
      };
      contents.on('will-navigate', guard);
      contents.on('will-redirect', guard);
      contents.setWindowOpenHandler(({ url }) => {
        if (fromConsole(url) || url === 'about:blank' || url.startsWith(`blob:${ORIGIN}/`))
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, ...(LINUX ? { icon: path.join(ASSETS, 'icon.png') } : {}) } };
        openExternal(url);
        return { action: 'deny' };
      });
      contents.on('context-menu', (_event, params) => contextMenu(contents, params));
    });

    // ── the window ──
    const createWindow = (initialPath) => {
      const bounds = settings.get('bounds', {});
      win = new BrowserWindow({
        width: bounds.width || 1280, height: bounds.height || 840,
        ...(Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? { x: bounds.x, y: bounds.y } : {}),
        minWidth: 380, minHeight: 480, show: false, title: 'tavya', autoHideMenuBar: true,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#14101a' : '#ffffff',
        ...(LINUX ? { icon: path.join(ASSETS, 'icon.png') } : {}),
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
          navigateOnDragDrop: false, spellcheck: true, safeDialogs: true,
        },
      });
      if (bounds.maximized) win.maximize();
      const startHidden = launchAtLogin.openedAtLogin() && !initialPath;
      win.once('ready-to-show', () => { if (!startHidden) win.show(); });
      let saveTimer = null;
      const saveBounds = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
          settings.set('bounds', { ...(win.isMaximized() ? settings.get('bounds', {}) : win.getBounds()), maximized: win.isMaximized() });
        }, 500);
      };
      win.on('resize', saveBounds);
      win.on('move', saveBounds);
      win.on('close', (event) => {
        if (quitting) return;
        event.preventDefault();
        win.hide();
      });
      const contents = win.webContents;
      contents.on('did-navigate', () => bridge.reset(contents));
      contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        if (!isMainFrame || code === -3 /* aborted */ || !fromConsole(url)) return;
        log('could not load', url, code, description);
        win.loadFile(path.join(__dirname, 'offline.html'), { query: { url } });
      });
      contents.on('render-process-gone', (_event, details) => {
        log('renderer gone', details.reason);
        if (details.reason !== 'clean-exit') setTimeout(() => !win.isDestroyed() && win.loadURL(server.url), 1000);
      });
      win.loadURL(initialPath ? `${ORIGIN}${initialPath}` : server.url);
    };

    // ── the For-me count: tray, dock, launcher ──
    const trayImage = (dot) => {
      if (MAC) {
        const image = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
        image.setTemplateImage(true);
        return image;
      }
      return nativeImage.createFromPath(path.join(ASSETS, dot ? 'tray-dot.png' : 'tray.png'));
    };
    function setBadge(count) {
      const next = Math.max(0, Math.min(99_999, Math.floor(Number(count) || 0)));
      if (next === forMe && tray) return;
      const dotChanged = (next > 0) !== (forMe > 0);
      forMe = next;
      if (MAC) {
        app.dock?.setBadge(forMe ? String(forMe) : '');
        tray?.setTitle(forMe ? String(forMe) : '', { fontType: 'monospacedDigit' });
      } else {
        app.setBadgeCount(forMe);
        if (dotChanged) tray?.setImage(trayImage(forMe > 0));
      }
      tray?.setToolTip(forMe ? `tavya · ${forMe} for you` : 'tavya');
      refreshMenus();
    }

    // ── shortcut, launch at login, updates ──
    const hotkey = new Hotkey({ globalShortcut, platform: process.platform, portal: LINUX, onPress: () => openTarget({ path: null, url: null, ask: true }) });
    const hotkeyStatus = hotkey.set(settings.get('hotkey', defaultAccelerator()));
    if (!hotkeyStatus.registered && hotkeyStatus.reason && settings.get('hotkeyWarned') !== hotkeyStatus.accelerator) {
      // Say it once per shortcut, plainly; Profile shows it for as long as it lasts.
      settings.set('hotkeyWarned', hotkeyStatus.accelerator);
      notify('Ask shortcut unavailable', hotkeyStatus.reason);
    }
    const packageType = (() => { try { return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim(); } catch { return null; } })();
    let autoUpdater = null;
    const kind = updateKind({ packaged: app.isPackaged, packageType });
    if (kind !== 'none') ({ autoUpdater } = require('electron-updater'));
    const updates = new Updates({
      autoUpdater, kind, origin: ORIGIN, current: app.getVersion(), log,
      onStatus: (status) => {
        bridge.emit(win?.webContents, 'TavyaDesktop', 'updateStatus', status);
        refreshMenus();
        if (manualCheck && ['none', 'error', 'available', 'ready'].includes(status.state)) {
          manualCheck = false;
          if (status.state === 'none') notify('tavya is up to date', `Version ${status.current}`);
          else if (status.state === 'error') notify('Couldn’t check for updates', status.error);
          else if (status.state === 'available') notify(`tavya ${status.version} is available`, 'Download it from the tavya menu.');
        }
        if (status.state === 'ready') notify(`tavya ${status.version} is ready`, 'Restart tavya to update.');
      },
    });
    updates.start();

    // ── the bridge's plugins (contract 1) ──
    bridge.register('TavyaSignIn', {
      methods: {
        open: async ({ url }) => {
          signIn?.cancel();
          const attempt = loopbackSignIn(url, { origin: ORIGIN, openExternal: (href) => shell.openExternal(href), onReturn: () => showWindow() });
          signIn = attempt;
          try { return await attempt.promise; } finally { if (signIn === attempt) signIn = null; }
        },
        // Offered only where the OS keychain can hold it, so the console never asks for a token nobody can keep.
        ...(deviceToken.secure() ? { saveDeviceToken: async ({ token }) => { await deviceToken.save(token); } } : {}),
        clearDeviceToken: async () => { await deviceToken.clear(); },
      },
    });
    bridge.register('TavyaDesktop', {
      methods: {
        show: async () => { showWindow(); },
        setBadge: async ({ count }) => { setBadge(count); },
        getHotkey: async () => hotkey.status(),
        setHotkey: async ({ accelerator }) => {
          // A valid shortcut is kept even when it can't register now (it is retried at the next start);
          // an invalid one changes nothing.
          const status = hotkey.set(accelerator ?? '');
          settings.set('hotkey', hotkey.accelerator);
          refreshMenus();
          return status;
        },
        getLaunchAtLogin: async () => ({ enabled: launchAtLogin.get() }),
        setLaunchAtLogin: async ({ enabled }) => { const now = launchAtLogin.set(!!enabled); refreshMenus(); return { enabled: now }; },
        getUpdateStatus: async () => updates.status(),
        checkForUpdates: async () => updates.check(),
        installUpdate: async () => { quitting = true; if (!updates.install()) quitting = false; },
      },
      events: ['open', 'updateStatus'],
      onListen: (eventName, contents) => { if (eventName === 'open') flushPendingOpen(contents); },
    });
    bridge.register('TavyaOfflineFiles', offlineFilesPlugin({ app, origin: ORIGIN }));

    // ── menus ──
    function trayMenu() {
      const status = updates.status();
      const update = {
        idle: { label: 'Check for updates…', click: () => { manualCheck = true; updates.check(); } },
        none: { label: 'Check for updates…', click: () => { manualCheck = true; updates.check(); } },
        error: { label: 'Check for updates…', click: () => { manualCheck = true; updates.check(); } },
        checking: { label: 'Checking for updates…', enabled: false },
        downloading: { label: status.percent ? `Downloading update… ${status.percent}%` : 'Downloading update…', enabled: false },
        ready: { label: `Restart to update to ${status.version}`, click: () => { quitting = true; updates.install(); } },
        available: { label: `Download tavya ${status.version}…`, click: () => openExternal(status.url) },
      }[status.state];
      const shortcut = hotkey.status();
      return Menu.buildFromTemplate([
        { label: 'Open tavya', click: () => showWindow() },
        { label: 'Ask tavya', ...(shortcut.registered ? { accelerator: shortcut.accelerator, registerAccelerator: false } : {}),
          click: () => openTarget({ path: null, url: null, ask: true }) },
        { label: forMe ? `For me (${forMe})` : 'For me', click: () => openTarget({ path: '/', url: null, ask: false }) },
        { type: 'separator' },
        { label: 'Launch at login', type: 'checkbox', checked: launchAtLogin.get(), click: (item) => { launchAtLogin.set(item.checked); refreshMenus(); } },
        ...(update ? [update] : []),
        { type: 'separator' },
        { label: 'Quit tavya', accelerator: MAC ? 'Command+Q' : 'Control+Q', registerAccelerator: false, click: () => { quitting = true; app.quit(); } },
      ]);
    }
    function appMenu() {
      return Menu.buildFromTemplate([
        ...(MAC ? [{ role: 'appMenu' }] : [{ label: 'File', submenu: [{ label: 'Close Window', accelerator: 'Control+W', click: () => win?.hide() },
          { label: 'Quit', accelerator: 'Control+Q', click: () => { quitting = true; app.quit(); } }] }]),
        { role: 'editMenu' },
        { label: 'View', submenu: [
          { label: 'Back', accelerator: MAC ? 'Command+[' : 'Alt+Left', click: () => win?.webContents.navigationHistory.goBack() },
          { label: 'Forward', accelerator: MAC ? 'Command+]' : 'Alt+Right', click: () => win?.webContents.navigationHistory.goForward() },
          { type: 'separator' },
          { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
        ] },
        { role: 'windowMenu' },
      ]);
    }
    function refreshMenus() { tray?.setContextMenu(trayMenu()); }

    function contextMenu(contents, params) {
      const items = [];
      for (const suggestion of params.dictionarySuggestions || []) items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      if (params.misspelledWord) items.push({ label: 'Add to dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
      if (params.linkURL && /^(https?|mailto):/.test(params.linkURL)) items.push({ label: 'Open link in browser', click: () => openExternal(params.linkURL) },
        { label: 'Copy link', click: () => require('electron').clipboard.writeText(params.linkURL) }, { type: 'separator' });
      const can = params.editFlags || {};
      if (params.isEditable) items.push({ role: 'cut', enabled: can.canCut }, { role: 'copy', enabled: can.canCopy }, { role: 'paste', enabled: can.canPaste }, { type: 'separator' }, { role: 'selectAll' });
      else if (params.selectionText) items.push({ role: 'copy' });
      while (items.length && items.at(-1).type === 'separator') items.pop();
      if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) || undefined });
    }

    Menu.setApplicationMenu(appMenu());
    tray = new Tray(trayImage(false));
    tray.setToolTip('tavya');
    if (!MAC) tray.on('click', () => showWindow());
    refreshMenus();
    // Started by a link (or a Mac open-url before ready): open that page; Ask waits for the console to listen.
    const initial = startTarget || pendingOpen?.target;
    pendingOpen = initial?.ask ? { target: { ...initial, path: null }, at: Date.now() } : null;
    createWindow(initial?.path);
    // What the tray and menus show, for diagnostics and tests (main process only; pages can't reach it).
    globalThis.tavyaDesktop = {
      tray: () => ({ tooltip: forMe ? `tavya · ${forMe} for you` : 'tavya', forMe, items: trayMenu().items.map((item) => item.label || item.type) }),
      hotkey: () => hotkey.status(),
      deviceToken: () => ({ secure: deviceToken.secure(), saved: deviceToken.has() }),
      updates: () => updates.status(),
      window: () => win,
    };
  });

  function showWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (MAC) app.focus({ steal: true });
  }

  /** Open a console page or Ask: in place through the console's listener, else once it listens. */
  function openTarget(target) {
    if (!win) { pendingOpen = { target, at: Date.now() }; return; }
    showWindow();
    const contents = win?.webContents;
    if (!contents) return;
    if (!fromConsole(contents.getURL())) {
      // The offline page, or still loading: load the page asked for; Ask waits for the listener.
      if (target.path) win.loadURL(`${ORIGIN}${target.path}`);
      if (target.ask) pendingOpen = { target: { ...target, path: null }, at: Date.now() };
      return;
    }
    if (!bridge.emit(contents, 'TavyaDesktop', 'open', target)) pendingOpen = { target, at: Date.now() };
  }
  function flushPendingOpen(contents) {
    if (!pendingOpen) return;
    const { target, at } = pendingOpen;
    pendingOpen = null;
    if (Date.now() - at < PENDING_OPEN_MS) bridge.emit(contents, 'TavyaDesktop', 'open', target);
  }
}

/** Only web and mail links leave the app, to the system's handler. */
function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (['https:', 'http:', 'mailto:'].includes(protocol)) shell.openExternal(url).catch((error) => log('open external', error.message));
  } catch { /* not a URL */ }
}

function notify(title, body) {
  if (!Notification.isSupported()) return log(title, body);
  new Notification({ title, body, silent: true }).show();
}
