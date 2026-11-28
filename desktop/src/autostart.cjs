// Launch at login, off until the person turns it on (tray menu or Profile).
// A Mac uses the system's login items (SMAppService); Linux has no API for it,
// so the app writes an XDG autostart entry (~/.config/autostart), which GNOME,
// KDE, Xfce and the rest read. Started at login, the app waits in the tray.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HIDDEN_FLAG = '--hidden';
const ENTRY_NAME = 'io.tavya.app.desktop';

/** Quote one Exec argument per the Desktop Entry spec. */
function execArgument(value) {
  if (!/[\s"'\\$`<>|&;()*?#~=%]/.test(value)) return value;
  return `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
}

function autostartEntry({ exec, name = 'tavya' }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Exec=${execArgument(exec)} ${HIDDEN_FLAG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function autostartFile(env = process.env) {
  const config = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', ENTRY_NAME);
}

/** The executable a login should start: the AppImage itself, not its mount. */
function linuxExecutable(env = process.env, execPath = process.execPath) {
  return env.APPIMAGE || execPath;
}

function createLaunchAtLogin(app, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') {
    return {
      get: () => app.getLoginItemSettings().openAtLogin === true,
      set: (enabled) => { app.setLoginItemSettings({ openAtLogin: !!enabled }); return app.getLoginItemSettings().openAtLogin === true; },
      openedAtLogin: () => app.getLoginItemSettings().wasOpenedAtLogin === true || process.argv.includes(HIDDEN_FLAG),
    };
  }
  const file = autostartFile(env);
  return {
    get: () => fs.existsSync(file),
    set: (enabled) => {
      if (enabled) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, autostartEntry({ exec: linuxExecutable(env), name: app.getName() }));
      } else {
        fs.rmSync(file, { force: true });
      }
      return fs.existsSync(file);
    },
    openedAtLogin: () => process.argv.includes(HIDDEN_FLAG),
  };
}

module.exports = { HIDDEN_FLAG, autostartEntry, autostartFile, linuxExecutable, createLaunchAtLogin };
