package io.tavya.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.StatFs;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONException;

/**
 * TavyaOfflineFiles (wiki features/offline-files): the bytes of the files the
 * console keeps offline. The console's engine (web/offline-files.js) decides
 * what to keep; this stores, serves and forgets bytes, with the same JS
 * interface as the iOS and desktop plugins:
 *
 *   download({url, version, size, blob?}) → {hash, size}
 *   list() → {files: [{hash, size}], bytes, free} · remove({hashes}) · wipe()
 *   url({hash}) → {url}: <console origin>/_capacitor_file_/<path>, which
 *     Capacitor's local server answers in the console's own origin
 *   read({hash, offset, length}) → {data: base64, eof} · open({hash, name})
 *
 * Bytes live in the app's no-backup folder (never in a backup, gone with the
 * app). A download runs off the main thread with the WebView's cookies (the
 * console's session) and If-Match on the version, lands in a temp file, is
 * checked (its size, and its Git blob id when given), then renamed to its
 * SHA-256: the old copy stays readable until the console lets it go.
 */
@CapacitorPlugin(name = "TavyaOfflineFiles")
public class TavyaOfflineFilesPlugin extends Plugin {

    private static final Pattern HASH = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern RAW_PATH = Pattern.compile("^/api/projects/[^/]+/files/raw$");
    private static final int READ_MAX = 1024 * 1024;
    private static final int TIMEOUT_MS = 60_000;

    private final ExecutorService work = Executors.newFixedThreadPool(2);

    private File root() { return new File(getContext().getNoBackupFilesDir(), "offline-files"); }
    private File blobs() { return new File(root(), "blobs"); }
    private File temp() { return new File(root(), "tmp"); }

    private File blob(String hash) throws Refusal {
        if (hash == null || !HASH.matcher(hash).matches()) throw new Refusal("invalid", "Not a stored file.");
        return new File(blobs(), hash);
    }

    /** A failure the console reads by its code. */
    private static final class Refusal extends Exception {
        final String code;
        Refusal(String code, String message) { super(message); this.code = code; }
    }

    @PluginMethod
    public void download(PluginCall call) {
        work.execute(() -> {
            try {
                call.resolve(fetch(call.getString("url"), call.getString("version", ""), call.getLong("size", -1L), call.getString("blob")));
            } catch (Refusal refusal) {
                call.reject(refusal.getMessage(), refusal.code);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "The download failed." : error.getMessage(), "failed");
            }
        });
    }

    private JSObject fetch(String url, String version, long size, String gitBlob) throws Refusal, IOException, NoSuchAlgorithmException {
        URL target;
        try { target = new URL(url); } catch (Exception e) { throw new Refusal("invalid", "Not a URL."); }
        URL console = new URL(getBridge().getLocalUrl());
        // Only the console's own files/raw, with its cookies.
        if (!console.getProtocol().equals(target.getProtocol()) || !console.getAuthority().equals(target.getAuthority())
            || !RAW_PATH.matcher(target.getPath()).matches()) throw new Refusal("invalid", "Not a file of this console.");
        blobs().mkdirs();
        temp().mkdirs();
        File scratch = new File(temp(), randomName() + ".part");
        MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
        // A Git blob id is the SHA-1 of "blob <size>\0" and the bytes.
        MessageDigest sha1 = null;
        if (gitBlob != null) {
            sha1 = MessageDigest.getInstance("SHA-1");
            sha1.update(("blob " + size + "\0").getBytes(StandardCharsets.UTF_8));
        }
        long received = 0;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) target.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) connection.setRequestProperty("Cookie", cookies);
            connection.setRequestProperty("If-Match", "\"" + version + "\"");
            int status;
            try { status = connection.getResponseCode(); } catch (IOException e) { throw new Refusal("network", e.getMessage() == null ? "No connection." : e.getMessage()); }
            if (status == 412) throw new Refusal("changed", "It changed on tavya meanwhile.");
            if (status == 401 || status == 403) throw new Refusal("forbidden", "You can’t read this any more.");
            if (status == 404) throw new Refusal("missing", "It is not on tavya any more.");
            if (status != 200) throw new Refusal("http", "tavya answered " + status + ".");
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(scratch)) {
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    sha256.update(buffer, 0, read);
                    if (sha1 != null) sha1.update(buffer, 0, read);
                    received += read;
                }
            } catch (IOException e) {
                if (e.getMessage() != null && e.getMessage().contains("ENOSPC")) throw new Refusal("space", "This phone is out of space.");
                throw new Refusal("network", e.getMessage() == null ? "The download was interrupted." : e.getMessage());
            }
            if (size >= 0 && received != size) throw new Refusal("mismatch", "Got " + received + " bytes, not " + size + ".");
            if (sha1 != null && !hex(sha1.digest()).equals(gitBlob)) throw new Refusal("mismatch", "The download is not the version asked for.");
            String hash = hex(sha256.digest());
            File stored = new File(blobs(), hash);
            if (stored.exists()) scratch.delete();
            else {
                scratch.setReadOnly();
                if (!scratch.renameTo(stored)) throw new Refusal("failed", "Couldn’t keep the file.");
            }
            JSObject result = new JSObject();
            result.put("hash", hash);
            result.put("size", received);
            return result;
        } finally {
            if (connection != null) connection.disconnect();
            if (scratch.exists()) scratch.delete();
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray files = new JSArray();
        long bytes = 0;
        File[] stored = blobs().listFiles();
        if (stored != null) for (File file : stored) {
            if (!HASH.matcher(file.getName()).matches()) continue;
            JSObject entry = new JSObject();
            entry.put("hash", file.getName());
            entry.put("size", file.length());
            files.put(entry);
            bytes += file.length();
        }
        JSObject result = new JSObject();
        result.put("files", files);
        result.put("bytes", bytes);
        try {
            File at = root().exists() ? root() : getContext().getNoBackupFilesDir();
            result.put("free", new StatFs(at.getPath()).getAvailableBytes());
        } catch (IllegalArgumentException ignored) { /* unknown */ }
        call.resolve(result);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        JSArray hashes = call.getArray("hashes", new JSArray());
        try {
            for (int i = 0; i < hashes.length(); i++) {
                File file = blob(hashes.getString(i));
                file.setWritable(true);
                file.delete();
            }
            call.resolve();
        } catch (Refusal refusal) {
            call.reject(refusal.getMessage(), refusal.code);
        } catch (JSONException e) {
            call.reject("hashes must be a list", "invalid");
        }
    }

    @PluginMethod
    public void wipe(PluginCall call) {
        deleteTree(root());
        deleteTree(new File(getContext().getCacheDir(), "offline-open"));
        call.resolve();
    }

    @PluginMethod
    public void url(PluginCall call) {
        try {
            File file = blob(call.getString("hash"));
            JSObject result = new JSObject();
            result.put("url", file.exists() ? getBridge().getLocalUrl() + "/_capacitor_file_" + file.getAbsolutePath() : null);
            call.resolve(result);
        } catch (Refusal refusal) {
            call.reject(refusal.getMessage(), refusal.code);
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        try (RandomAccessFile file = new RandomAccessFile(blob(call.getString("hash")), "r")) {
            long offset = Math.max(0, call.getLong("offset", 0L));
            int length = (int) Math.max(0, Math.min(READ_MAX, Math.min(call.getLong("length", (long) READ_MAX), file.length() - offset)));
            byte[] bytes = new byte[length];
            file.seek(offset);
            file.readFully(bytes);
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            result.put("eof", offset + length >= file.length());
            call.resolve(result);
        } catch (Refusal refusal) {
            call.reject(refusal.getMessage(), refusal.code);
        } catch (IOException e) {
            call.reject("Couldn’t read the copy.", "missing");
        }
    }

    /** Open in…: a copy with its real name (apps choose by it), through the FileProvider, to any app that views it. */
    @PluginMethod
    public void open(PluginCall call) {
        try {
            File source = blob(call.getString("hash"));
            String given = new File(call.getString("name", "file")).getName().replace('\0', '_');
            String name = given.isEmpty() ? "file" : given;
            File folder = new File(getContext().getCacheDir(), "offline-open");
            deleteTree(folder);
            folder.mkdirs();
            File copy = new File(folder, name);
            try (InputStream in = new FileInputStream(source); OutputStream out = new FileOutputStream(copy)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", copy);
            String extension = MimeTypeMap.getFileExtensionFromUrl(Uri.encode(name)).toLowerCase(Locale.ROOT);
            String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, type == null ? "application/octet-stream" : type)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().startActivity(Intent.createChooser(view, name));
                    call.resolve();
                } catch (ActivityNotFoundException e) {
                    call.reject("No app on this phone opens this file.", "unavailable");
                }
            });
        } catch (Refusal refusal) {
            call.reject(refusal.getMessage(), refusal.code);
        } catch (IOException | IllegalArgumentException e) {
            call.reject("Couldn’t open it.", "failed");
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.setWritable(true);
        file.delete();
    }

    private static String randomName() {
        byte[] bytes = new byte[8];
        new SecureRandom().nextBytes(bytes);
        return hex(bytes);
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }
}
