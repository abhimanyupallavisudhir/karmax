package io.tavya.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * System-browser sign-in.
 *
 * JS: Capacitor.Plugins.TavyaSignIn.open({ url, callbackScheme: 'io.tavya.app' })
 *   resolves { url } with the full callback URL the browser was sent to
 *   (io.tavya.app://signed-in?code=…&state=…), or rejects with code
 *   'cancelled' when the person closes the browser without finishing.
 *
 * The page opens in a Custom Tab, which shares the default browser's cookies,
 * so a person already signed in to their identity provider taps once. The
 * provider's redirect to io.tavya.app://signed-in matches MainActivity's
 * intent filter; MainActivity is singleTask, so the intent comes back to this
 * activity (onNewIntent) and the Custom Tab above it is closed. Android always
 * delivers onNewIntent before onResume, so a real callback resolves the call
 * first, and an onResume that finds the call still pending means the person
 * came back without finishing (closed the tab, pressed back).
 *
 * The callback URL is not trusted by this plugin: any app can fire the same
 * intent. The console must check `state` (and use PKCE) before using `code`.
 */
@CapacitorPlugin(name = "TavyaSignIn")
public class TavyaSignInPlugin extends Plugin {

    static final String CALLBACK_SCHEME = "io.tavya.app";
    static final String CALLBACK_HOST = "signed-in";

    private PluginCall pending;
    // Set once the activity has actually been covered by the browser, so a
    // resume that happens before the tab appears can't cancel the sign-in.
    private boolean browserShown;

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String scheme = call.getString("callbackScheme", CALLBACK_SCHEME);
        if (url == null || url.isEmpty()) {
            call.reject("url is required", "invalid");
            return;
        }
        Uri uri = Uri.parse(url);
        String uriScheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(uriScheme) && !"http".equalsIgnoreCase(uriScheme)) {
            call.reject("url must be http(s)", "invalid");
            return;
        }
        if (!CALLBACK_SCHEME.equals(scheme)) {
            // The intent filter in AndroidManifest.xml is fixed at build time.
            call.reject("callbackScheme must be " + CALLBACK_SCHEME, "invalid");
            return;
        }
        if (pending != null) {
            pending.reject("Another sign-in was started", "cancelled");
        }
        pending = call;
        browserShown = false;
        getActivity().runOnUiThread(() -> {
            try {
                CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(true).setShareState(CustomTabsIntent.SHARE_STATE_OFF).build();
                tab.launchUrl(getActivity(), uri);
            } catch (ActivityNotFoundException e) {
                finish(null, "No browser is installed to sign in with", "unavailable");
            }
        });
    }

    /**
     * The device token for native surfaces (wiki planned/native-apps-round-2
     * § contracts 3): kept encrypted with a Keystore key (DeviceToken), used
     * only by TavyaServer, never handed back to the page.
     */
    @PluginMethod
    public void saveDeviceToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null || !token.startsWith("tvr_")) {
            call.reject("token must be a device token", "invalid");
            return;
        }
        try {
            DeviceToken.save(getContext(), token);
            TavyaServer.of(getContext()).forget();
            call.resolve();
        } catch (RuntimeException e) {
            call.reject(e.getMessage(), "unavailable");
        }
    }

    @PluginMethod
    public void clearDeviceToken(PluginCall call) {
        DeviceToken.clear(getContext());
        TavyaServer.of(getContext()).forget();
        call.resolve();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (pending == null || intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri data = intent.getData();
        if (data == null || !CALLBACK_SCHEME.equals(data.getScheme()) || !CALLBACK_HOST.equals(data.getHost())) {
            return;
        }
        finish(data.toString(), null, null);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (pending != null) {
            browserShown = true;
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (pending != null && browserShown) {
            finish(null, "Sign-in was cancelled", "cancelled");
        }
    }

    private void finish(String callbackUrl, String error, String code) {
        PluginCall call = pending;
        pending = null;
        browserShown = false;
        if (call == null) {
            return;
        }
        if (callbackUrl != null) {
            JSObject result = new JSObject();
            result.put("url", callbackUrl);
            call.resolve(result);
        } else {
            call.reject(error, code);
        }
    }
}
