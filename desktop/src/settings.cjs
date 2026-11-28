// The app's own preferences (the Ask shortcut, the window's place), in
// settings.json under Electron's userData folder. Written atomically.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    try { this.values = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { this.values = {}; }
  }
  get(key, fallback) { return Object.hasOwn(this.values, key) ? this.values[key] : fallback; }
  set(key, value) {
    if (value === undefined) delete this.values[key]; else this.values[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.values, null, 2));
    fs.renameSync(temporary, this.file);
  }
}

module.exports = { Settings };
