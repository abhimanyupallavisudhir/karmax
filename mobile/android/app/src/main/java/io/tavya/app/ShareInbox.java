package io.tavya.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Share to tavya (ACTION_SEND / ACTION_SEND_MULTIPLE): what another app shares
 * is copied into the app's cache, one folder per share, and the console takes
 * it when it is ready — at once, or after signing in (wiki features/phone-apps
 * § Share to tavya).
 *
 * The copy runs on one background thread, so a large video never blocks the
 * screen; the console's takeShare runs on that same thread, after it. The
 * read permission another app grants lasts as long as MainActivity's task,
 * which outlives the copy. A file over the console's attachment limit is
 * listed with its size but not copied, so the console can say why it is missing.
 */
final class ShareInbox {

    static final long FILE_LIMIT_BYTES = 50L * 1024 * 1024;
    static final int MAX_FILES = 20;
    static final int MAX_CHUNK_BYTES = 1024 * 1024;
    private static final long KEEP_MS = 24L * 60 * 60 * 1000;
    private static final Pattern ID = Pattern.compile("^[0-9]{13}-[0-9a-f-]{36}$");
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();

    private ShareInbox() {}

    static boolean isShare(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    /** Starts keeping what `intent` shares; returns the share's id. */
    static String receive(Context context, Intent intent) {
        Context app = context.getApplicationContext();
        String id = System.currentTimeMillis() + "-" + UUID.randomUUID();
        String text = sharedText(intent);
        List<Uri> streams = streams(intent);
        worker.execute(() -> keep(app, id, text, streams));
        return id;
    }

    /** Runs `then` on the share thread once every share received so far is kept. */
    static void whenKept(Runnable then) { worker.execute(then); }

    /** The oldest share not yet finished, or null: {id, text, files: [{name, type, size}]}. Call from whenKept. */
    static JSONObject oldest(Context context) {
        File[] shares = root(context).listFiles(File::isDirectory);
        if (shares == null || shares.length == 0) return null;
        Arrays.sort(shares);
        for (File dir : shares) {
            try {
                JSONObject stored = new JSONObject(readText(new File(dir, "share.json")));
                JSONObject share = new JSONObject().put("id", stored.getString("id")).put("text", stored.optString("text", ""));
                JSONArray files = new JSONArray();
                JSONArray kept = stored.optJSONArray("files");
                for (int i = 0; kept != null && i < kept.length(); i++) {
                    JSONObject file = kept.getJSONObject(i);
                    files.put(new JSONObject().put("name", file.optString("name")).put("type", file.optString("type"))
                        .put("size", file.optLong("size")));
                }
                return share.put("files", files);
            } catch (IOException | JSONException e) {
                delete(dir); // half-written or unreadable: nothing the console could use
            }
        }
        return null;
    }

    /** Bytes `offset`…`offset + length` of a shared file, base64, and whether that was the end. */
    static JSONObject read(Context context, String id, int index, long offset, int length) throws IOException, JSONException {
        File dir = shareDir(context, id);
        JSONArray files = new JSONObject(readText(new File(dir, "share.json"))).optJSONArray("files");
        if (files == null || index < 0 || index >= files.length()) throw new IOException("No such file");
        String stored = files.getJSONObject(index).optString("file", "");
        if (stored.isEmpty()) throw new IOException("This file was not kept");
        File file = new File(dir, stored);
        int wanted = Math.max(0, Math.min(length, MAX_CHUNK_BYTES));
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            long size = in.length();
            long from = Math.max(0, Math.min(offset, size));
            byte[] chunk = new byte[(int) Math.min(wanted, size - from)];
            in.seek(from);
            in.readFully(chunk);
            return new JSONObject().put("data", Base64.encodeToString(chunk, Base64.NO_WRAP)).put("eof", from + chunk.length >= size);
        }
    }

    /** The console has what it needs: the copies go. */
    static void finish(Context context, String id) throws IOException {
        delete(shareDir(context, id));
    }

    // ── keeping a share ───────────────────────────────────────────────────

    static String sharedText(Intent intent) {
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String body = text == null ? "" : text.toString().trim();
        String title = subject == null ? "" : subject.trim();
        // A page's title and its link (browsers send both): the title first, once.
        if (!title.isEmpty() && !body.contains(title)) return body.isEmpty() ? title : title + "\n\n" + body;
        return body;
    }

    @SuppressWarnings("deprecation")
    static List<Uri> streams(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) uris.addAll(many);
        } else {
            Uri one = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        }
        // Some apps share only through ClipData.
        ClipData clip = intent.getClipData();
        for (int i = 0; uris.isEmpty() && clip != null && i < clip.getItemCount(); i++) {
            Uri uri = clip.getItemAt(i).getUri();
            if (uri != null) uris.add(uri);
        }
        List<Uri> content = new ArrayList<>();
        for (Uri uri : uris) {
            // Only what another app hands over through a provider: never a path into this app's own files.
            if (uri != null && ContentResolver.SCHEME_CONTENT.equals(uri.getScheme()) && content.size() < MAX_FILES) content.add(uri);
        }
        return content;
    }

    private static void keep(Context context, String id, String text, List<Uri> streams) {
        File root = root(context);
        prune(root);
        File dir = new File(root, id);
        if (!dir.mkdirs()) return;
        JSONArray files = new JSONArray();
        ContentResolver resolver = context.getContentResolver();
        for (int i = 0; i < streams.size(); i++) {
            Uri uri = streams.get(i);
            try {
                String type = resolver.getType(uri);
                String name = safeName(displayName(resolver, uri), type, i);
                long size = declaredSize(resolver, uri);
                JSONObject entry = new JSONObject().put("name", name).put("type", type == null ? "application/octet-stream" : type);
                if (size > FILE_LIMIT_BYTES) { files.put(entry.put("size", size)); continue; }
                String stored = "f" + i;
                long copied = copy(resolver, uri, new File(dir, stored));
                if (copied < 0) { files.put(entry.put("size", FILE_LIMIT_BYTES + 1)); new File(dir, stored).delete(); continue; }
                files.put(entry.put("size", copied).put("file", stored));
            } catch (Exception e) {
                // Unreadable (revoked, a provider that failed): left out.
            }
        }
        try {
            JSONObject share = new JSONObject().put("id", id).put("text", text).put("files", files);
            File partial = new File(dir, "share.json.part");
            try (OutputStream out = new FileOutputStream(partial)) { out.write(share.toString().getBytes(StandardCharsets.UTF_8)); }
            if (!partial.renameTo(new File(dir, "share.json"))) delete(dir);
        } catch (IOException | JSONException e) {
            delete(dir);
        }
    }

    /** Copies at most FILE_LIMIT_BYTES; -1 when the stream is longer than that. */
    private static long copy(ContentResolver resolver, Uri uri, File to) throws IOException {
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(to)) {
            if (in == null) throw new IOException("Nothing to read");
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            for (int n; (n = in.read(buffer)) > 0; ) {
                total += n;
                if (total > FILE_LIMIT_BYTES) return -1;
                out.write(buffer, 0, n);
            }
            return total;
        }
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (Exception ignored) {}
        return uri.getLastPathSegment();
    }

    private static long declaredSize(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getLong(0);
        } catch (Exception ignored) {}
        return -1;
    }

    /** A file name the console can show and upload: no path, something with an extension. */
    static String safeName(String name, String type, int index) {
        String base = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (base.startsWith(".")) base = base.replaceFirst("^\\.+", "");
        if (base.length() > 120) base = base.substring(base.length() - 120);
        if (base.isEmpty()) base = "shared-" + (index + 1);
        if (!base.contains(".") && type != null) {
            String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
            if (extension != null) base += "." + extension;
        }
        return base;
    }

    private static File root(Context context) {
        return new File(context.getCacheDir(), "shares");
    }

    private static File shareDir(Context context, String id) throws IOException {
        if (id == null || !ID.matcher(id).matches()) throw new IOException("No such share");
        return new File(root(context), id);
    }

    /** Shares nobody took within a day (the app was never opened signed in) are dropped. */
    private static void prune(File root) {
        File[] shares = root.listFiles(File::isDirectory);
        long now = System.currentTimeMillis();
        for (int i = 0; shares != null && i < shares.length; i++) {
            String name = shares[i].getName();
            try {
                if (now - Long.parseLong(name.substring(0, name.indexOf('-'))) > KEEP_MS) delete(shares[i]);
            } catch (RuntimeException e) {
                delete(shares[i]);
            }
        }
    }

    private static String readText(File file) throws IOException {
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            byte[] bytes = new byte[(int) in.length()];
            in.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        for (int i = 0; children != null && i < children.length; i++) delete(children[i]);
        file.delete();
    }
}
