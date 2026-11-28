// An AppImage is a single file nobody installed, so nothing tells the desktop
// it handles io.tavya.app:// links or puts it in the app menu. At start the
// AppImage writes its own entry under ~/.local/share/applications (pointing at
// wherever the file is now) and claims the link scheme, the way AppImageLauncher
// would. Skipped when the .deb is installed: its entry already does this.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { SCHEME } = require('./config.cjs');

// The same name as the .deb's entry and Electron's app_id (package.json desktopName), so the desktop ties the window to it.
const ENTRY = 'tavya.desktop';

function appImageEntry({ appImage, icon }) {
  const exec = `"${appImage.replace(/(["`$\\])/g, '\\$1')}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=tavya',
    'Comment=Do anything with agents',
    `Exec=${exec} %U`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Office;Utility;',
    `MimeType=x-scheme-handler/${SCHEME};`,
    'StartupWMClass=tavya',
    'X-AppImage-Integrate=false',
    '',
  ].join('\n');
}

function integrateAppImage({ appImage, iconSource, env = process.env, run = execFile }) {
  if (fs.existsSync('/usr/share/applications/tavya.desktop')) return false;
  const data = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const icon = path.join(data, 'icons', 'hicolor', '256x256', 'apps', 'io.tavya.app.png');
  const file = path.join(data, 'applications', ENTRY);
  const text = appImageEntry({ appImage, icon });
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch {}
  if (current === text) return false;
  fs.mkdirSync(path.dirname(icon), { recursive: true });
  fs.copyFileSync(iconSource, icon);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const quiet = () => {};
  run('xdg-mime', ['default', ENTRY, `x-scheme-handler/${SCHEME}`], quiet);
  run('update-desktop-database', [path.dirname(file)], quiet);
  return true;
}

module.exports = { appImageEntry, integrateAppImage };
