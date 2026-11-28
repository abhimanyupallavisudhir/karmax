package io.tavya.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** The phone's ways in become links the console's openAppLink handles. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class EntryPointsTest {

    private final Context context = ApplicationProvider.getApplicationContext();

    @Test
    public void theAssistantGestureOpensAskListening() {
        Intent link = EntryPoints.translate(context, new Intent(Intent.ACTION_ASSIST), true);
        assertEquals(Intent.ACTION_VIEW, link.getAction());
        assertEquals("io.tavya.app://ask?voice=1", link.getDataString());
    }

    @Test
    public void aShareBecomesTheShareLink() {
        Intent share = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "hi");
        Intent link = EntryPoints.translate(context, share, false);
        assertEquals(Intent.ACTION_VIEW, link.getAction());
        assertEquals("io.tavya.app://share", link.getDataString());
    }

    @Test
    public void everythingElseIsLeftAlone() {
        Intent signedIn = new Intent(Intent.ACTION_VIEW, Uri.parse("io.tavya.app://signed-in?code=x"));
        assertSame(signedIn, EntryPoints.translate(context, signedIn, true));
        Intent launcher = new Intent(Intent.ACTION_MAIN);
        assertSame(launcher, EntryPoints.translate(context, launcher, true));
    }
}
