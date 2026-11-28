// The global "Ask tavya" shortcut: from any app, it shows the window with Ask
// open. ⌥⌘Space on a Mac, Ctrl+Alt+Space on Linux, changeable in Profile.
//
// X11 and macOS grant a free shortcut at once; one another app holds fails to
// register, and we say so. Wayland has no global keyboard grabs: apps ask the
// desktop through the GlobalShortcuts portal (main.cjs turns on Chromium's
// GlobalShortcutsPortal), which GNOME 48+ and KDE Plasma 6 offer and which may
// ask the person to confirm. Where the portal is missing, the shortcut only
// works while tavya is focused, so the app says that and offers the link a
// system shortcut can open instead (io.tavya.app://ask).
'use strict';

const MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta']);
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Enter|Return|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Escape|Esc|Plus|[)!@#$%^&*(:;'"<>?,./\\|`~=_[\]{}-]|num[0-9]|numdec|numadd|numsub|nummult|numdiv)$/i;

function defaultAccelerator(platform = process.platform) {
  return platform === 'darwin' ? 'Alt+Command+Space' : 'Control+Alt+Space';
}

function waylandSession(env = process.env) {
  return env.XDG_SESSION_TYPE === 'wayland' || (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11');
}

/** An Electron accelerator a global shortcut may use: one key and at least one modifier (F-keys may stand alone). */
function validAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return false;
  const parts = accelerator.split('+').map((part) => part.trim());
  // "Plus" names the + key; a trailing "+" splits into an empty part.
  if (parts.some((part) => !part)) return false;
  const key = parts.pop();
  if (!KEY.test(key) || MODIFIERS.has(key.toLowerCase())) return false;
  if (parts.some((part) => !MODIFIERS.has(part.toLowerCase()))) return false;
  if (new Set(parts.map((part) => part.toLowerCase())).size !== parts.length) return false;
  return parts.length > 0 || /^F\d+$/i.test(key);
}

/** A shortcut as people read it on this platform: ⌥⌘Space, Ctrl+Alt+Space. */
function displayAccelerator(accelerator, platform = process.platform) {
  if (!accelerator) return '';
  const mac = platform === 'darwin';
  const names = mac
    ? { command: '⌘', cmd: '⌘', commandorcontrol: '⌘', cmdorctrl: '⌘', control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧', super: '⌘', meta: '⌘' }
    : { command: 'Super', cmd: 'Super', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super' };
  const parts = accelerator.split('+');
  const key = parts.pop();
  const mods = parts.map((part) => names[part.toLowerCase()] || part);
  return mac ? `${mods.join('')}${key}` : [...mods, key].join('+');
}

class Hotkey {
  /**
   * @param {{globalShortcut: Electron.GlobalShortcut, onPress: () => void, platform?: string, env?: NodeJS.ProcessEnv,
   *          portal?: boolean}} options  portal: the GlobalShortcuts portal feature is on (Wayland)
   */
  constructor({ globalShortcut, onPress, platform = process.platform, env = process.env, portal = false }) {
    Object.assign(this, { globalShortcut, onPress, platform, env, portal });
    this.accelerator = '';
    this.registered = false;
    this.reason = '';
  }

  status() {
    return { accelerator: this.accelerator, registered: this.registered, ...(this.reason ? { reason: this.reason } : {}),
      label: displayAccelerator(this.accelerator, this.platform), default: defaultAccelerator(this.platform) };
  }

  /** Register `accelerator` (empty: none). A shortcut that fails keeps nothing registered and says why. */
  set(accelerator) {
    const wanted = typeof accelerator === 'string' ? accelerator.trim() : '';
    if (wanted && !validAccelerator(wanted)) {
      // Keep what works; tell the caller what was wrong with the new one.
      return { ...this.status(), registered: this.registered, reason: `${wanted} isn't a shortcut tavya can use. Use a key with Ctrl, Alt, Shift${this.platform === 'darwin' ? ' or ⌘' : ' or Super'}.` };
    }
    if (this.accelerator && this.registered) this.globalShortcut.unregister(this.accelerator);
    this.accelerator = wanted;
    this.registered = false;
    this.reason = '';
    if (!wanted) return this.status();
    let ok = false;
    try { ok = this.globalShortcut.register(wanted, () => this.onPress()); } catch { ok = false; }
    this.registered = ok;
    const shown = displayAccelerator(wanted, this.platform);
    if (!ok) {
      this.reason = waylandSession(this.env)
        ? `Your desktop didn't allow ${shown}. Set a shortcut in your system's keyboard settings that runs: xdg-open io.tavya.app://ask`
        : `${shown} is taken by another app. Choose another shortcut.`;
    } else if (waylandSession(this.env) && !this.portal) {
      this.registered = false;
      this.reason = `On Wayland, ${shown} works only while tavya is in front. For a system-wide shortcut, set one in your system's keyboard settings that runs: xdg-open io.tavya.app://ask`;
    }
    return this.status();
  }

  dispose() { if (this.accelerator && this.registered) this.globalShortcut.unregister(this.accelerator); }
}

module.exports = { Hotkey, defaultAccelerator, displayAccelerator, validAccelerator, waylandSession };
