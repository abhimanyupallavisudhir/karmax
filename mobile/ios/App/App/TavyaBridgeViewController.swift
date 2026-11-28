import Capacitor
import UIKit

/// The app's Capacitor bridge. Registers the plugins that live in this app
/// target rather than in an npm package (Main.storyboard and SceneDelegate
/// both use this class).
class TavyaBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TavyaSignInPlugin())
        bridge?.registerPluginInstance(SpeechRecognitionPlugin())
        bridge?.registerPluginInstance(TavyaPhonePlugin())
        // Links an App Intent made while the app was starting.
        TavyaLinks.bridgeReady()
    }
}
