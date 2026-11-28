// Updates through electron-updater's generic provider, fed by the console's
// own server: <console origin>/download/desktop/ (the gateway redirects to the
// newest desktop-v* GitHub release; src/gateway/desktop-downloads.ts). A Mac
// (signed builds only: Squirrel.Mac checks the signature) and an AppImage
// download in the background and install on restart; a .deb only says an
// update is available and links the new .deb, since replacing a package needs
// the system's package manager and an administrator.
'use strict';

const CHECK_EVERY_MS = 4 * 60 * 60_000;
const FIRST_CHECK_AFTER_MS = 15_000;

/** How this copy can update itself: 'self', 'link' (a .deb) or 'none' (unpackaged, rpm, …). */
function updateKind({ packaged, platform = process.platform, env = process.env, packageType = null }) {
  if (!packaged) return 'none';
  if (platform === 'darwin') return 'self';
  if (platform !== 'linux') return 'none';
  if (env.APPIMAGE) return 'self';
  if (packageType === 'deb') return 'link';
  return 'none';
}

/** The stable download address of this platform's newest .deb. */
function debDownloadUrl(origin, arch = process.arch) {
  return `${origin}/download/desktop/tavya-linux-${arch === 'arm64' ? 'arm64' : 'x64'}.deb`;
}

function feedUrl(origin) { return `${origin}/download/desktop/`; }

/** A missing feed (no release yet, or a server without the route) is "up to date", not an error. */
function noRelease(error) {
  const text = String(error?.message || error || '');
  return /\b404\b|Cannot find (?:channel|latest)|No published versions/i.test(text);
}

class Updates {
  /**
   * @param {{autoUpdater: any, kind: string, origin: string, current: string, arch?: string, onStatus?: (status: object) => void, log?: (...args: any[]) => void}} options
   */
  constructor({ autoUpdater, kind, origin, current, arch = process.arch, onStatus = () => {}, log = () => {} }) {
    Object.assign(this, { autoUpdater, kind, origin, current, arch, onStatus, log });
    this.state = kind === 'none' ? { state: 'unsupported', current } : { state: 'idle', current };
    this.timer = null;
    if (kind === 'none' || !autoUpdater) return;
    autoUpdater.logger = null;
    autoUpdater.autoDownload = kind === 'self';
    autoUpdater.autoInstallOnAppQuit = kind === 'self';
    autoUpdater.allowPrerelease = false;
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl(origin) });
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }));
    autoUpdater.on('update-available', (info) => this.set(kind === 'link'
      ? { state: 'available', version: info?.version, url: debDownloadUrl(origin, arch) }
      : { state: 'downloading', version: info?.version }));
    autoUpdater.on('download-progress', (progress) => this.set({ state: 'downloading', version: this.state.version, percent: Math.round(progress?.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info?.version }));
    autoUpdater.on('error', (error) => {
      log('update error', error?.message || error);
      this.set(noRelease(error) ? { state: 'none' } : { state: 'error', error: 'Couldn’t check for updates. Try again later.' });
    });
  }

  set(next) {
    // Once downloaded, stay ready: a later check must not hide the restart.
    if (this.state.state === 'ready' && next.state !== 'ready') return;
    this.state = { ...next, current: this.current };
    this.onStatus(this.status());
  }

  status() { return { ...this.state }; }

  async check() {
    if (this.kind === 'none' || this.state.state === 'ready') return this.status();
    if (this.state.state === 'checking' || this.state.state === 'downloading') return this.status();
    try { await this.autoUpdater.checkForUpdates(); }
    catch (error) { if (this.state.state === 'checking') this.set(noRelease(error) ? { state: 'none' } : { state: 'error', error: 'Couldn’t check for updates. Try again later.' }); }
    return this.status();
  }

  start() {
    if (this.kind === 'none') return;
    const first = setTimeout(() => this.check(), FIRST_CHECK_AFTER_MS);
    first.unref?.();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  /** Quit and install a downloaded update (Mac, AppImage). */
  install() {
    if (this.state.state !== 'ready') return false;
    this.autoUpdater.quitAndInstall(false, true);
    return true;
  }
}

module.exports = { Updates, updateKind, debDownloadUrl, feedUrl, noRelease };
