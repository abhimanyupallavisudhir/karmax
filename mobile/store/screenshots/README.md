# Store screenshots

Shot from the console against a test gateway holding **Harbor Studio**, an invented demo organization (`tests/helpers/demo-organization.ts`): invented people, projects, tasks and files, never a real organization's data. Re-shoot after a visible console change:

```
KARMAX_SHOTS=mobile/store/screenshots npx vitest run tests/store-screens.browser.test.ts
```

About a minute. It also writes `desktop/` and `contact-sheet.jpg` here (not tracked: for looking over) and `web/media/download/desktop-{light,dark}.webp` (the picture on tavya.io/download). Without `KARMAX_SHOTS` the same test walks every scene once at one size and checks it renders, so CI notices when a console change breaks a scene.

| Folder | Store slot | Size |
| --- | --- | --- |
| `ios/iphone-6.9/` | App Store, iPhone 6.9″ (required) | 1290×2796 |
| `ios/iphone-6.5/` | App Store, iPhone 6.5″ | 1242×2688 |
| `ios/ipad-13/` | App Store, iPad 13″ (required: the app runs on iPad) | 2064×2752 |
| `android/phone/` | Play, phone (9:16, eligible for Play's promoted spots) | 1080×1920 |
| `android/tablet-7/` | Play, 7-inch tablet | 1080×1920 |
| `android/tablet-10/` | Play, 10-inch tablet | 1440×2560 |
| `android/feature-graphic.png` | Play, feature graphic | 1024×500 |

Each set is the same six scenes, in upload order: For me, answering by voice, Review, Share to tavya, Ask (Siri on iOS; assistant, tile and widget on Android), Available offline. The captions are in `CAPTIONS` in the test; they say only what the app does (see `../listing.md`).
