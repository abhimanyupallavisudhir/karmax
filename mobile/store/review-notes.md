# App Review notes

Paste into App Store Connect → App Review Information → Notes (and Play Console → App access, adapted).

---

tavya is a to-do list where AI agents do the tasks (code changes, account setup, research), ask the person when they need a decision, and the person reviews the result. This app is the tavya console for phones: it shows the hosted console at https://tavya.io and adds native features: system-browser sign-in, dictation, push, Share to tavya, Siri and Shortcuts, and (Android) assistant, Quick Settings tile and widget.

Sign-in
A demo account will be provided by the app's owner in the Sign-In Information fields. Tap "Sign in": the sign-in page opens in the system browser sheet (ASWebAuthenticationSession on iOS, a Custom Tab on Android), and returns to the app when done. We use the system browser so people can use their existing identity provider session and passkeys; the app never sees their password.

Speech recognition (microphone and speech recognition permissions)
Tap the microphone button in the message or task composer to dictate. The app asks for microphone and speech recognition access the first time. Audio is used only while the button is active, to turn speech into text in the composer; no audio is stored or sent to our servers.

Push notifications
Profile → Notifications → "Push to this device" asks for permission when it is switched on (never earlier). Notifications tell the person when an agent needs an answer or approval, or when a task is ready for review. Notifications are sent through Firebase Cloud Messaging. Declining has no effect on the rest of the app.

Share to tavya (Share Extension)
In any app's share sheet (Safari, Photos, Files), choose tavya. The extension copies what was shared into the app group and opens tavya, which shows a new task form with the text and the files attached, and an "Add to task…" choice to add them to an existing task instead. The extension itself makes no network requests. If the person is signed out, the app asks them to sign in and then shows the form.

Siri and Shortcuts (App Intents)
"Hey Siri, ask tavya" → Siri asks "What should I ask?" → the question becomes an Ask in tavya (as if typed in the app's Ask box). If the reply arrives within a few seconds Siri reads it, otherwise it says "Asked — I'll notify you." and the reply comes as a notification. "New task in tavya" opens the new task form. "What's for me in tavya" says how many tasks wait on the person and the first titles. These also appear in Spotlight and the Shortcuts app. They need the person to have signed in to the app once.

Account deletion
Profile (the avatar at the bottom of the menu) → Data & account → Delete account → Request deletion. It starts the deletion of the account from inside the app (guideline 5.1.1(v)); an operator confirms who owns shared organizations before the irreversible step.

No in-app purchases are offered in the app. Paid plans are not sold inside the app: in the app, Plan & billing shows the current plan and its limits only, with no checkout, prices to choose from or links to buy.

---

Before submitting: enter the demo account in the Sign-In Information fields (an account on a gifted or paid plan, so the reviewer can start a task).
