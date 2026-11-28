package io.tavya.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.test.core.app.ApplicationProvider;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

/** Share to tavya: what Android's share sheet hands the app, as the console takes it. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class ShareInboxTest {

    private final Context context = ApplicationProvider.getApplicationContext();

    private JSONObject take() throws Exception {
        AtomicReference<JSONObject> share = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        ShareInbox.whenKept(() -> { share.set(ShareInbox.oldest(context)); done.countDown(); });
        assertTrue(done.await(10, TimeUnit.SECONDS));
        return share.get();
    }

    private Uri provide(String name, byte[] bytes) {
        Uri uri = Uri.parse("content://com.example.files/shared/" + name);
        Shadows.shadowOf(context.getContentResolver()).registerInputStream(uri, new ByteArrayInputStream(bytes));
        return uri;
    }

    @Test
    public void aLinkFromABrowserIsItsTitleAndItsAddress() throws Exception {
        Intent intent = new Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, "Release notes").putExtra(Intent.EXTRA_TEXT, "https://example.com/notes");
        ShareInbox.receive(context, intent);
        JSONObject share = take();
        assertEquals("Release notes\n\nhttps://example.com/notes", share.getString("text"));
        assertEquals(0, share.getJSONArray("files").length());
        ShareInbox.finish(context, share.getString("id"));
        assertNull(take());
    }

    @Test
    public void filesAreKeptAndReadBackInChunksThenLetGo() throws Exception {
        byte[] big = new byte[3 * 1024 * 1024 + 17];
        for (int i = 0; i < big.length; i++) big[i] = (byte) (i * 31);
        Intent intent = new Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(Arrays.asList(
                provide("photo.jpg", big), provide("notes.txt", "hello".getBytes(StandardCharsets.UTF_8)))));
        ShareInbox.receive(context, intent);
        JSONObject share = take();
        JSONArray files = share.getJSONArray("files");
        assertEquals(2, files.length());
        assertEquals("photo.jpg", files.getJSONObject(0).getString("name"));
        assertEquals(big.length, files.getJSONObject(0).getLong("size"));
        assertFalse(files.getJSONObject(0).has("file")); // where it is stays native
        ByteArrayOutputStream read = new ByteArrayOutputStream();
        int chunks = 0;
        for (long offset = 0; ; chunks++) {
            JSONObject chunk = ShareInbox.read(context, share.getString("id"), 0, offset, 512 * 1024);
            byte[] bytes = Base64.decode(chunk.getString("data"), Base64.NO_WRAP);
            read.write(bytes);
            offset += bytes.length;
            if (chunk.getBoolean("eof")) break;
        }
        assertTrue(chunks > 5);
        assertTrue(Arrays.equals(big, read.toByteArray()));
        assertEquals("hello", new String(Base64.decode(ShareInbox.read(context, share.getString("id"), 1, 0, 100).getString("data"), Base64.NO_WRAP), StandardCharsets.UTF_8));
        ShareInbox.finish(context, share.getString("id"));
        assertNull(take());
    }

    @Test
    public void anIdThatIsAPathIsRefused() {
        for (String id : new String[] { "../../shared_prefs", "x", null }) {
            try { ShareInbox.read(context, id, 0, 0, 10); throw new AssertionError("read " + id); }
            catch (java.io.IOException expected) { /* refused */ }
            catch (org.json.JSONException e) { throw new AssertionError(e); }
        }
    }

    @Test
    public void onlyContentFromAProviderIsTaken_neverAFileOfThisApp() {
        Intent intent = new Intent(Intent.ACTION_SEND).setType("*/*")
            .putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///data/data/io.tavya.app/shared_prefs/tavya-device.xml"));
        assertEquals(0, ShareInbox.streams(intent).size());
    }

    @Test
    public void namesAreFileNames() {
        assertEquals("report.pdf", ShareInbox.safeName("report.pdf", "application/pdf", 0));
        assertEquals("a_b_c.txt", ShareInbox.safeName("a/b\\c.txt", "text/plain", 0));
        assertEquals("shared-3", ShareInbox.safeName(null, null, 2));
        assertEquals("profile", ShareInbox.safeName("..profile", null, 0));
    }
}
