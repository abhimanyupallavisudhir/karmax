# Store listing: tavya

Character counts are Unicode characters, as both stores count them. Limits: Google Play title 30, short description 80, full description 4000; App Store name 30, subtitle 30, promotional text 170, keywords 100, description 4000.

## Name

- Google Play title (25/30 characters): `tavya: agentic to-do list`
- App Store name (25/30 characters): `tavya: agentic to-do list`
- Name on the home screen: `tavya`

## App Store subtitle (20/30 characters)

Agents do your tasks

## Google Play short description (79/80 characters)

The agentic to-do list that finishes itself. Agents do the work, you review it.

## App Store promotional text (150/170 characters)

Add a task by voice and an agent starts on it in its own cloud computer. You get a notification when it needs you or when the work is ready to review.

## App Store keywords (96/100 characters)

Comma-separated, no spaces, without the app name (Apple indexes it already) or other companies' trademarks.

```
agents,AI,todo,tasks,coding,assistant,automation,research,productivity,review,developer,workflow
```

## Description (Google Play full description and App Store description, 1351/4000 characters)

```
tavya is the agentic to-do list that finishes itself. You write tasks; agents do them. They ask you when they need you, and you review what they did.

WHAT AGENTS DO
• Code: change a repository, run the tests, open a pull request.
• Accounts: sign up for services, log in, fill in forms, within limits you set.
• Research: read, compare and write up what they found.

Each task runs in its own world, a cloud computer with the project's repositories, data and secrets. Agents work in parallel, as many at once as your plan allows. Claude Code, Codex and OpenCode are supported, using your own subscriptions or API keys.

YOU STAY IN CHARGE
An agent asks you only at real decision points: a question it can't answer, an approval, spending above a task's budget. At Review you see the result and the changes, and decide whether it lands. Passwords, payment cards and connected apps are available to a task only if you allow it.

IN THIS APP
• Dictate tasks and replies instead of typing them.
• Get a notification when an agent needs you or a task is ready for review.
• Share links, text, photos and files from any app into a new task or one you already have.
• Ask by voice: "Hey Siri, ask tavya" on iPhone; on Android, make tavya your assistant app, or use its Quick Settings tile and home-screen widget.
• Sign in with your existing account in your phone's browser.
• Review, answer and approve from anywhere; the work keeps running in the cloud while your phone is in your pocket.

The app is the tavya console for your phone. You need a tavya account; plans and pricing are at tavya.io.
```

## Categories

- Google Play: **Productivity** (alternative: Business). Tags: Task management, Productivity tools.
- App Store: primary **Productivity**, secondary **Developer Tools** (alternative: Business).

## URLs

- Support: https://tavya.io/docs
- Marketing: https://tavya.io
- Privacy policy: https://tavya.io/legal/privacy

## Notes for whoever submits

- Content rating / age rating: no user-generated content is shown publicly, no ads, no gambling; answer the questionnaires accordingly (expected: Everyone / 4+).
- Data safety (Play) and App Privacy (App Store): the app collects account details (email, name), the tasks and messages people write, files they attach or share to the app (user content, for app functionality), no audio: dictation runs in the phone's own speech service (Apple's or Google's, which may process it on their servers) and only the resulting text reaches tavya, and a push token. Nothing is sold or used for advertising. Check this against https://tavya.io/legal/privacy before submitting.
  - **Share to tavya**: shared items are copied into the app's private storage (iOS: the app group shared with its Share Extension) only until the app opens them in a task form, then deleted (at most a day if never opened). The iOS Share Extension makes no network requests; files upload from the app as ordinary attachments.
  - **Siri / Shortcuts (iOS)**: Siri's speech-to-text is Apple's (as dictation is); the app sends the resulting question text to tavya as an Ask and hands the reply text (or the For-me count and titles) back to Siri. Nothing else is shared with Apple. Declare it as user content collected for app functionality, linked to the user.
  - **Device token**: a refresh token kept on the phone (iOS Keychain in the app group's access group; Android Keystore-encrypted preferences) so Siri and the Android widget act as the signed-in person; deleted at sign-out or when revoked in Profile → Apps and tokens.
  - **Android assistant, tile, widget**: no extra data; the widget stores only the For-me count on the phone. tavya sends Android phones a content-free FCM data message beside each notification so the widget refreshes.
  - App Store privacy: no new data types beyond the above; Play: "Files and docs" and "Photos and videos" are user-provided content, collected only when the person shares or attaches them.
- Screenshots are not included: take them from the app signed in to a demo organization (phone 6.9" and 6.5" for the App Store; phone and 7"/10" tablet for Play).
