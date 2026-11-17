import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Push goes through Firebase Cloud Messaging (APNs via FCM). CI writes
        // App/Firebase/GoogleService-Info.plist from a secret (the Firebase
        // folder is copied into the bundle as is); a build without it still
        // runs, and push registration reports that it isn't set up.
        if let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist", inDirectory: "Firebase"),
           let options = FirebaseOptions(contentsOfFile: path) {
            FirebaseApp.configure(options: options)
        }
        return true
    }

    // MARK: Push notifications (@capacitor/push-notifications)
    //
    // The server sends through FCM, so the app hands it an FCM registration
    // token, not the raw APNs device token: give Firebase the APNs token, ask
    // it for the FCM token and pass that to the plugin ("registration" event).
    // FirebaseAppDelegateProxyEnabled is NO in Info.plist, so this is the only
    // path the APNs token takes.

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard FirebaseApp.app() != nil else {
            NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: PushSetupError.notConfigured)
            return
        }
        Messaging.messaging().apnsToken = deviceToken
        Messaging.messaging().token { token, error in
            if let token = token {
                NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: token)
            } else {
                NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error ?? PushSetupError.noToken)
            }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

enum PushSetupError: LocalizedError {
    case notConfigured
    case noToken

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Push isn't set up in this build"
        case .noToken:
            return "Firebase returned no registration token"
        }
    }
}
