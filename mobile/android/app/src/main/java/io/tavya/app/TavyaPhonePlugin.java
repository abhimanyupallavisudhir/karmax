package io.tavya.app;

import android.app.role.RoleManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * The phone's own surfaces, for the console (web/app.js `// ── the phone apps`;
 * wiki features/phone-apps § Entry points). Same methods on iOS.
 *
 *   takeShare() → {share: {id, text, files: [{name, type, size}]} | null}
 *   readShareFile({id, index, offset, length}) → {data: base64, eof}
 *   finishShare({id})
 *   setContext({organizationId|null, forMe}) — what the widget shows
 *   assistant() → {available, held} — the digital-assistant role
 *   openAssistantSettings() — the system's choice of assistant app
 */
@CapacitorPlugin(name = "TavyaPhone")
public class TavyaPhonePlugin extends Plugin {

    @PluginMethod
    public void takeShare(PluginCall call) {
        Context context = getContext();
        ShareInbox.whenKept(() -> {
            JSONObject share = ShareInbox.oldest(context);
            JSObject result = new JSObject();
            result.put("share", share == null ? JSONObject.NULL : share);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void readShareFile(PluginCall call) {
        try {
            JSONObject chunk = ShareInbox.read(getContext(), call.getString("id"), call.getInt("index", -1),
                call.getLong("offset", 0L), call.getInt("length", ShareInbox.MAX_CHUNK_BYTES));
            call.resolve(JSObject.fromJSONObject(chunk));
        } catch (Exception e) {
            call.reject(e.getMessage(), "unavailable");
        }
    }

    @PluginMethod
    public void finishShare(PluginCall call) {
        try {
            ShareInbox.finish(getContext(), call.getString("id"));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), "unavailable");
        }
    }

    @PluginMethod
    public void setContext(PluginCall call) {
        String organizationId = call.getString("organizationId");
        PhoneState.setContext(getContext(), organizationId == null || organizationId.isEmpty() ? null : organizationId, call.getInt("forMe", 0));
        call.resolve();
    }

    @PluginMethod
    public void assistant(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT >= 29) {
            RoleManager roles = getContext().getSystemService(RoleManager.class);
            boolean available = roles != null && roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT);
            result.put("available", available);
            result.put("held", available && roles.isRoleHeld(RoleManager.ROLE_ASSISTANT));
        } else {
            String current = Settings.Secure.getString(getContext().getContentResolver(), "assistant");
            result.put("available", true);
            result.put("held", current != null && current.startsWith(getContext().getPackageName() + "/"));
        }
        call.resolve(result);
    }

    @PluginMethod
    public void openAssistantSettings(PluginCall call) {
        // The assistant role cannot be asked for in a dialog; the person picks it in Settings → Default apps.
        for (String action : new String[] { Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, Settings.ACTION_SETTINGS }) {
            try {
                getActivity().startActivity(new Intent(action));
                call.resolve();
                return;
            } catch (ActivityNotFoundException ignored) {}
        }
        call.reject("This phone has no setting for its assistant app", "unavailable");
    }
}
