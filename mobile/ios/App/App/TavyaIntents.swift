import AppIntents
import Foundation

// Siri, Shortcuts and Spotlight (wiki features/phone-apps § Siri). The phrases
// carry the app's name, as App Shortcuts must; a free-text question cannot be
// in a phrase, so "Ask tavya" asks for it in a second turn (planned/wake-word).
// They act as the signed-in person through the device token (TavyaServer).

@available(iOS 16.0, *)
struct AskTavyaIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask tavya"
    static let description: IntentDescription? = IntentDescription("Ask tavya anything. It answers if it can in a few seconds, or notifies you when it has.")
    static let openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: IntentDialog("What should I ask?"))
    var question: String

    static var parameterSummary: some ParameterSummary { Summary("Ask tavya \(\.$question)") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let reply = try await TavyaAsk.ask(question)
        return .result(dialog: IntentDialog(stringLiteral: reply.map(TavyaAsk.spoken) ?? "Asked — I'll notify you."))
    }
}

@available(iOS 16.0, *)
struct NewTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "New task"
    static let description: IntentDescription? = IntentDescription("Open a new task in tavya.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        TavyaLinks.open(URL(string: "io.tavya.app://new")!)
        return .result()
    }
}

@available(iOS 16.0, *)
struct ForMeIntent: AppIntent {
    static let title: LocalizedStringResource = "What's for me"
    static let description: IntentDescription? = IntentDescription("How many tasks wait on you in tavya, and the first of them.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let (total, titles) = try await TavyaAsk.forMe()
        return .result(dialog: IntentDialog(stringLiteral: TavyaAsk.forMeSentence(total: total, titles: titles)))
    }
}

@available(iOS 16.0, *)
struct TavyaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskTavyaIntent(), phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) something"])
        AppShortcut(intent: NewTaskIntent(), phrases: ["New task in \(.applicationName)", "New \(.applicationName) task"])
        AppShortcut(intent: ForMeIntent(), phrases: ["What's for me in \(.applicationName)", "What's waiting in \(.applicationName)"])
    }
}

/// What the intents do, apart from Siri's types (so it reads like the console's own calls).
enum TavyaAsk {
    /// How long an Ask waits for its reply before Siri says it will notify (the server caps it at 10 s).
    static let replyWaitMs = 6_000

    /// The organization the person last used in the app, else their default one.
    static func organizationId() async throws -> String {
        if let id = PhoneContext.organizationId { return id }
        guard let id = try await TavyaServer.shared.get("/api/user/default-organization")["organizationId"] as? String else {
            throw TavyaServerError.refused("Open tavya first.")
        }
        return id
    }

    /// Asks as the person (POST /api/organizations/:id/ask, like the console's Ask): the reply if it came within the wait.
    static func ask(_ question: String) async throws -> String? {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw TavyaServerError.refused("Nothing to ask.") }
        let organization = try await organizationId()
        let answer = try await TavyaServer.shared.post("/api/organizations/\(escaped(organization))/ask", ["prompt": text, "waitMs": replyWaitMs])
        return (answer["reply"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    static func forMe() async throws -> (Int, [String]) {
        let organization = try await organizationId()
        let query = "for:me -is:archived".addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let list = try await TavyaServer.shared.get("/api/organizations/\(escaped(organization))/search?q=\(query)&limit=3")
        let tasks = (list["tasks"] as? [[String: Any]]) ?? []
        let total = (list["total"] as? Int) ?? tasks.count
        return (total, tasks.compactMap { $0["title"] as? String }.filter { !$0.isEmpty })
    }

    static func forMeSentence(total: Int, titles: [String]) -> String {
        if total == 0 { return "Nothing is waiting on you." }
        let count = total == 1 ? "One task is waiting on you" : "\(total) tasks are waiting on you"
        guard !titles.isEmpty else { return "\(count)." }
        let named = titles.count == 1 ? titles[0] : titles.dropLast().joined(separator: ", ") + " and " + titles.last!
        return total > titles.count ? "\(count), first: \(named)." : "\(count): \(named)."
    }

    /// A reply as Siri should say it: no Markdown, links as their words, not too long.
    static func spoken(_ reply: String) -> String {
        var text = reply
        text = text.replacingOccurrences(of: "\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: "```[\\s\\S]*?```", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "[*_`#>]", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        if text.count > 600 { text = String(text.prefix(600)) + "… The rest is in the app." }
        return text
    }

    private static func escaped(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "_-"))) ?? id
    }
}
