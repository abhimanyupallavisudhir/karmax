import UIKit
import UniformTypeIdentifiers

/// Share to tavya (wiki features/phone-apps § Share to tavya). Copies what was
/// shared into the app group (ShareInbox) and opens the app, whose console
/// shows the new task form holding it. No network here, and nothing read into
/// memory that can be copied as a file (the extension's memory limit is
/// ~120 MB): files go disk to disk; only text and an image handed over as
/// data pass through memory.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let label = UILabel()
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        let card = UIView()
        card.backgroundColor = UIColor(red: 0x18 / 255, green: 0x12 / 255, blue: 0x20 / 255, alpha: 1)
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        label.text = "Sending to tavya…"
        label.textColor = UIColor(red: 0xF4 / 255, green: 0xED / 255, blue: 0xE0 / 255, alpha: 1)
        label.font = .preferredFont(forTextStyle: .headline)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(label)
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 300),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.topAnchor.constraint(equalTo: card.topAnchor, constant: 20),
            label.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
            label.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task { await keep() }
    }

    private func keep() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let id = ShareInbox.newId()
        do {
            let dir = try ShareInbox.folder(id)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var texts: [String] = []
            var files: [ShareInbox.File] = []
            for item in items {
                if let words = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !words.isEmpty { texts.append(words) }
                for provider in item.attachments ?? [] {
                    if let text = await Self.text(of: provider) { texts.append(text); continue }
                    guard files.count < TavyaShared.maxFiles else { continue }
                    if let file = await Self.copy(provider, into: dir, index: files.count) { files.append(file) }
                }
            }
            var seen = Set<String>()
            let text = texts.filter { seen.insert($0).inserted }.joined(separator: "\n\n")
            guard !text.isEmpty || !files.isEmpty else { throw CocoaError(.fileReadNoPermission) }
            try ShareInbox.save(.init(id: id, text: text, files: files))
        } catch {
            if let dir = try? ShareInbox.folder(id) { try? FileManager.default.removeItem(at: dir) }
            return finish("Nothing here tavya can take.")
        }
        // The app takes it from here (io.tavya.app://share → the console's new task form).
        if open(URL(string: "io.tavya.app://share")!) { finish(nil) }
        else { finish("Saved. Open tavya to finish.") }
    }

    /// Text or a web link, as words.
    private static func text(of provider: NSItemProvider) async -> String? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, !url.isFileURL {
            return url.absoluteString
        }
        if !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
           provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
            if let string = item as? String { return string.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let data = item as? Data { return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        return nil
    }

    private enum Copied {
        case file(name: String)
        case tooLarge(name: String, size: Int64)
        case unavailable
    }

    /// Copies one attachment into the share's folder, disk to disk.
    private static func copy(_ provider: NSItemProvider, into dir: URL, index: Int) async -> ShareInbox.File? {
        let typeId = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true } ?? UTType.data.identifier
        let type = UTType(typeId)
        let mime = type?.preferredMIMEType ?? "application/octet-stream"
        let stored = "f\(index)"
        let target = dir.appendingPathComponent(stored)
        let copied: Copied = await withCheckedContinuation { done in
            // The file only exists inside this callback: copy it before returning.
            _ = provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
                guard let url else { return done.resume(returning: .unavailable) }
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
                if size > TavyaShared.fileLimitBytes { return done.resume(returning: .tooLarge(name: url.lastPathComponent, size: size)) }
                do { try FileManager.default.copyItem(at: url, to: target); done.resume(returning: .file(name: url.lastPathComponent)) }
                catch { done.resume(returning: .unavailable) }
            }
        }
        let suggested = provider.suggestedName ?? ""
        switch copied {
        case .tooLarge(let name, let size):
            // Listed with its size, not copied: the app says why it is missing.
            return .init(name: safeName(suggested.isEmpty ? name : suggested, type: type, index: index), type: mime, size: size, file: nil)
        case .file(let name):
            let size = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            return .init(name: safeName(suggested.isEmpty ? name : suggested, type: type, index: index), type: mime, size: size, file: stored)
        case .unavailable:
            // An image handed over only as data (a screenshot's markup): small, so through memory.
            let data: Data? = await withCheckedContinuation { done in
                _ = provider.loadDataRepresentation(forTypeIdentifier: typeId) { data, _ in done.resume(returning: data) }
            }
            guard let data, Int64(data.count) <= TavyaShared.fileLimitBytes, (try? data.write(to: target)) != nil else { return nil }
            return .init(name: safeName(suggested, type: type, index: index), type: mime, size: Int64(data.count), file: stored)
        }
    }

    private static func safeName(_ name: String, type: UTType?, index: Int) -> String {
        var base = name.replacingOccurrences(of: "[/\\\\:*?\"<>|\\p{Cc}]", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespaces))
        if base.isEmpty { base = "shared-\(index + 1)" }
        if !base.contains("."), let ext = type?.preferredFilenameExtension { base += ".\(ext)" }
        return String(base.suffix(120))
    }

    /// Opens the app. Extensions cannot call UIApplication.open directly; the
    /// responder chain reaches the host's UIApplication, whose open method is
    /// called by selector. Returns false where that is not possible: the share
    /// then waits, and the app takes it the next time it is opened.
    private func open(_ url: URL) -> Bool {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.isKind(of: UIApplication.self), current.responds(to: selector), let method = current.method(for: selector) {
                typealias Open = @convention(c) (NSObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?) -> Void
                unsafeBitCast(method, to: Open.self)(current, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }
        return false
    }

    private func finish(_ message: String?) {
        Task { @MainActor in
            if let message {
                label.text = message
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
            extensionContext?.completeRequest(returningItems: nil)
        }
    }
}
