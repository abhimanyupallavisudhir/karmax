package io.tavya.app;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import org.json.JSONObject;

/** What `npx cap sync` built into the app: the console it loads (TAVYA_URL, capacitor.config.ts). */
final class AppConfig {

    static final String DEFAULT_SERVER = "https://tavya.io";
    private static String serverUrl;

    private AppConfig() {}

    static synchronized String serverUrl(Context context) {
        if (serverUrl != null) return serverUrl;
        String url = DEFAULT_SERVER;
        try (InputStream in = context.getAssets().open("capacitor.config.json"); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            JSONObject server = new JSONObject(out.toString("UTF-8")).optJSONObject("server");
            if (server != null && !server.optString("url").isEmpty()) url = server.optString("url");
        } catch (Exception ignored) {
            // A build without a synced config talks to tavya.io.
        }
        serverUrl = url.replaceAll("/+$", "");
        return serverUrl;
    }
}
