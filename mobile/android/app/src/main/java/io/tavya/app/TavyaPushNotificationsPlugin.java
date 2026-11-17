package io.tavya.app;

import android.Manifest;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * @capacitor/push-notifications, made safe for builds without Firebase.
 *
 * Without android/app/google-services.json there is no Firebase app, and the
 * stock plugin's register()/unregister() throw inside the bridge, which
 * Capacitor rethrows and the app crashes. This subclass reports the same
 * "registrationError" the iOS app sends in that case instead; with Firebase
 * configured it is the stock plugin. MainActivity registers it as an instance,
 * which replaces the class Capacitor registers from capacitor.plugins.json
 * (same JS name, PushNotifications).
 */
@CapacitorPlugin(
    name = "PushNotifications",
    // Same permission alias as the stock plugin; annotations are not inherited.
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "receive")
)
public class TavyaPushNotificationsPlugin extends PushNotificationsPlugin {

    static final String NOT_SET_UP = "Push isn't set up in this build";

    // The google-services Gradle plugin generates this resource from
    // google-services.json; Firebase initialises itself from it at start-up.
    private boolean firebaseConfigured() {
        return getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName()) != 0;
    }

    @Override
    @PluginMethod
    public void register(PluginCall call) {
        if (!firebaseConfigured()) {
            call.resolve();
            sendError(NOT_SET_UP);
            return;
        }
        super.register(call);
    }

    @Override
    @PluginMethod
    public void unregister(PluginCall call) {
        if (!firebaseConfigured()) {
            call.resolve();
            return;
        }
        super.unregister(call);
    }
}
