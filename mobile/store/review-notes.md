# Review notes: App Review and Google Play

Two blocks to paste (App Store Connect → App Review Information → Notes; Play Console → App content → App access), what Play's declarations should say, the demo account the reviewers sign in with, and the risks we know of. Fenced blocks are pasted as they are; the number in a heading is the field's limit (`tests/store-listing.test.ts`).

## App Store Connect → App Review Information → Notes (4000)

```
tavya is a to-do list where AI agents do the tasks (code changes, account setup, research), ask the person when they need a decision, and the person reviews the result. The app shows the tavya console (https://tavya.io) and adds what a website cannot do on an iPhone or iPad:

1. Dictation with Apple's speech recognition (the web view has none).
2. Push notifications when an agent needs an answer or a task is ready for review (Safari delivers web push only to Home Screen web apps).
3. Share to tavya: a Share Extension that turns links, text, photos and files from any app into a task.
4. Siri, Spotlight and Shortcuts (App Intents): "Ask tavya", "New task in tavya", "What's for me in tavya".
5. Available offline: project files kept on the device, readable without a connection; the app opens into them when offline.
6. Sign-in in the system sheet (ASWebAuthenticationSession), so passkeys and Google or GitHub sign-in work; the app never sees a password.

SIGN IN
Tap "Sign in", enter the demo account's email and password in the sheet, then tap "Allow". The account has a gifted plan and a demo project; nothing needs buying.

WHERE EACH FEATURE IS
- Dictation: open the task "Pick a launch date" and tap the microphone in the message box. The app asks for microphone and speech recognition access on first use, and listens only while the button is on. Saying "stop listening" or tapping again ends it.
- Push: Profile (avatar, bottom of the menu) → Notifications → "Push to this device". Permission is asked only then. Declining changes nothing else.
- Share to tavya: in Safari, Photos or Files, tap Share → tavya. The app opens a new task form with the text and files attached; "Add to task…" adds them to an existing task instead. The extension itself makes no network requests.
- Siri: sign in once, then say "Hey Siri, ask tavya" (Siri asks "What should I ask?"). If the answer arrives within a few seconds Siri reads it; otherwise it says "Asked — I'll notify you." The three shortcuts are also in the Shortcuts app and Spotlight.
- Available offline: Files (menu) → project "Demo" → ⋯ next to "README.md" → Available offline. Then the view menu at the top of Files → "Available offline" lists what the device keeps. In airplane mode, reopen the app: it shows the kept files.
- Account deletion (5.1.1(v)): Profile → Data & account → Delete account → Request deletion.

PURCHASES (3.1.1)
Nothing is sold in the app and there are no in-app purchases. In the app, Plan & billing shows the current plan and its limits only: no prices, plan choices, checkout or links to buy.

BACKGROUND MODES
None. Notifications are alerts the system shows; the app runs no code in the background.

PRIVACY
Speech is turned into text by Apple; only the text reaches tavya, never audio. Shared items stay on the device until the app opens them. Offline copies are excluded from backups and deleted at sign-out. No tracking, ads or analytics.
```

## Play Console → App content → App access (500)

"All or some functionality is restricted" → add instructions: the demo account's email and password in their fields, and in "Any other instructions" (kept under 500 characters; Play's help names no limit, so stay short):

```
Tap "Sign in": the sign-in page opens in a Custom Tab. Enter the email and password, tap "Sign in", then "Allow". The account has a gifted plan and a demo project, so nothing needs buying (the app sells nothing; Plan & billing is read-only). Dictation: the mic in a task's message box. Ask hands-free: Profile → This app → Digital assistant.
```

### Where each feature is (Android; for Play's reviewers on request, and the closed-test testers)

- Dictation: open the task "Pick a launch date" and tap the microphone in the message box. Android's speech recognizer turns speech into text; only the text reaches tavya.
- Notifications: Profile (avatar, bottom of the menu) → Notifications → "Push to this device".
- Share to tavya: Share from Chrome, Photos or Files → tavya. A new task form opens with the text and files attached; "Add to task…" adds them to an existing task.
- Assistant: Profile → This app → Digital assistant → Change, and pick tavya (or Settings → Apps → Default apps → Digital assistant app). Long-press the home button or power button: Ask opens, listening. Choosing tavya replaces Google's assistant for that person until they change it back.
- Quick Settings tile: pull down Quick Settings → edit (pencil) → drag "Ask tavya" in → tap it.
- Widget: long-press the home screen → Widgets → tavya: the count of tasks waiting on you and a mic.
- Available offline: Files (menu) → project "Demo" → ⋯ next to "README.md" → Available offline; the view menu at the top of Files → "Available offline". In airplane mode the app opens into the kept files.
- Account deletion: Profile → Data & account → Delete account → Request deletion (also https://tavya.io/legal/data).

## Play Console declarations

| Form | Answer |
| --- | --- |
| Ads | No ads. |
| Data safety | `privacy.md` § Google Play Data safety. |
| Account deletion | Yes: in the app (Profile → Data & account → Delete account) and on the web, https://tavya.io/legal/data. |
| Target audience | 18 and over (a work tool; keeps the app out of the Families policy). |
| Foreground services | **None.** The manifest declares no `<service android:foregroundServiceType>` and no `FOREGROUND_SERVICE` permission. Dictation runs only while the app is open; the tile and the widget open the app. |
| Permissions | `INTERNET`; `POST_NOTIFICATIONS` (asked when push is turned on); `RECORD_AUDIO` (asked at the first dictation, used only while the mic is on). No location, contacts, SMS, call log, `QUERY_ALL_PACKAGES` (the `<queries>` name only the speech service, browsers and Custom Tabs), or exact alarms. |
| Digital assistant (`ACTION_ASSIST`) | No declaration form exists for it: an app that handles `ACTION_ASSIST` may be chosen as the assistant app by the person, in system settings. The app cannot pick itself, does not ask in a dialog, and does no always-on listening (no `VoiceInteractionService`, no hotword). |
| App Links | `LinkActivity` claims `https://tavya.io` (`autoVerify`); Play App Signing's SHA-256 goes into tavya.io Installation → Phone apps → Links so `/.well-known/assetlinks.json` lists it (features/phone-apps). |
| Government, financial features, health, news, COVID-19 | Not applicable. |
| Content rating | `listing.md` § Content rating. |

## Demo account (for both stores)

**Not created yet.** Create it when the store records exist, on tavya.io, **never in the owner's organization** and touching no customer data:

1. **A mailbox the owner controls** but that is not a person's: e.g. `appreview@` on a domain the owner has, or an agent mailbox (features/agent-mail). tavya sends a confirmation email there; reviewers never need it.
2. **Sign up** at https://tavya.io with that address and a generated password (32 characters, letters and digits, no symbols a reviewer might mistype). Name: `App Review`. Organization: `Demo` (its own, new). Confirm the address.
3. **Save the login** in the vault (organization `org_personal`): type `login`, label `App Review demo account (tavya.io)`, domain `tavya.io`. Record its vault item id in the wiki's ops/secrets-and-accounts.
4. **Gift the plan** (installation operator): Organization `Demo` → Settings → Plan & billing → **Operator**: plan **Individual**; and one compute pack (`POST /api/organizations/<id>/subscription/gift {"plan":"individual"}` and `…/gift-compute {"packs":1}`). Agents then run on the included model without a Claude or OpenAI login.
5. **Seed a project** `Demo` with a new repository tavya hosts (`tavya/demo` in the project's repositories; no GitHub needed, features/hosted-repositories), and upload in Files a `README.md` and a `notes/` folder of two or three short Markdown files (invented content). Create two tasks: "Pick a launch date" (send it; when the agent asks a question it waits with Needs input) and "Write a short README for the demo" (let it reach Review). Leave both as they are.
6. **Phone apps → Push**: push works for the reviewer only once tavya.io's Installation → Phone apps has the Firebase key (features/phone-apps § Publishing, step 3).
7. Enter the email and password in App Store Connect (Sign-In Information) and Play Console (App access). Before each new submission, open the account once: answer or archive what the last reviewer left, and check the plan is still gifted.

What it does not have: repositories on GitHub, connected apps, payment cards, other members. A reviewer can create tasks and spend the gifted compute; nothing else is reachable from it.

## Risks we know of

- **The Share Extension opens the app through the responder chain** (`openURL:options:completionHandler:` found by selector), which Apple does not document for extensions. If App Review objects, or a future iOS blocks it, nothing is lost: the extension has already saved the share into the app group and says "Saved. Open tavya to finish."; the app picks it up the next time it is opened (`receiveShare()` at launch and on every return to the front). The fix is then to drop the call and keep that message.
- **4.2 (minimum functionality)**: the app is the hosted console in a web view. The notes list the six things it adds; the strongest are the Share Extension, Siri/App Intents and offline files, which a website cannot do.
- **Offline launch on iOS is unverified on a device.** The app opening into its kept files without a network depends on `WKAppBoundDomains` letting the service worker run (features/offline-files; checked by reading, not on an iPhone). Try it on the first TestFlight build before submitting; if it fails, drop "In airplane mode, reopen the app" from the notes (the kept files still open from Files while the app runs).
- **4.2.2/2.5.6 web view rules**: other sites open in Safari (Capacitor's navigation policy); only tavya.io is shown in the app (`WKAppBoundDomains`).
- **Choosing tavya as the Android assistant replaces Google's assistant**: said in the setting's tooltip and in the App access notes.
