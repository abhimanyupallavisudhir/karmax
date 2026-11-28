package io.tavya.app;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The console's API from native code, as the signed-in person, through the
 * device token (wiki planned/native-apps-round-2 § contracts 3).
 *
 * The token is a refresh token that rotates on every use: presenting one the
 * server already rotated away revokes the grant and signs the phone out. So
 * there is one TavyaServer per process and every refresh happens under its
 * lock, the new token stored before its access token is used. An access token
 * (≤ 1 h) is kept in memory only.
 */
final class TavyaServer {

    static final String CLIENT_ID = "tavya-app";

    /** Where the device token lives; DeviceToken in the app, a map in tests. */
    interface TokenStore {
        String read();
        void save(String token);
        void clear();
    }

    /** The phone is signed out: no device token, or the server no longer accepts it. */
    static final class SignedOut extends IOException {
        SignedOut(String message) { super(message); }
    }

    /** An answer other than 2xx. */
    static final class Refused extends IOException {
        final int status;
        Refused(int status, String message) { super(message); this.status = status; }
    }

    private static TavyaServer shared;

    /** The app's one instance, for the console server it was built against. */
    static synchronized TavyaServer of(Context context) {
        if (shared == null) {
            Context app = context.getApplicationContext();
            shared = new TavyaServer(AppConfig.serverUrl(app), new TokenStore() {
                @Override public String read() { return DeviceToken.read(app); }
                @Override public void save(String token) { DeviceToken.save(app, token); }
                @Override public void clear() { DeviceToken.clear(app); }
            });
        }
        return shared;
    }

    private final String origin;
    private final TokenStore tokens;
    private String accessToken;
    private long accessExpiresAt;

    TavyaServer(String origin, TokenStore tokens) {
        this.origin = origin.replaceAll("/+$", "");
        this.tokens = tokens;
    }

    String origin() { return origin; }

    boolean signedIn() { return tokens.read() != null; }

    /** Forget the in-memory access token (the console signed out, or handed over a new device token). */
    synchronized void forget() {
        accessToken = null;
        accessExpiresAt = 0;
    }

    /** A current access token, refreshing (and rotating the device token) when needed. */
    synchronized String accessToken() throws IOException {
        if (accessToken != null && System.currentTimeMillis() < accessExpiresAt - 60_000) return accessToken;
        String refresh = tokens.read();
        if (refresh == null) throw new SignedOut("Not signed in");
        String form = "grant_type=refresh_token&client_id=" + CLIENT_ID + "&refresh_token=" + URLEncoder.encode(refresh, "UTF-8");
        HttpURLConnection connection = open("/oauth/token", "POST");
        connection.setRequestProperty("content-type", "application/x-www-form-urlencoded");
        Answer answer = send(connection, form.getBytes(StandardCharsets.UTF_8));
        if (answer.status == 400 || answer.status == 401) {
            // invalid_grant: revoked, expired with its session, or signed out on the server.
            if ("invalid_grant".equals(answer.json().optString("error"))) {
                tokens.clear();
                forget();
                throw new SignedOut("Signed out");
            }
        }
        if (answer.status != 200) throw new Refused(answer.status, "Could not refresh the sign-in (" + answer.status + ")");
        JSONObject body = answer.json();
        String rotated = body.optString("refresh_token", "");
        String access = body.optString("access_token", "");
        if (access.isEmpty()) throw new Refused(answer.status, "No access token in the answer");
        // Kept first: the one just presented is now spent.
        if (!rotated.isEmpty()) tokens.save(rotated);
        accessToken = access;
        accessExpiresAt = System.currentTimeMillis() + Math.max(60, body.optLong("expires_in", 3600)) * 1000L;
        return accessToken;
    }

    JSONObject get(String path) throws IOException { return call("GET", path, null); }

    JSONObject post(String path, JSONObject body) throws IOException { return call("POST", path, body); }

    private JSONObject call(String method, String path, JSONObject body) throws IOException {
        for (int attempt = 0; ; attempt++) {
            String token = accessToken();
            HttpURLConnection connection = open(path, method);
            connection.setRequestProperty("authorization", "Bearer " + token);
            if (body != null) connection.setRequestProperty("content-type", "application/json");
            Answer answer = send(connection, body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8));
            // An access token the server stopped accepting (its grant still alive): once more with a fresh one.
            if (answer.status == 401 && attempt == 0) { forget(); continue; }
            if (answer.status < 200 || answer.status >= 300)
                throw new Refused(answer.status, answer.json().optString("error", "HTTP " + answer.status));
            return answer.json();
        }
    }

    private HttpURLConnection open(String path, String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setRequestMethod(method);
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        connection.setRequestProperty("accept", "application/json");
        return connection;
    }

    private static Answer send(HttpURLConnection connection, byte[] body) throws IOException {
        try {
            if (body != null) {
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            }
            int status = connection.getResponseCode();
            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            return new Answer(status, in == null ? "" : readAll(in));
        } finally {
            connection.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int n; (n = stream.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static final class Answer {
        final int status;
        final String text;
        Answer(int status, String text) { this.status = status; this.text = text; }
        JSONObject json() {
            try { return text.isEmpty() ? new JSONObject() : new JSONObject(text); }
            catch (JSONException e) { return new JSONObject(); }
        }
    }
}
