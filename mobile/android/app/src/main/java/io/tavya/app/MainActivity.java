package io.tavya.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge is created in super.onCreate.
        registerPlugin(TavyaSignInPlugin.class);
        // An instance registers after the plugin classes from capacitor.plugins.json,
        // so this replaces the stock PushNotifications plugin (same JS name).
        bridgeBuilder.addPluginInstance(new TavyaPushNotificationsPlugin());
        super.onCreate(savedInstanceState);
    }
}
