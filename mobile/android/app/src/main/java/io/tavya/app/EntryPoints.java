package io.tavya.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

/**
 * The phone's ways into the app, as links the console understands (web/app.js
 * openAppLink): Capacitor's App plugin hands an ACTION_VIEW intent's link to
 * the page (keeping it until the page listens, so a cold start or a sign-in
 * first loses nothing).
 *  - Share to tavya (ACTION_SEND, ACTION_SEND_MULTIPLE) → io.tavya.app://share,
 *    after ShareInbox starts keeping what was shared.
 *  - The digital-assistant gesture (ACTION_ASSIST) → io.tavya.app://ask?voice=1.
 */
final class EntryPoints {

    static final String SHARE = "io.tavya.app://share";

    private EntryPoints() {}

    /** `intent` as a link, or `intent` itself. `fresh`: false when an activity is recreated with its old intent. */
    static Intent translate(Context context, Intent intent, boolean fresh) {
        if (intent == null) return null;
        if (ShareInbox.isShare(intent)) {
            if (fresh) ShareInbox.receive(context, intent);
            return link(context, SHARE);
        }
        if (Intent.ACTION_ASSIST.equals(intent.getAction())) return link(context, ForMeWidget.ASK_BY_VOICE);
        return intent;
    }

    private static Intent link(Context context, String link) {
        return new Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity.class);
    }
}
