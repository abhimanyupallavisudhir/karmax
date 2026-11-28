// Which tavya the app opens, and the few facts every other module derives from
// it. The window loads the hosted console; nothing from web/ is bundled.
//
// The URL comes from, in order: the TAVYA_URL environment variable (a
// developer pointing a build at a local gateway), app-config.json written into
// the package at build time (scripts/configure.cjs, so a self-hoster ships
// their own server), then https://tavya.io. The rules are mobile/
// capacitor.config.ts's: https, or plain http only for a server on this
// machine or the local network.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://tavya.io';
const SCHEME = 'io.tavya.app';

function isLocalDevHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1') return true;
  if (host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(host)) return true; // link-local, ULA
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT range used by Tailscale
  );
}

/** The console's URL and origin, or an Error saying what is wrong with `raw`. */
function resolveServer(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw).trim());
  } catch {
    throw new Error(`TAVYA_URL must be an absolute URL, got "${raw}"`);
  }
  if (parsed.username || parsed.password) throw new Error('TAVYA_URL must not contain credentials');
  if (parsed.protocol === 'http:') {
    if (!isLocalDevHost(parsed.hostname))
      throw new Error(`TAVYA_URL must use https (got ${parsed.origin}); http is only allowed for a loopback or LAN development server`);
  } else if (parsed.protocol !== 'https:') {
    throw new Error(`TAVYA_URL must be an https URL, got "${raw}"`);
  }
  const bare = parsed.pathname === '/' && !parsed.search && !parsed.hash;
  return { url: bare ? parsed.origin : parsed.href, origin: parsed.origin };
}

/** The packaged app-config.json, if the build wrote one. */
function bakedConfig(dir = __dirname) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '..', 'app-config.json'), 'utf8')); } catch { return {}; }
}

function serverFromEnvironment(env = process.env, baked = bakedConfig()) {
  return resolveServer(env.TAVYA_URL || baked.url || DEFAULT_URL);
}

module.exports = { DEFAULT_URL, SCHEME, isLocalDevHost, resolveServer, bakedConfig, serverFromEnvironment };
