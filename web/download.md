# Download tavya

tavya in its own window on your Mac or Linux computer: what's for you in the menu bar, Ask from any app with one shortcut, notifications, dictation, and project files kept offline. It keeps itself up to date.

## Mac

[Download for Mac](/download/desktop/tavya-mac.dmg) — Apple silicon and Intel, macOS 12 or later.

## Linux

| | x64 | ARM64 |
| --- | --- | --- |
| AppImage (any distribution) | [Download](/download/desktop/tavya-linux-x64.AppImage) | [Download](/download/desktop/tavya-linux-arm64.AppImage) |
| .deb (Debian, Ubuntu) | [Download](/download/desktop/tavya-linux-x64.deb) | [Download](/download/desktop/tavya-linux-arm64.deb) |

Install the .deb with `sudo apt install ./tavya_*.deb`. On Ubuntu 24.04 and later prefer it to the AppImage: Ubuntu lets only installed apps use the sandbox Chromium protects web pages with, so the AppImage turns it off there. Make the AppImage executable (`chmod +x tavya-*.AppImage`) and open it; it needs FUSE 2 (`sudo apt install libfuse2t64`, or `libfuse2` before Ubuntu 24.04).

## Using it

- **Ask from anywhere**: ⌥⌘Space on a Mac, Ctrl+Alt+Space on Linux. Change it in Profile.
- **Closing the window** keeps tavya in the menu bar or tray, so notifications still arrive. Quit it from there.
- **Sign in** happens in your browser, so Google, GitHub and passkeys work as usual.

The apps are [open source](https://github.com/abhimanyupallavisudhir/karmax/tree/master/desktop), like the rest of tavya.
