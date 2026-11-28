package io.tavya.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The app's device token (wiki planned/native-apps-round-2 § contracts 3): a
 * tvr_ refresh token of the phone's app grant, handed over by the console at
 * sign-in through TavyaSignIn.saveDeviceToken, for what runs outside the
 * WebView (the widget's count, a push-woken refresh).
 *
 * Kept encrypted with an AES-GCM key that never leaves the Android Keystore,
 * in this app's private preferences. It rotates on every use and presenting a
 * rotated one signs the phone out, so every read-refresh-write goes through
 * TavyaServer's single lock in this one process.
 */
final class DeviceToken {

    private static final String PREFS = "tavya-device";
    private static final String ENTRY = "token";
    private static final String KEY_ALIAS = "tavya-device-token";
    private static final int IV_BYTES = 12;

    private DeviceToken() {}

    static synchronized void save(Context context, String token) {
        if (token == null || !token.startsWith("tvr_")) throw new IllegalArgumentException("not a device token");
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            byte[] stored = ByteBuffer.allocate(iv.length + sealed.length).put(iv).put(sealed).array();
            // commit(), not apply(): the server has already rotated the old token away.
            prefs(context).edit().putString(ENTRY, Base64.encodeToString(stored, Base64.NO_WRAP)).commit();
        } catch (Exception e) {
            throw new IllegalStateException("Could not keep the device token", e);
        }
    }

    /** The token, or null when there is none (signed out) or it can no longer be read. */
    static synchronized String read(Context context) {
        String stored = prefs(context).getString(ENTRY, null);
        if (stored == null) return null;
        try {
            byte[] bytes = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, bytes, 0, IV_BYTES));
            return new String(cipher.doFinal(bytes, IV_BYTES, bytes.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // A restored backup or a reset Keystore: the key is gone, so is the token.
            clear(context);
            return null;
        }
    }

    static synchronized void clear(Context context) {
        prefs(context).edit().remove(ENTRY).commit();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
