# tavya for Mac and Linux

An [Electron](https://www.electronjs.org) shell (`io.tavya.app`) whose window loads the hosted console; nothing from `web/` is bundled, so a console deploy changes the app without a release. It adds what a browser tab can't do (wiki `features/desktop-apps`):

- **Tray / menu bar** with the For-me count (Mac: next to the icon and on the Dock; Linux: a dot on the icon, the count in its tooltip and on launchers that show badges). Menu: Open, Ask tavya, For me, Launch at login, Check for updates, Quit. Closing the window keeps tavya running there.
- **Ask from anywhere**: ⌥⌘Space (Mac) / Ctrl+Alt+Space (Linux), changed in Profile. On Wayland it goes through the desktop's GlobalShortcuts portal; where there is none, bind a system shortcut to `xdg-open io.tavya.app://ask`.
- **Links**: `io.tavya.app://open?path=/<console path>` and `io.tavya.app://ask`; on a signed Mac build with a provisioning profile, https links to the console too (universal links).
- **Sign-in in the system browser** (client `tavya-desktop`, a one-shot loopback redirect on `127.0.0.1`), so Google, GitHub and passkeys work.
- **Launch at login** (off until turned on), **notifications** (the console's `Notification`s, shown natively), **updates** (Mac and AppImage update themselves; a `.deb` shows the new version and links it).

The console finds the app through `window.Capacitor` (`getPlatform() === 'electron'`), the same bridge the phone apps use: `src/preload.cjs` exposes the plugins `src/main.cjs` registers (`TavyaSignIn`, `TavyaDesktop`, later `TavyaOfflineFiles` from `src/plugins/offline-files.cjs`), and main answers only the console's own origin.

## Which server

The app opens `https://tavya.io` unless told otherwise. `TAVYA_URL` (https, or plain http only for a server on this machine or the local network) chooses another, at build time (baked into `app-config.json`) or at run time:

```sh
TAVYA_URL=https://tavya.example.com npm run dist:linux   # a build for your own server
TAVYA_URL=http://127.0.0.1:4173 npm start                # this source against a local gateway
```

## Develop and test

```sh
cd desktop
npm ci
npm start            # Electron on this source
npm test             # unit tests of the main-process modules (node --test)
npm run icons        # re-render the icons from web/brand/royal-gold-arrow/icon.svg
```

The app itself is driven end to end by `tests/desktop-app.electron.test.ts` at the repository root (Playwright's Electron support against a local hosted gateway). It needs `desktop/node_modules` and a display, so on Linux: `xvfb-run -a npx vitest run tests/desktop-app.electron.test.ts` (from the root, after the root `npm ci`). Elsewhere it skips.

## Build

```sh
npm run dist:linux   # dist/tavya-<v>-{x86_64,arm64}.AppImage, dist/tavya_<v>_{amd64,arm64}.deb, latest-linux*.yml
npm run dist:mac     # on a Mac: dist/tavya-<v>-universal.dmg, the zip Squirrel.Mac updates from, latest-mac.yml
```

Packaged builds flip Electron's fuses (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`, app code only from `app.asar`, encrypted cookies); that is why the end-to-end test drives this source rather than a package.

## Releasing

`.github/workflows/desktop.yml` tests and builds the Linux packages on every change under `desktop/`, and the Mac app when Mac-specific files change (macOS minutes cost the most). To release: raise `version` in `package.json`, merge, then Actions → Desktop → Run workflow with **release** ticked. It creates GitHub release `desktop-v<version>` (never marked "latest", which stays the CLI's). `https://tavya.io/download/desktop/` serves it: stable download names (`tavya-mac.dmg`, `tavya-linux-{x64,arm64}.{AppImage,deb}`), the update feeds and `latest.json` for https://tavya.io/download. Linux files always publish; Mac files only when signed **and** notarized. Each signing step checks its secrets and skips with a notice naming the missing ones.

| Secret | What it is and where it comes from |
| --- | --- |
| `MAC_CERT_P12_BASE64` | base64 of a **Developer ID Application** certificate with its private key, exported from Keychain Access as .p12. Apple Developer → Certificates → + → Developer ID Application (the Account Holder creates it). |
| `MAC_CERT_PASSWORD` | The password chosen when exporting the .p12. |
| `APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID`, `APPSTORE_API_KEY_P8` | Notarization with notarytool through an App Store Connect API key: the same secrets as `mobile.yml`'s TestFlight upload (see `mobile/README.md`). |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | The alternative to the API key: an Apple ID with an app-specific password (appleid.apple.com → Sign-In and Security → App-Specific Passwords). Used only when the API key secrets are missing. |
| `MAC_PROVISIONING_PROFILE_BASE64` | Optional, for universal links: base64 of a **Developer ID** provisioning profile for App ID `io.tavya.app` with the Associated Domains capability (Apple Developer → Profiles → + → Developer ID). Needs `APPLE_TEAM_ID`. Without it, https links stay in the browser; `io.tavya.app://` links still open the app. |
| `APPLE_TEAM_ID` | Apple Developer → Membership details → Team ID (shared with `mobile.yml`). |

Universal links also need the console to list the app: Installation → Phone apps → Apple Team ID (served in `/.well-known/apple-app-site-association`).
