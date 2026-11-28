import Foundation

enum TavyaServerError: LocalizedError {
    /// No device token, or the server no longer takes it: the person signs in again in the app.
    case signedOut
    case refused(String)

    var errorDescription: String? {
        switch self {
        case .signedOut: return "Open tavya and sign in first."
        case .refused(let message): return message
        }
    }
}

/// The console's API from native code (Siri and Shortcuts), as the signed-in
/// person, through the device token. Refreshing rotates the token, so it runs
/// on one serial queue under DeviceToken's lock, the new token kept before its
/// access token is used; the access token (≤ 1 h) lives in memory only.
final class TavyaServer {
    static let shared = TavyaServer()
    static let clientId = "tavya-app"

    let origin: URL
    private let queue = DispatchQueue(label: "io.tavya.app.server")
    private var access: (token: String, expires: Date)?
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration)
    }()

    init(origin: URL = TavyaServer.configuredOrigin()) {
        self.origin = origin
    }

    /// The console this build loads (TAVYA_URL, written into capacitor.config.json by `npx cap sync`).
    static func configuredOrigin() -> URL {
        if let file = Bundle.main.url(forResource: "capacitor.config", withExtension: "json"),
           let data = try? Data(contentsOf: file),
           let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let server = config["server"] as? [String: Any],
           let url = (server["url"] as? String).flatMap(URL.init(string:)) {
            return url
        }
        return URL(string: "https://tavya.io")!
    }

    var signedIn: Bool { DeviceToken.read() != nil }

    /// A new sign-in or a sign-out: the access token goes.
    func forget() { queue.sync { access = nil } }

    func get(_ path: String) async throws -> [String: Any] { try await call("GET", path, body: nil) }

    func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] { try await call("POST", path, body: body) }

    private func call(_ method: String, _ path: String, body: [String: Any]?) async throws -> [String: Any] {
        for attempt in 0..<2 {
            let token = try await accessToken()
            guard let url = URL(string: path, relativeTo: origin) else { throw TavyaServerError.refused("Bad path") }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            request.setValue("application/json", forHTTPHeaderField: "accept")
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            // An access token the server stopped taking (its grant still alive): once more with a new one.
            if status == 401 && attempt == 0 { forget(); continue }
            guard (200..<300).contains(status) else { throw TavyaServerError.refused(json["error"] as? String ?? "HTTP \(status)") }
            return json
        }
        throw TavyaServerError.refused("Not signed in")
    }

    func accessToken() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do { continuation.resume(returning: try self.refreshIfNeeded()) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    /// On `queue` only.
    private func refreshIfNeeded() throws -> String {
        if let access, access.expires.timeIntervalSinceNow > 60 { return access.token }
        return try DeviceToken.withLock {
            guard let refresh = DeviceToken.read() else { throw TavyaServerError.signedOut }
            var request = URLRequest(url: URL(string: "/oauth/token", relativeTo: origin)!)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
            var form = URLComponents()
            form.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token"),
                               URLQueryItem(name: "client_id", value: Self.clientId),
                               URLQueryItem(name: "refresh_token", value: refresh)]
            request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
            let (data, status) = try send(request)
            let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            if (status == 400 || status == 401) && json["error"] as? String == "invalid_grant" {
                // Revoked, expired with its session, or signed out elsewhere.
                DeviceToken.clear()
                access = nil
                throw TavyaServerError.signedOut
            }
            guard status == 200, let token = json["access_token"] as? String else {
                throw TavyaServerError.refused("Could not reach tavya (\(status))")
            }
            // Kept first: the token just presented is spent.
            if let rotated = json["refresh_token"] as? String, !rotated.isEmpty { try DeviceToken.save(rotated) }
            let lifetime = max(60, (json["expires_in"] as? Double) ?? 3600)
            access = (token, Date().addingTimeInterval(lifetime))
            return token
        }
    }

    /// Blocking, on `queue` (inside the lock).
    private func send(_ request: URLRequest) throws -> (Data, Int) {
        let done = DispatchSemaphore(value: 0)
        var result: Result<(Data, Int), Error> = .failure(TavyaServerError.refused("No answer"))
        session.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) }
            else { result = .success((data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0)) }
            done.signal()
        }.resume()
        done.wait()
        return try result.get()
    }
}
