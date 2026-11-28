# Privacy answers: Google Play Data safety and App Store App Privacy

Filled answers for both stores' forms, from what the apps do (checked against the code on 2026-11-28) and the Privacy Policy, version `2026-11-28.2` (https://tavya.io/legal/privacy § Phone apps, § Desktop app, § Dictation; `src/launch/legal.ts`). When an app starts collecting something new, change the policy, this page and the forms together. The desktop app is not in a store, so it has no form; the policy's Desktop app section covers it.

## What the apps send, in short

| What | Where it goes | Notes |
| --- | --- | --- |
| Account: name, email, account id | tavya | Sign-in happens in the system browser; the app gets a single-use code, never the password. |
| Tasks, messages, Ask questions, review decisions | tavya | What the person types or dictates. Siri's question (iOS) is the text Siri heard. |
| Speech | **Not to tavya** from the phone apps | iOS: Apple's speech recognition; Android: the phone's speech service (Google's on most phones). Either may process audio on the device or on Apple's/Google's servers; only the text reaches the app, and only what the person sends reaches tavya. The phone apps never use tavya's server dictation (`speechRecognitionClass` prefers the native plugin, always present in the apps). The desktop app and Firefox do: phrases go through tavya to OpenRouter (AssemblyAI, else Mistral; zero retention requested) and tavya stores no audio. |
| Files and photos | tavya, only when attached or shared to the app | Share to tavya copies them into the app's storage (iOS: the app group shared with the Share Extension) until the form opens, then uploads them as ordinary attachments; never-opened shares go after a day. The extension makes no network requests. A photo taken in "Attach files" is the same. |
| Available offline | **From** tavya to the device | Copies of project files the person chose, downloaded into the app's storage, excluded from backups (iOS `isExcludedFromBackup`; Android no-backup storage, and the app allows no backup at all), wiped at sign-out or another account. tavya is not told what is kept: the device sends only "has this changed?" for its pins. |
| Push token | tavya and Firebase Cloud Messaging (Google; APNs on iOS) | Only when "Push to this device" is on. Each notification's title, status line and console path go through Google (and Apple). Deleted when push is turned off, the app signs out or the device is removed. The Firebase SDK also keeps a Firebase installation id. |
| Device token (`tvr_…`) | Stays on the device | Keychain / Keystore; lets Siri, the share extension and the widget act as the person. Deleted at sign-out or Revoke. |
| Error reports | tavya, only when the person taps **Report** on an error | The task id and the error text tavya showed. No crash reporter or analytics SDK is in the apps. |
| Vault items (passwords, API keys, payment cards for agents) | tavya (encrypted vault) | Only if the person adds them in the console; the app is the console, so the forms must count them as optional. |

Not collected by the apps: location, contacts, calendar, health, SMS or call log, browsing history, installed apps, advertising id, audio.

## Google Play: Data safety

**Data collection and security**

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes (HTTPS only; FCM over TLS) |
| Which methods of account creation does your app support? | Username and password; OAuth (Google, GitHub) — in the browser the app opens |
| Do you provide a way for users to request that their data is deleted? | Yes: in the app (Profile → Data & account → Delete account) and https://tavya.io/legal/data |
| Has your app been independently validated against a global security standard (MASA)? | No |

**Data types.** "Shared" is No everywhere: Firebase is a service provider acting for tavya, and the model, repository and other services a person connects receive data at that person's direction (Play excludes both from "sharing"). Nothing is processed ephemerally except speech, which the app never sends.

| Category → type | Collected | Shared | Required or optional | Purposes |
| --- | --- | --- | --- | --- |
| Personal info → Name | Yes | No | Required | App functionality, Account management |
| Personal info → Email address | Yes | No | Required | App functionality, Account management, Developer communications (account and security email) |
| Personal info → User IDs | Yes | No | Required | App functionality, Account management, Fraud prevention, security, and compliance |
| Personal info → Other info | Yes | No | Optional (vault items a person saves for agents) | App functionality |
| Financial info → User payment info | Yes | No | Optional (a card a person adds for agents to pay with) | App functionality |
| Financial info → Purchase history | No (subscriptions are bought on the website; the app only shows the plan) | | | |
| Messages → Other in-app messages | Yes | No | Required | App functionality |
| Photos and videos → Photos | Yes | No | Optional (attached or shared) | App functionality |
| Photos and videos → Videos | Yes | No | Optional (attached or shared) | App functionality |
| Audio → Voice or sound recordings | **No** (the phone's speech service turns speech into text; tavya gets text only) | | | |
| Files and docs | Yes | No | Optional (attached or shared) | App functionality |
| App activity → Other user-generated content | Yes (tasks, review decisions, notes) | No | Required | App functionality |
| App activity → App interactions, In-app search history | No (no analytics) | | | |
| App info and performance → Crash logs | No | | | |
| App info and performance → Diagnostics | Yes | No | Optional (only on Report) | Analytics (fixing the reported bug) |
| Device or other IDs | Yes (push token, Firebase installation id) | No | Optional (only with push on) | App functionality |
| Location, Contacts, Calendar, Health and fitness, Web browsing, Installed apps, SMS/call log | No | | | |

## App Store: App Privacy

**Tracking:** No. The app does not track people across apps or websites; no data is used to track (`NSPrivacyTracking` false in `PrivacyInfo.xcprivacy`).

**Data Linked to You** (all collected for **App Functionality** only; none for Third-Party Advertising, Developer's Advertising or Marketing, Analytics, Product Personalization or Other Purposes):

| Apple's type | What it is in tavya |
| --- | --- |
| Contact Info → Name | Account name |
| Contact Info → Email Address | Account email (also account and security email) |
| Identifiers → User ID | Account id |
| Identifiers → Device ID | Push token and Firebase installation id (only with push on) |
| User Content → Photos or Videos | Attached or shared photos and videos |
| User Content → Other User Content | Tasks, messages, Ask and Siri questions (text), files, review decisions |
| Financial Info → Payment Info | A card a person adds for agents to pay with (optional) |
| Diagnostics → Other Diagnostic Data | An error the person reports with **Report** |
| Other Data | Passwords, API keys and other secrets a person saves in the vault for agents (optional) |

**Data Not Linked to You:** none. **Not collected:** Health & Fitness, Location, Sensitive Info, Contacts, Browsing History, Search History, Purchases, Usage Data, **Audio Data** (Apple's speech recognition makes the text; tavya receives no audio), Gameplay Content, Customer Support, Crash Data, Performance Data.

The same types are declared in `mobile/ios/App/App/PrivacyInfo.xcprivacy` (the Share Extension's declares none: it sends nothing).

## Permission strings (reviewed 2026-11-28)

| Platform | Key / permission | Text or use | Asked when |
| --- | --- | --- | --- |
| iOS | `NSMicrophoneUsageDescription` | "tavya listens only while you dictate, to type what you say into a task or message." | First tap on a mic |
| iOS | `NSSpeechRecognitionUsageDescription` | "Apple’s speech recognition turns what you dictate into text in tavya." | First tap on a mic |
| iOS | `NSCameraUsageDescription` | "tavya uses the camera only when you take a photo or video to attach to a task." | Choosing Take Photo or Video in Attach files |
| iOS | Push | System prompt | Turning on Push to this device |
| iOS | `UIBackgroundModes` | none (removed `remote-notification`: iPhone pushes are alerts; the app runs no code on them) | — |
| iOS | Not needed | Photo library (the picker needs none), Siri (App Intents need no entitlement), location, contacts, tracking | — |
| Android | `RECORD_AUDIO` | Dictation | First tap on a mic |
| Android | `POST_NOTIFICATIONS` (13+) | Push | Turning on Push to this device |
| Android | `INTERNET` | — | — |
| Android | Backup | `allowBackup="false"` and `dataExtractionRules` excluding everything: the WebView's signed-in session never reaches Google's backups or a new phone | — |
| macOS | `NSMicrophoneUsageDescription` | "tavya listens only while you dictate, to type what you say into a task or message." | First dictation |
