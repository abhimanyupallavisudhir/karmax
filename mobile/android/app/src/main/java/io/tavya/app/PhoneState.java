package io.tavya.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.net.URLEncoder;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * What the phone shows outside the app (the For-me widget): the organization
 * the person last used and its For-me count. The console sets both whenever
 * the count changes (TavyaPhone.setContext, "on app use"); a push arriving in
 * the background, the widget's periodic update and a new sign-in read the
 * count from the server with the device token instead.
 */
final class PhoneState {

    /** The console's default list (web/app.js DEFAULT_LIST_QUERY). */
    static final String FOR_ME_QUERY = "for:me -is:archived";
    static final int UNKNOWN = -1;
    private static final String PREFS = "tavya-phone";
    private static final ExecutorService background = Executors.newSingleThreadExecutor();

    private PhoneState() {}

    static String organizationId(Context context) { return prefs(context).getString("organizationId", null); }

    /** The For-me count, or UNKNOWN; signedOut() tells a signed-out phone apart. */
    static int forMe(Context context) { return prefs(context).getInt("forMe", UNKNOWN); }

    static boolean signedOut(Context context) { return prefs(context).getBoolean("signedOut", false); }

    /** From the console: null organization = signed out. */
    static void setContext(Context context, String organizationId, int forMe) {
        SharedPreferences.Editor edit = prefs(context).edit();
        if (organizationId == null) edit.remove("organizationId").putInt("forMe", UNKNOWN).putBoolean("signedOut", true);
        else edit.putString("organizationId", organizationId).putInt("forMe", Math.max(0, forMe)).putBoolean("signedOut", false);
        edit.apply();
        ForMeWidget.updateAll(context);
    }

    /** Reads the count from the server in the background, then repaints the widget. */
    static void refreshSoon(Context context, Runnable done) {
        Context app = context.getApplicationContext();
        background.execute(() -> {
            try { refreshNow(app); } finally { if (done != null) done.run(); }
        });
    }

    /** Blocking: for a thread that may wait on the network (FCM's, the widget's goAsync). */
    static void refreshNow(Context context) {
        TavyaServer server = TavyaServer.of(context);
        try {
            if (!server.signedIn()) throw new TavyaServer.SignedOut("Not signed in");
            String organizationId = organizationId(context);
            if (organizationId == null) {
                organizationId = server.get("/api/user/default-organization").optString("organizationId", "");
                if (organizationId.isEmpty() || "null".equals(organizationId)) return;
            }
            JSONObject counts = server.get("/api/organizations/" + URLEncoder.encode(organizationId, "UTF-8") + "/search?q="
                + URLEncoder.encode(FOR_ME_QUERY, "UTF-8") + "&countBy=project").optJSONObject("counts");
            int total = 0;
            for (Iterator<String> keys = counts == null ? null : counts.keys(); keys != null && keys.hasNext(); )
                total += Math.max(0, counts.optInt(keys.next(), 0));
            prefs(context).edit().putString("organizationId", organizationId).putInt("forMe", total).putBoolean("signedOut", false).apply();
        } catch (TavyaServer.SignedOut e) {
            prefs(context).edit().remove("organizationId").putInt("forMe", UNKNOWN).putBoolean("signedOut", true).apply();
        } catch (Exception e) {
            // Offline, or the server is down: the last count stays.
        }
        ForMeWidget.updateAll(context);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
