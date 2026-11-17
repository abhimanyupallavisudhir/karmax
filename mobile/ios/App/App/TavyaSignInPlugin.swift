import AuthenticationServices
import Capacitor
import UIKit

/// System-browser sign-in.
///
/// JS: `Capacitor.Plugins.TavyaSignIn.open({ url, callbackScheme: 'io.tavya.app' })`
/// resolves `{ url }` with the full callback URL the browser was redirected to
/// (`io.tavya.app://signed-in?code=…&state=…`), or rejects with code
/// `cancelled` when the person closes the sheet without finishing.
///
/// ASWebAuthenticationSession shares Safari's cookies
/// (`prefersEphemeralWebBrowserSession = false`), so someone already signed in
/// to their identity provider taps once. The session itself captures the
/// redirect to the callback scheme, so the scheme is deliberately not
/// registered in Info.plist (CFBundleURLTypes): nothing else should be able to
/// open the app with it.
@objc(TavyaSignInPlugin)
public class TavyaSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "TavyaSignInPlugin"
    public let jsName = "TavyaSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    static let callbackScheme = "io.tavya.app"

    private var session: ASWebAuthenticationSession?

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            call.reject("url must be an http(s) URL", "invalid")
            return
        }
        let callbackScheme = call.getString("callbackScheme") ?? Self.callbackScheme
        guard callbackScheme == Self.callbackScheme else {
            call.reject("callbackScheme must be \(Self.callbackScheme)", "invalid")
            return
        }

        DispatchQueue.main.async {
            // Only one sheet at a time; cancelling rejects the earlier call with `cancelled`.
            self.session?.cancel()

            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                self?.session = nil
                if let callbackURL = callbackURL {
                    call.resolve(["url": callbackURL.absoluteString])
                } else if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                    call.reject("Sign-in was cancelled", "cancelled")
                } else {
                    call.reject(error?.localizedDescription ?? "Sign-in failed", "failed", error)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("Couldn't open the sign-in page", "unavailable")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = bridge?.webView?.window ?? bridge?.viewController?.view.window {
            return window
        }
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first { $0.isKeyWindow } ?? windows.first ?? ASPresentationAnchor()
    }
}
