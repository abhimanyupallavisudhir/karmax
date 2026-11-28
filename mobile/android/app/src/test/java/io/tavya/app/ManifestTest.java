package io.tavya.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import androidx.test.core.app.ApplicationProvider;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** The phone's entry points reach the app: what the merged manifest declares. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class ManifestTest {

    private final Context context = ApplicationProvider.getApplicationContext();

    private List<String> activities(Intent intent) {
        List<String> names = new ArrayList<>();
        for (ResolveInfo info : context.getPackageManager().queryIntentActivities(intent.setPackage(context.getPackageName()), PackageManager.MATCH_DEFAULT_ONLY))
            names.add(info.activityInfo.name);
        return names;
    }

    private List<String> services(Intent intent) {
        List<String> names = new ArrayList<>();
        for (ResolveInfo info : context.getPackageManager().queryIntentServices(intent.setPackage(context.getPackageName()), 0))
            names.add(info.serviceInfo.name);
        return names;
    }

    @Test
    public void nothingGoesIntoBackups() {
        // The WebView's signed-in session must not reach Google's backups or a new phone (store review notes, Data safety).
        assertFalse((context.getApplicationInfo().flags & ApplicationInfo.FLAG_ALLOW_BACKUP) != 0);
    }

    @Test
    public void tavyaCanBeTheDigitalAssistant() {
        assertEquals(List.of(MainActivity.class.getName()), activities(new Intent(Intent.ACTION_ASSIST)));
    }

    @Test
    public void anythingCanBeSharedToIt() {
        assertEquals(List.of(MainActivity.class.getName()), activities(new Intent(Intent.ACTION_SEND).setType("text/plain")));
        assertEquals(List.of(MainActivity.class.getName()), activities(new Intent(Intent.ACTION_SEND).setType("image/jpeg")));
        assertEquals(List.of(MainActivity.class.getName()), activities(new Intent(Intent.ACTION_SEND_MULTIPLE).setType("application/pdf")));
    }

    @Test
    public void consoleLinksAndItsOwnSchemeOpenIt() {
        assertEquals(List.of(LinkActivity.class.getName()),
            activities(new Intent(Intent.ACTION_VIEW, Uri.parse("https://tavya.io/acme/website/tasks/12")).addCategory(Intent.CATEGORY_BROWSABLE)));
        assertEquals(List.of(MainActivity.class.getName()),
            activities(new Intent(Intent.ACTION_VIEW, Uri.parse("io.tavya.app://open?path=/acme")).addCategory(Intent.CATEGORY_BROWSABLE)));
        assertTrue(activities(new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/acme")).addCategory(Intent.CATEGORY_BROWSABLE)).isEmpty());
    }

    @Test
    public void theTileAndTheMessagingServiceAreThere_thePluginsOwnFcmServiceIsReplaced() {
        assertEquals(List.of(AskTileService.class.getName()), services(new Intent("android.service.quicksettings.action.QS_TILE")));
        // Firebase's own fallback service (priority -500) stays behind ours; Capacitor's is gone.
        List<String> fcm = services(new Intent("com.google.firebase.MESSAGING_EVENT"));
        assertEquals(TavyaMessagingService.class.getName(), fcm.get(0));
        assertTrue(!fcm.contains("com.capacitorjs.plugins.pushnotifications.MessagingService"));
    }
}
