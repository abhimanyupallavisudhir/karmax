import Foundation

/// What the app and its Share Extension share, through the app group
/// `group.io.tavya.app` (wiki features/phone-apps § Share to tavya). Compiled
/// into both targets.
enum TavyaShared {
    static let appGroup = "group.io.tavya.app"
    /// The console's attachment limits (web/app.js SHARE_FILE_LIMIT_BYTES): a file over this is listed, not copied.
    static let fileLimitBytes: Int64 = 50 * 1024 * 1024
    static let maxFiles = 20

    /// The app group's folder; this app's own caches when the build has no app group (an unsigned simulator build).
    static var container: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    }

    static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }
}

/// Shares waiting for the console, one folder each: `share.json` {id, text,
/// files: [{name, type, size, file?}]} beside the copied files. Written by the
/// extension (atomically: the JSON last), read and deleted by the app. The
/// same layout as Android's ShareInbox.
enum ShareInbox {
    static var root: URL { TavyaShared.container.appendingPathComponent("Shares", isDirectory: true) }
    private static let keepSeconds: TimeInterval = 24 * 60 * 60

    struct File: Codable {
        var name: String
        var type: String
        var size: Int64
        var file: String?
    }

    struct Share: Codable {
        var id: String
        var text: String
        var files: [File]
    }

    static func newId() -> String {
        "\(Int64(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.lowercased())"
    }

    static func folder(_ id: String) throws -> URL {
        guard id.range(of: "^[0-9]{13}-[0-9a-f-]{36}$", options: .regularExpression) != nil else {
            throw CocoaError(.fileNoSuchFile)
        }
        return root.appendingPathComponent(id, isDirectory: true)
    }

    static func save(_ share: Share) throws {
        let dir = try folder(share.id)
        let partial = dir.appendingPathComponent("share.json.part")
        try JSONEncoder().encode(share).write(to: partial, options: .atomic)
        try FileManager.default.moveItem(at: partial, to: dir.appendingPathComponent("share.json"))
    }

    /// The oldest complete share, if any.
    static func oldest() -> Share? {
        prune()
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).sorted()
        for name in names {
            guard let dir = try? folder(name) else { continue }
            if let data = try? Data(contentsOf: dir.appendingPathComponent("share.json")),
               let share = try? JSONDecoder().decode(Share.self, from: data) {
                return share
            }
        }
        return nil
    }

    static func finish(_ id: String) throws {
        let dir = try folder(id)
        try? FileManager.default.removeItem(at: dir)
    }

    /// Shares nobody took within a day are dropped.
    static func prune() {
        let now = Date().timeIntervalSince1970
        for name in (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? [] {
            let stamp = Double(name.split(separator: "-").first ?? "") ?? 0
            if now - stamp / 1000 > keepSeconds { try? FileManager.default.removeItem(at: root.appendingPathComponent(name)) }
        }
    }
}
