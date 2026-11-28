import Foundation
import Security

/// The app's device token (wiki planned/native-apps-round-2 § contracts 3): a
/// `tvr_` refresh token of the phone's app grant, handed over by the console at
/// sign-in (`TavyaSignIn.saveDeviceToken`), for what runs outside the WebView:
/// Siri and Shortcuts (App Intents).
///
/// One Keychain item in the app group's access group, so an extension that
/// adds this file reads the same token; available after the first unlock, so
/// Siri can use it on a locked phone. The token rotates on every use and a
/// rotated one presented again signs the phone out, so every
/// read → refresh → write runs under `withLock`: a lock file in the app
/// group, held across processes (the app and any extension).
enum DeviceToken {
    private static let service = "io.tavya.app.device-token"
    private static let account = "device"

    static func read() -> String? {
        var query = base(group: true)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecMissingEntitlement {
            query = base(group: false)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            status = SecItemCopyMatching(query as CFDictionary, &item)
        }
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) throws {
        guard token.hasPrefix("tvr_"), let data = token.data(using: .utf8) else { throw TavyaServerError.refused("not a device token") }
        for group in [true, false] {
            let query = base(group: group)
            var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var add = query
                add[kSecValueData as String] = data
                add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                status = SecItemAdd(add as CFDictionary, nil)
            }
            // A build without the app group (an unsigned simulator build) keeps it in the app's own Keychain.
            if status == errSecMissingEntitlement && group { continue }
            guard status == errSecSuccess else { throw TavyaServerError.refused("Keychain error \(status)") }
            return
        }
    }

    static func clear() {
        SecItemDelete(base(group: true) as CFDictionary)
        SecItemDelete(base(group: false) as CFDictionary)
    }

    /// Runs `body` holding the device token's lock (flock on a file in the app group).
    static func withLock<T>(_ body: () throws -> T) rethrows -> T {
        let path = TavyaShared.container.appendingPathComponent("device-token.lock").path
        let fd = open(path, O_CREAT | O_RDWR, 0o600)
        if fd >= 0 { flock(fd, LOCK_EX) }
        defer { if fd >= 0 { flock(fd, LOCK_UN); close(fd) } }
        return try body()
    }

    private static func base(group: Bool) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account]
        if group { query[kSecAttrAccessGroup as String] = TavyaShared.appGroup }
        return query
    }
}
