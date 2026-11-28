// Packaging (electron-builder): a universal DMG (+ the zip Squirrel.Mac
// updates from) for Macs, AppImage and .deb for x64 and arm64 Linux.
// .github/workflows/desktop.yml runs it; desktop/README.md lists the secrets.
//
// Signing and notarizing are driven by the environment, so an unsigned build
// needs nothing: CSC_LINK/CSC_KEY_PASSWORD (the Developer ID Application
// certificate) sign; APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER (or
// APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID) notarize with notarytool.
// Universal links (Associated Domains) are a restricted entitlement: they need
// a Developer ID provisioning profile (MAC_PROVISIONING_PROFILE, a path) and
// APPLE_TEAM_ID, and are left out without them, or macOS would refuse to start the app.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bakedConfig, DEFAULT_URL } = require('./src/config.cjs');

const APP_ID = 'io.tavya.app';
const host = new URL(bakedConfig(path.join(__dirname, 'src')).url || DEFAULT_URL).hostname;
const profile = process.env.MAC_PROVISIONING_PROFILE;
const team = process.env.APPLE_TEAM_ID;

function entitlements() {
  const base = path.join(__dirname, 'build', 'entitlements.mac.plist');
  if (!profile || !team) return base;
  const extra = `  <key>com.apple.application-identifier</key>\n  <string>${team}.${APP_ID}</string>\n`
    + `  <key>com.apple.developer.team-identifier</key>\n  <string>${team}</string>\n`
    + `  <key>com.apple.developer.associated-domains</key>\n  <array>\n    <string>applinks:${host}</string>\n  </array>\n`;
  const file = path.join(os.tmpdir(), 'tavya-entitlements.mac.links.plist');
  fs.writeFileSync(file, fs.readFileSync(base, 'utf8').replace('</dict>', `${extra}</dict>`));
  return file;
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: APP_ID,
  productName: 'tavya',
  copyright: 'Copyright © tavya',
  directories: { output: 'dist', buildResources: 'build' },
  files: ['package.json', 'app-config.json', 'src/**/*', '!**/*.test.cjs'],
  protocols: [{ name: 'tavya', schemes: [APP_ID] }],
  // Hardening (Electron fuses): the packaged app is never a plain Node, takes no
  // NODE_OPTIONS or --inspect, loads only its own (on a Mac, integrity-checked)
  // app.asar, and encrypts its cookie store with the OS keychain. Tests drive
  // the unpackaged app (tests/desktop-app.electron.test.ts) for that reason.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  // The app re-points the feed at its own console (<origin>/download/desktop/); this is the default.
  publish: [{ provider: 'generic', url: 'https://tavya.io/download/desktop/' }],
  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon-mac.png',
    // The DMG is what people download; the zip is what Squirrel.Mac updates from.
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    artifactName: 'tavya-${version}-universal-mac.${ext}',
    // Electron 45 runs on macOS 12 and later.
    minimumSystemVersion: '12.0',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: entitlements(),
    entitlementsInherit: path.join(__dirname, 'build', 'entitlements.mac.plist'),
    ...(profile && team ? { provisioningProfile: profile } : {}),
    extendInfo: { NSMicrophoneUsageDescription: 'tavya uses the microphone while you dictate.' },
  },
  dmg: { artifactName: 'tavya-${version}-universal.${ext}' },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64', 'arm64'] }, { target: 'deb', arch: ['x64', 'arm64'] }],
    icon: 'build/icons',
    executableName: 'tavya',
    // The installed entry is named after package.json's desktopName (tavya.desktop), which is also the
    // window's app_id / WM_CLASS, so docks and task bars group the window with its entry and icon.
    syncDesktopName: true,
    category: 'Office',
    synopsis: 'Do anything with agents',
    description: 'tavya in its own window: a tray with what is for you, a global Ask shortcut and notifications.',
    maintainer: 'tavya <hello@tavya.io>',
    vendor: 'tavya',
    desktop: { entry: { StartupWMClass: 'tavya', Comment: 'Do anything with agents', Keywords: 'agents;tasks;ai;' } },
  },
  appImage: { artifactName: 'tavya-${version}-${arch}.${ext}' },
  deb: { artifactName: 'tavya_${version}_${arch}.${ext}' },
};
