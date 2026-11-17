# App Review notes

Paste into App Store Connect → App Review Information → Notes (and Play Console → App access, adapted).

---

tavya is a to-do list where AI agents do the tasks (code changes, account setup, research), ask the person when they need a decision, and the person reviews the result. This app is the tavya console for phones: it shows the hosted console at https://tavya.io and adds three native features.

Sign-in
A demo account will be provided by the app's owner in the Sign-In Information fields. Tap "Sign in": the sign-in page opens in the system browser sheet (ASWebAuthenticationSession on iOS, a Custom Tab on Android), and returns to the app when done. We use the system browser so people can use their existing identity provider session and passkeys; the app never sees their password.

Speech recognition (microphone and speech recognition permissions)
Tap the microphone button in the message or task composer to dictate. The app asks for microphone and speech recognition access the first time. Audio is used only while the button is active, to turn speech into text in the composer; no audio is stored or sent to our servers.

Push notifications
Profile → Notifications → "Push to this device" asks for permission when it is switched on (never earlier). Notifications tell the person when an agent needs an answer or approval, or when a task is ready for review. Notifications are sent through Firebase Cloud Messaging. Declining has no effect on the rest of the app.

Account deletion
Profile (the avatar at the bottom of the menu) → Data & account → Delete account → Request deletion. It starts the deletion of the account from inside the app (guideline 5.1.1(v)); an operator confirms who owns shared organizations before the irreversible step.

No in-app purchases are offered in the app. Paid plans are not sold inside the app: in the app, Plan & billing shows the current plan and its limits only, with no checkout, prices to choose from or links to buy.

---

Before submitting: enter the demo account in the Sign-In Information fields (an account on a gifted or paid plan, so the reviewer can start a task).
