// The app's device token (wiki planned/native-apps-round-2, contract 3): a
// refresh token tvr_<grant>.<secret> of the desktop's `app` grant, handed over once by the
// console at sign-in (TavyaSignIn.saveDeviceToken) for native surfaces that
// run without the window (the tray, later). It is encrypted with the OS
// keychain (Electron safeStorage: Keychain on a Mac, libsecret/KWallet on
// Linux) and never stored in plain text: without a keychain it is not kept.
//
// The token rotates on every use and presenting an old one revokes the grant
// (signing the app out), so refreshes are strictly one at a time, here in
// main, and the new token is saved before the access token is used.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_ID = 'tavya-desktop';

class DeviceToken {
  /** @param {{dir: string, safeStorage: Electron.SafeStorage, origin: string, fetch?: typeof fetch, platform?: string}} options */
  constructor({ dir, safeStorage, origin, fetch: fetcher = globalThis.fetch, platform = process.platform }) {
    Object.assign(this, { safeStorage, origin, fetcher, platform });
    this.file = path.join(dir, 'device-token.bin');
    this.queue = Promise.resolve();
    this.access = null; // {token, expiresAt}
  }

  /** Whether the OS can keep a secret for us (not Chromium's plain-text fallback). */
  secure() {
    if (!this.safeStorage.isEncryptionAvailable()) return false;
    if (this.platform === 'linux' && typeof this.safeStorage.getSelectedStorageBackend === 'function')
      return !['basic_text', 'unknown'].includes(this.safeStorage.getSelectedStorageBackend());
    return true;
  }

  has() { return fs.existsSync(this.file); }

  /** One operation at a time, in order. */
  serial(run) {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  save(token) {
    return this.serial(async () => {
      if (typeof token !== 'string' || !/^tvr_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,}$/.test(token)) throw { code: 'invalid', message: 'Not a device token.' };
      this.access = null;
      if (!this.secure()) { this.removeFile(); return false; }
      this.write(token);
      return true;
    });
  }

  clear() { return this.serial(async () => { this.access = null; this.removeFile(); }); }

  /** A current access token (tva_…), refreshing the device token when needed; null when signed out. */
  accessToken() {
    return this.serial(async () => {
      if (this.access && this.access.expiresAt - 60_000 > Date.now()) return this.access.token;
      const refresh = this.read();
      if (!refresh) return null;
      const response = await this.fetcher(`${this.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }).toString(),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // The grant is gone (revoked, signed out, or the token was replayed): forget it.
        if (body?.error === 'invalid_grant' || response.status === 401) { this.access = null; this.removeFile(); return null; }
        throw new Error(body?.error_description || `token refresh failed (HTTP ${response.status})`);
      }
      if (typeof body.refresh_token === 'string') this.write(body.refresh_token);
      this.access = { token: body.access_token, expiresAt: Date.now() + Math.max(0, Number(body.expires_in) || 0) * 1000 };
      return this.access.token;
    });
  }

  read() {
    try { return this.safeStorage.decryptString(fs.readFileSync(this.file)); } catch { return null; }
  }
  write(token) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, this.safeStorage.encryptString(token), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  removeFile() { fs.rmSync(this.file, { force: true }); }
}

module.exports = { DeviceToken, CLIENT_ID };
