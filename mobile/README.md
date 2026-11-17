# tavya for Android and iOS

A thin [Capacitor 8](https://capacitorjs.com) shell (`io.tavya.app`). Its WebView loads the hosted console from `server.url`; nothing from `web/` is bundled. The shell adds what a browser tab can't do well:

- **Voice**: `Capacitor.Plugins.SpeechRecognition` (Android: `@capacitor-community/speech-recognition`; iOS: the Swift port in `ios/App/App/SpeechRecognitionPlugin.swift`, because that package has no Swift Package Manager support).
- **Push**: `Capacitor.Plugins.PushNotifications`, delivered through Firebase Cloud Messaging on both platforms (iOS gets APNs via FCM, so the token the app reports is an FCM token).
- **Sign-in in the system browser**: `Capacitor.Plugins.TavyaSignIn.open({ url, callbackScheme: 'io.tavya.app' })` resolves `{ url }` with the `io.tavya.app://signed-in?…` callback, or rejects with code `cancelled`. Android uses a Custom Tab (`TavyaSignInPlugin.java`); iOS uses `ASWebAuthenticationSession` (`TavyaSignInPlugin.swift`).

The console detects the app with `window.Capacitor?.isNativePlatform?.()` and the `tavya-app` user-agent suffix. If the server can't be reached, the app shows `www/offline.html` (`server.errorPath`).

## Which server

`TAVYA_URL` is read when `npx cap sync` runs and is built into the app (default `https://tavya.io`). It must be https, except for a development server on loopback or the local network (then cleartext http is allowed):

```sh
TAVYA_URL=https://tavya.example.com npx cap sync
TAVYA_URL=http://192.168.1.20:4173 npx cap sync android   # phone on the same Wi-Fi
```

## Build locally

```sh
cd mobile
npm ci
```

**Android** needs JDK 21 and the Android SDK (platform 36). Set `ANDROID_HOME` (or open `android/` in Android Studio).

```sh
npx cap sync android
cd android && ./gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
```

Without `android/app/google-services.json` the app builds and runs, but push is off.

**iOS** needs a Mac with Xcode 26.2 or later (Firebase 13 requires it). The project uses Swift Package Manager, so there is no `pod install` step.

```sh
npx cap sync ios
open ios/App/App.xcodeproj    # or:
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

Push on iOS needs `ios/App/App/Firebase/GoogleService-Info.plist` (git-ignored); without it, registration fails with "Push isn't set up in this build".

**Icons and splash screens** are made from `web/brand/royal-gold-arrow/icon.svg`: `node scripts/render-brand-assets.cjs` renders the sources in `assets/`, then `npm run assets` writes the native files.

## Releasing

`.github/workflows/mobile.yml` builds the debug APK on every change under `mobile/`, and the iOS simulator build when iOS files change. Run it by hand with **release** ticked to upload to Play internal testing and TestFlight. A release job whose secrets are missing is skipped with a notice. Version name/marketing version come from `version` in `package.json`; build numbers come from the run number.

| Secret | What it is and where it comes from |
| --- | --- |
| `ANDROID_GOOGLE_SERVICES_JSON` | base64 of `google-services.json`: Firebase console → Project settings → Your apps → Android app `io.tavya.app`. |
| `ANDROID_KEYSTORE_BASE64` | base64 of the upload keystore (`keytool -genkeypair -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`). Play App Signing holds the real app signing key. |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | The keystore password, key alias and key password chosen above. |
| `PLAY_SERVICE_ACCOUNT_JSON` | JSON key (plain text) of a Google Cloud service account: create it in Google Cloud → IAM → Service accounts, then invite its email in Play Console → Users and permissions with release rights for the app. |
| `APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API: the key's ID and the issuer ID. Use the Admin role, which cloud-managed distribution signing needs. |
| `APPSTORE_API_KEY_P8` | base64 of the `AuthKey_<ID>.p8` file downloaded when the key was created (downloadable once). |
| `APPLE_TEAM_ID` | Apple Developer → Membership details → Team ID. |
| `IOS_GOOGLE_SERVICE_INFO_PLIST` | base64 of `GoogleService-Info.plist`: Firebase console → iOS app `io.tavya.app`. Also upload an APNs auth key under Firebase → Cloud Messaging. |

Before the first automated release:

- **Play**: create the app in the Play Console and upload the first bundle by hand (Google requires it; the API can only add later releases). Until a release has been rolled out, run the workflow with `play_status: draft`.
- **App Store**: create the app record for bundle ID `io.tavya.app` in App Store Connect. Signing certificates and profiles are created by `xcodebuild -allowProvisioningUpdates` with the API key; the archive step signs for development first, which needs at least one device registered to the team.

Store listing text and App Review notes are in `store/`.
