package io.tavya.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Share, the assistant gesture: handed to the console as links (EntryPoints).
        setIntent(EntryPoints.translate(this, getIntent(), savedInstanceState == null));
        // Local plugins must be registered before the bridge is created in super.onCreate.
        registerPlugin(TavyaSignInPlugin.class);
        registerPlugin(TavyaPhonePlugin.class);
        // An instance registers after the plugin classes from capacitor.plugins.json,
        // so this replaces the stock PushNotifications plugin (same JS name).
        bridgeBuilder.addPluginInstance(new TavyaPushNotificationsPlugin());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        Intent link = EntryPoints.translate(this, intent, true);
        setIntent(link);
        super.onNewIntent(link);
    }
}
