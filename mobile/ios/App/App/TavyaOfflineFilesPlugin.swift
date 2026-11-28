import Capacitor
import CryptoKit
import Foundation
import UIKit
import WebKit

/// TavyaOfflineFiles (wiki features/offline-files): the bytes of the files the
/// console keeps offline. The console's engine (web/offline-files.js) decides
/// what to keep; this stores, serves and forgets bytes, the same JS interface
/// as the Android and desktop plugins:
///
///   download({url, version, size, blob?}) → {hash, size}
///   list() → {files: [{hash, size}], bytes, free} · remove({hashes}) · wipe()
///   url({hash}) → {url: null}: WKWebView can't answer https itself, so the
///     page reads the bytes in 1 MiB chunks with read()
///   read({hash, offset, length}) → {data: base64, eof} · open({hash, name})
///
/// Bytes live in Application Support, excluded from backup, with
/// NSFileProtectionCompleteUntilFirstUserAuthentication. A download goes
/// through URLSession with the WebView's cookies (the console's session) and
/// If-Match on the version, lands in a temp file, is checked (its size, and its
/// Git blob id when given), then moved to its SHA-256: the old copy stays
/// readable until the console lets it go.
@objc(TavyaOfflineFilesPlugin)
public class TavyaOfflineFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentInteractionControllerDelegate {
    public let identifier = "TavyaOfflineFilesPlugin"
    public let jsName = "TavyaOfflineFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wipe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "url", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    static let maxChunkBytes = 1024 * 1024
    private let session = URLSession(configuration: .ephemeral)
    private var documents: UIDocumentInteractionController?

    struct Refusal: Error { let code: String; let message: String }

    private var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("offline-files", isDirectory: true)
    }
    private var blobs: URL { root.appendingPathComponent("blobs", isDirectory: true) }

    private func blob(_ hash: String?) throws -> URL {
        guard let hash, hash.count == 64, hash.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw Refusal(code: "invalid", message: "Not a stored file.") }
        return blobs.appendingPathComponent(hash)
    }

    /// The folder, kept out of backups and protected until the phone is first unlocked.
    private func prepare() throws {
        let manager = FileManager.default
        for folder in [root, blobs] where !manager.fileExists(atPath: folder.path) {
            try manager.createDirectory(at: folder, withIntermediateDirectories: true,
                                        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var folder = root
        try folder.setResourceValues(values)
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if let refusal = error as? Refusal { call.reject(refusal.message, refusal.code) } else { call.reject(error.localizedDescription, "failed") }
    }

    // MARK: download

    @objc func download(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let target = URL(string: raw) else { return call.reject("Not a URL.", "invalid") }
        guard let console = bridge?.config.serverURL, target.scheme == console.scheme, target.host == console.host, target.port == console.port,
              target.path.range(of: "^/api/projects/[^/]+/files/raw$", options: .regularExpression) != nil
        else { return call.reject("Not a file of this console.", "invalid") }
        let version = call.getString("version") ?? ""
        let size = call.getDouble("size").map { Int64($0) }
        let gitBlob = call.getString("blob")
        // The console's session: the WebView's cookies, read on the main thread.
        DispatchQueue.main.async {
            guard let store = self.bridge?.webView?.configuration.websiteDataStore.httpCookieStore else { return call.reject("No console.", "failed") }
            store.getAllCookies { cookies in
                var request = URLRequest(url: target)
                request.httpShouldHandleCookies = false
                let matching = cookies.filter { cookie in
                    let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
                    return target.host == domain || (cookie.domain.hasPrefix(".") && (target.host ?? "").hasSuffix(cookie.domain))
                }
                for (name, value) in HTTPCookie.requestHeaderFields(with: matching) { request.setValue(value, forHTTPHeaderField: name) }
                request.setValue("\"\(version)\"", forHTTPHeaderField: "If-Match")
                self.session.downloadTask(with: request) { location, response, error in
                    do {
                        call.resolve(try self.keep(location: location, response: response, error: error, size: size, gitBlob: gitBlob))
                    } catch { self.reject(call, error) }
                }.resume()
            }
        }
    }

    private func keep(location: URL?, response: URLResponse?, error: Error?, size: Int64?, gitBlob: String?) throws -> [String: Any] {
        if let error { throw Refusal(code: "network", message: error.localizedDescription) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200: break
        case 412: throw Refusal(code: "changed", message: "It changed on tavya meanwhile.")
        case 401, 403: throw Refusal(code: "forbidden", message: "You can’t read this any more.")
        case 404: throw Refusal(code: "missing", message: "It is not on tavya any more.")
        default: throw Refusal(code: "http", message: "tavya answered \(status).")
        }
        guard let location else { throw Refusal(code: "network", message: "The download failed.") }
        try prepare()
        defer { try? FileManager.default.removeItem(at: location) }
        let handle = try FileHandle(forReadingFrom: location)
        defer { try? handle.close() }
        var sha256 = SHA256()
        // A Git blob id is the SHA-1 of "blob <size>\0" and the bytes.
        var sha1 = Insecure.SHA1()
        if gitBlob != nil { sha1.update(data: Data("blob \(size ?? 0)\0".utf8)) }
        var received: Int64 = 0
        while let chunk = try handle.read(upToCount: 1 << 16), !chunk.isEmpty {
            sha256.update(data: chunk)
            if gitBlob != nil { sha1.update(data: chunk) }
            received += Int64(chunk.count)
        }
        if let size, received != size { throw Refusal(code: "mismatch", message: "Got \(received) bytes, not \(size).") }
        if let gitBlob, hex(sha1.finalize()) != gitBlob { throw Refusal(code: "mismatch", message: "The download is not the version asked for.") }
        let hash = hex(sha256.finalize())
        let stored = blobs.appendingPathComponent(hash)
        if !FileManager.default.fileExists(atPath: stored.path) {
            do { try FileManager.default.moveItem(at: location, to: stored) } catch {
                throw (error as NSError).code == NSFileWriteOutOfSpaceError ? Refusal(code: "space", message: "This phone is out of space.") : error
            }
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication, .posixPermissions: 0o444],
                                                  ofItemAtPath: stored.path)
        }
        return ["hash": hash, "size": received]
    }

    // MARK: the store

    @objc func list(_ call: CAPPluginCall) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: blobs.path)) ?? []
        var files: [[String: Any]] = []
        var bytes: Int64 = 0
        for name in names where name.count == 64 {
            let size = ((try? FileManager.default.attributesOfItem(atPath: blobs.appendingPathComponent(name).path))?[.size] as? NSNumber)?.int64Value ?? 0
            files.append(["hash": name, "size": size])
            bytes += size
        }
        var result: [String: Any] = ["files": files, "bytes": bytes]
        let home = URL(fileURLWithPath: NSHomeDirectory())
        if let free = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage {
            result["free"] = free
        }
        call.resolve(result)
    }

    @objc func remove(_ call: CAPPluginCall) {
        do {
            for hash in call.getArray("hashes", String.self) ?? [] {
                let file = try blob(hash)
                try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
                try? FileManager.default.removeItem(at: file)
            }
            call.resolve()
        } catch { reject(call, error) }
    }

    @objc func wipe(_ call: CAPPluginCall) {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("offline-open"))
        call.resolve()
    }

    @objc func url(_ call: CAPPluginCall) {
        call.resolve(["url": NSNull()])
    }

    @objc func read(_ call: CAPPluginCall) {
        do {
            let handle = try FileHandle(forReadingFrom: try blob(call.getString("hash")))
            defer { try? handle.close() }
            let size = try handle.seekToEnd()
            let from = min(UInt64(max(0, call.getDouble("offset") ?? 0)), size)
            try handle.seek(toOffset: from)
            let length = max(0, min(call.getInt("length") ?? Self.maxChunkBytes, Self.maxChunkBytes))
            let chunk = try handle.read(upToCount: length) ?? Data()
            call.resolve(["data": chunk.base64EncodedString(), "eof": from + UInt64(chunk.count) >= size])
        } catch let refusal as Refusal { reject(call, refusal) } catch { call.reject("Couldn’t read the copy.", "missing") }
    }

    /// Open in…: a copy with its real name, offered to Quick Look and the apps that open it.
    @objc func open(_ call: CAPPluginCall) {
        do {
            let source = try blob(call.getString("hash"))
            let name = (call.getString("name") ?? "file").replacingOccurrences(of: "/", with: "_")
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("offline-open", isDirectory: true)
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent(name.isEmpty ? "file" : name)
            try FileManager.default.copyItem(at: source, to: copy)
            DispatchQueue.main.async {
                guard let view = self.bridge?.viewController?.view else { return call.reject("No window.", "failed") }
                let controller = UIDocumentInteractionController(url: copy)
                controller.delegate = self
                self.documents = controller
                let anchor = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 1, width: 1, height: 1)
                if controller.presentOptionsMenu(from: anchor, in: view, animated: true) { call.resolve() } else { call.reject("No app on this phone opens this file.", "unavailable") }
            }
        } catch { reject(call, error) }
    }

    public func documentInteractionControllerViewControllerForPreview(_ controller: UIDocumentInteractionController) -> UIViewController {
        bridge?.viewController ?? UIViewController()
    }

    private func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}
