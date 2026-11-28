package io.tavya.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import androidx.browser.customtabs.CustomTabsClient;

/**
 * Verified links (App Links) to the console open in the app; the paths that
 * are not the console's (AppLinks.EXCLUDED_PATHS: the public site, the API,
 * sign-in) go back to a browser. Android 15+ never sends those here (the
 * manifest's uri-relative-filter-group); older versions do, hence this hop.
 */
public class LinkActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Uri uri = getIntent() == null ? null : getIntent().getData();
        if (uri != null) {
            if (AppLinks.isExcluded(uri.getPath())) openInBrowser(uri);
            else startActivity(new Intent(Intent.ACTION_VIEW, uri, this, MainActivity.class));
        }
        finish();
    }

    private void openInBrowser(Uri uri) {
        Intent view = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String browser = CustomTabsClient.getPackageName(this, null);
        if (browser == null) {
            // Any browser but this app: one that opens a link to a site this app does not claim.
            for (ResolveInfo info : getPackageManager().queryIntentActivities(
                    new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/")).addCategory(Intent.CATEGORY_BROWSABLE),
                    PackageManager.MATCH_DEFAULT_ONLY)) {
                if (!getPackageName().equals(info.activityInfo.packageName)) { browser = info.activityInfo.packageName; break; }
            }
        }
        if (browser != null) view.setPackage(browser);
        try { startActivity(view); } catch (ActivityNotFoundException ignored) {}
    }
}
