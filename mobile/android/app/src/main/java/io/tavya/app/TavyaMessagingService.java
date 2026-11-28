package io.tavya.app;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Capacitor's FCM service, plus the server's data-only refresh (sent to Android
 * phones beside each alert, src/collaboration/native-push.ts fcmRefreshBody):
 * a notification message never runs app code in the background, a data
 * message does, so the widget's count follows push arrival.
 */
public class TavyaMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        if ("refresh".equals(message.getData().get("type"))) {
            // FCM's own background thread, with seconds to spare.
            PhoneState.refreshNow(this);
            return;
        }
        super.onMessageReceived(message);
    }
}
