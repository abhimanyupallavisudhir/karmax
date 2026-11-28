# Store listing: tavya

What to paste into Google Play Console and App Store Connect, and the desktop app's words for tavya.io/download. Each field is the fenced block under its heading; the number in the heading is the store's limit in characters (Unicode characters, as both stores count), checked by `tests/store-listing.test.ts`. Screenshots: `screenshots/` (README there). Privacy answers: `privacy.md`. Review notes and the demo account: `review-notes.md`.

Rules for these words: say only what the app does today (offline is read-and-keep, not editing; no wake word; the phone apps sell nothing), no other companies' trademarks in keywords, no prices or links to buy (App Store 3.1.1, Play payments policy).

## Both stores

### Name (30)

```
tavya: agentic to-do list
```

Name on the home screen: `tavya`.

### Categories

- Google Play: **Productivity**. Tags: Task management, Productivity tools.
- App Store: primary **Productivity**, secondary **Developer Tools**.

### URLs

- Support: https://tavya.io/docs
- Marketing: https://tavya.io
- Privacy policy: https://tavya.io/legal/privacy
- Account deletion (Play's "Delete account URL"): https://tavya.io/legal/data (in-app: Profile → Data & account → Delete account)

### Content rating

No public user-generated content, no ads, no gambling, no location, no chat between strangers (people talk only with their own organization's agents and members). Expected: Everyone / 4+. Play's questionnaire: category "Utility, Productivity, Communication, or Other"; "Does the app allow users to interact or exchange content?" — **Yes, within their own organization**; "Shares user location" No; "Digital purchases" No.

## Google Play

### Short description (80)

```
Agents do your tasks; you review them. Dictate, share and ask by voice.
```

### Full description (4000)

```
tavya is the agentic to-do list that finishes itself. You write tasks; AI agents do them, each on its own cloud computer. They ask you when they need a decision, and you review what they did before it lands.

WHAT AGENTS DO
• Code: change a repository, run the tests, open a pull request.
• Accounts: sign up for services, log in and fill in forms, within limits you set.
• Research: read, compare and write up what they found.

Agents work in parallel, as many at once as your plan allows, with the project's repositories, files and secrets. Claude Code, Codex and OpenCode are supported, with your own subscriptions or API keys.

YOU STAY IN CHARGE
An agent asks you only at real decision points: a question it can't answer, an approval, spending above a task's budget. At Review you see the result and the changes, and decide whether it lands. Passwords, payment cards and connected apps reach a task only if you allow it.

ON YOUR PHONE
• Dictate tasks and replies instead of typing them.
• Get a notification when an agent needs you or a task is ready for review.
• Share links, text, photos and files from any app into a new task, or add them to one you already have.
• Ask hands-free: make tavya your digital assistant app, or use its Quick Settings tile or home-screen widget, which also shows how many tasks wait on you.
• Keep project files available offline and read them without a connection.
• Sign in with your existing account in your phone's browser.

The work keeps running in the cloud while your phone is in your pocket. You need a tavya account; you can create one when you sign in.
```

### Release notes (500)

```
First release: tasks, review and notifications on your phone; dictation; Share to tavya; tavya as your assistant app, with a Quick Settings tile and a home-screen widget; project files available offline.
```

### Graphics

- App icon 512×512: `mobile/assets/icon-only.png` rendered by `npm run assets` (Play shows it with its own mask).
- Feature graphic 1024×500: `screenshots/android/feature-graphic.png`.
- Phone screenshots (9:16, 1080×1920): `screenshots/android/phone/`. 7-inch tablet: `screenshots/android/tablet-7/`. 10-inch tablet: `screenshots/android/tablet-10/`.

## App Store

### Subtitle (30)

```
Agents do your tasks
```

### Promotional text (170)

```
Dictate a task, share a link or photo into one, or say “Hey Siri, ask tavya”. Agents do the work in the cloud; you answer and review from your iPhone.
```

### Keywords (100)

Comma-separated without spaces; not the app name (Apple indexes it) and no other companies' trademarks.

```
agents,AI,todo,tasks,assistant,dictation,automation,coding,research,productivity,review,offline
```

### Description (4000)

```
tavya is the agentic to-do list that finishes itself. You write tasks; AI agents do them, each on its own cloud computer. They ask you when they need a decision, and you review what they did before it lands.

WHAT AGENTS DO
• Code: change a repository, run the tests, open a pull request.
• Accounts: sign up for services, log in and fill in forms, within limits you set.
• Research: read, compare and write up what they found.

Agents work in parallel, as many at once as your plan allows, with the project's repositories, files and secrets. Claude Code, Codex and OpenCode are supported, with your own subscriptions or API keys.

YOU STAY IN CHARGE
An agent asks you only at real decision points: a question it can't answer, an approval, spending above a task's budget. At Review you see the result and the changes, and decide whether it lands. Passwords, payment cards and connected apps reach a task only if you allow it.

ON YOUR IPHONE AND IPAD
• Dictate tasks and replies instead of typing them.
• Get a notification when an agent needs you or a task is ready for review.
• Share links, text, photos and files from any app into a new task, or add them to one you already have.
• Ask hands-free: “Hey Siri, ask tavya”, “New task in tavya” and “What’s for me in tavya” work from Siri, Spotlight and the Shortcuts app.
• Keep project files available offline and read them without a connection.
• Sign in with your existing account in the system's sign-in sheet.

The work keeps running in the cloud while your phone is in your pocket. You need a tavya account; you can create one when you sign in.
```

### What's New (4000)

Not shown for the first version; for the next one, say what changed since. The first TestFlight build's "What to Test":

```
Sign in, then try: dictating a reply (the mic in a task's message box); Share to tavya from Safari or Photos; “Hey Siri, ask tavya”; Available offline from a file's ⋯ menu in Files, then opening it in airplane mode; turning on Push to this device in Profile → Notifications.
```

### Screenshots

- iPhone 6.9″ (1290×2796, required): `screenshots/ios/iphone-6.9/`.
- iPhone 6.5″ (1242×2688): `screenshots/ios/iphone-6.5/`.
- iPad 13″ (2064×2752, required because the app runs on iPad): `screenshots/ios/ipad-13/`.

### Other fields

- Copyright: `2026 <the publishing entity's name>` (the owner's legal name or company, as in the developer account).
- Age rating: 4+ (no objectionable content; unrestricted web access: **No**, the app shows only tavya's own console and opens other sites in Safari).
- Export compliance: `ITSAppUsesNonExemptEncryption` is false in Info.plist (standard HTTPS only), so no question per build.
- Sign-in required: yes; App Review gets the demo account (`review-notes.md`).

## Desktop app (tavya.io/download)

The download page (`web/download.md`) opens with this line, and shows `web/media/download/desktop-{light,dark}.webp` beside the button:

```
tavya in its own window on your Mac or Linux computer: what's for you in the menu bar, Ask from any app with one shortcut, notifications, dictation, and project files kept offline. It keeps itself up to date.
```

A blurb for elsewhere (a post, a newsletter, the changelog) (300):

```
tavya now has a desktop app for Mac and Linux. Ask from any app with one shortcut, see what's waiting for you in the menu bar, get notified when an agent needs you, dictate replies, and keep project files available offline. It updates itself. tavya.io/download
```
