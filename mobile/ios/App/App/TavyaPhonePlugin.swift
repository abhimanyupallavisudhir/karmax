import Capacitor
import Foundation

/// The phone's own surfaces, for the console (web/app.js `// ── the phone apps`;
/// wiki features/phone-apps § Entry points). Same methods as Android's.
///
///   takeShare() → {share: {id, text, files: [{name, type, size}]} | null}
///   readShareFile({id, index, offset, length}) → {data: base64, eof}
///   finishShare({id})
///   setContext({organizationId|null, forMe}) — the organization Siri asks in
///   assistant() → {available: false}: iOS has no assistant role (Siri asks tavya through App Shortcuts)
@objc(TavyaPhonePlugin)
public class TavyaPhonePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TavyaPhonePlugin"
    public let jsName = "TavyaPhone"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "takeShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readShareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setContext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "assistant", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAssistantSettings", returnType: CAPPluginReturnPromise)
    ]

    static let maxChunkBytes = 1024 * 1024

    @objc func takeShare(_ call: CAPPluginCall) {
        guard let share = ShareInbox.oldest() else { return call.resolve(["share": NSNull()]) }
        let files: [[String: Any]] = share.files.map { file -> [String: Any] in ["name": file.name, "type": file.type, "size": file.size] }
        let shared: [String: Any] = ["id": share.id, "text": share.text, "files": files]
        call.resolve(["share": shared])
    }

    @objc func readShareFile(_ call: CAPPluginCall) {
        do {
            guard let id = call.getString("id") else { throw CocoaError(.fileNoSuchFile) }
            let dir = try ShareInbox.folder(id)
            let share = try JSONDecoder().decode(ShareInbox.Share.self, from: Data(contentsOf: dir.appendingPathComponent("share.json")))
            let index = call.getInt("index") ?? -1
            guard share.files.indices.contains(index), let stored = share.files[index].file else { throw CocoaError(.fileNoSuchFile) }
            let handle = try FileHandle(forReadingFrom: dir.appendingPathComponent(stored))
            defer { try? handle.close() }
            let size = try handle.seekToEnd()
            let offset = UInt64(max(0, call.getDouble("offset") ?? 0))
            let from = min(offset, size)
            try handle.seek(toOffset: from)
            let length = max(0, min(call.getInt("length") ?? Self.maxChunkBytes, Self.maxChunkBytes))
            let chunk = try handle.read(upToCount: length) ?? Data()
            call.resolve(["data": chunk.base64EncodedString(), "eof": from + UInt64(chunk.count) >= size])
        } catch {
            call.reject("That shared file is gone", "unavailable")
        }
    }

    @objc func finishShare(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), (try? ShareInbox.finish(id)) != nil else { return call.reject("No such share", "unavailable") }
        call.resolve()
    }

    @objc func setContext(_ call: CAPPluginCall) {
        PhoneContext.organizationId = call.getString("organizationId").flatMap { $0.isEmpty ? nil : $0 }
        call.resolve()
    }

    @objc func assistant(_ call: CAPPluginCall) {
        call.resolve(["available": false, "held": false])
    }

    @objc func openAssistantSettings(_ call: CAPPluginCall) {
        call.reject("iPhone has no assistant app setting; ask Siri “Ask tavya”", "unavailable")
    }
}

/// The organization the person last used in the app: where Siri asks and reads For me.
enum PhoneContext {
    static var organizationId: String? {
        get { TavyaShared.defaults.string(forKey: "organizationId") }
        set { TavyaShared.defaults.set(newValue, forKey: "organizationId") }
    }
}

/// Links into the console from native code (App Intents that open the app):
/// handed to Capacitor's App plugin, which passes them to the page as
/// `appUrlOpen` (web/app.js openAppLink), keeping them until the page listens.
/// Before the bridge exists (the app is starting), they wait here.
@MainActor
enum TavyaLinks {
    private static var pending: [URL] = []
    private static var ready = false

    static func open(_ url: URL) {
        if ready { post(url) } else { pending.append(url) }
    }

    /// The bridge and its plugins are loaded (TavyaBridgeViewController).
    static func bridgeReady() {
        ready = true
        pending.forEach(post)
        pending.removeAll()
    }

    private static func post(_ url: URL) {
        let opened: [String: Any] = ["url": url as NSURL, "options": [String: Any]()]
        NotificationCenter.default.post(name: .capacitorOpenURL, object: opened)
    }
}
