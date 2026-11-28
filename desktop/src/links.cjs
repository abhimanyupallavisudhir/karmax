// Links into the app (wiki planned/native-apps-round-2, contract 6):
//   io.tavya.app://open?path=/<console path>   open a page of the console
//   io.tavya.app://ask                          open Ask (bind it to a key in
//                                               your desktop's own settings
//                                               where global shortcuts can't
//                                               be registered: xdg-open io.tavya.app://ask)
//   https://<console origin>/<path>             a universal link (Mac, signed builds)
// They arrive as `open-url` on a Mac and as a second instance's argv on Linux.
'use strict';
const { SCHEME } = require('./config.cjs');

/** A same-origin console path (pathname + search + hash), or null. */
function consolePath(raw, origin) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

/** What a link asks for: {path, url, ask}, or null when it is not one of ours. */
function linkTarget(raw, origin) {
  let url;
  try { url = new URL(String(raw)); } catch { return null; }
  if (url.protocol === `${SCHEME}:`) {
    // io.tavya.app://open?path=… parses with host "open"; tolerate io.tavya.app:open?… too.
    const action = (url.host || url.pathname.replace(/^\/+/, '')).toLowerCase().replace(/\/+$/, '');
    if (action === 'ask') return { path: null, url: url.href, ask: true };
    if (action !== 'open') return null;
    const path = consolePath(url.searchParams.get('path') || '/', origin);
    return path ? { path, url: url.href, ask: false } : null;
  }
  if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin)
    return { path: `${url.pathname}${url.search}${url.hash}`, url: url.href, ask: false };
  return null;
}

/** The link or flag a (second) instance was started with, from its argv. */
function argvTarget(argv, origin) {
  for (const arg of argv || []) {
    if (typeof arg !== 'string') continue;
    if (arg === '--ask') return { path: null, url: null, ask: true };
    if (arg.toLowerCase().startsWith(`${SCHEME}:`)) return linkTarget(arg, origin);
  }
  return null;
}

module.exports = { consolePath, linkTarget, argvTarget };
