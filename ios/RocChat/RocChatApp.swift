import SwiftUI
import UserNotifications

@main
struct RocChatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var authVM = AuthViewModel()
    @Environment(\.scenePhase) var scenePhase
    
    var body: some Scene {
        WindowGroup {
            Group {
                if authVM.biometricLocked {
                    BiometricLockView()
                        .environmentObject(authVM)
                } else if authVM.isAuthenticated {
                    MainTabView()
                        .environmentObject(authVM)
                        .onAppear { requestPushNotifications() }
                } else {
                    AuthView()
                        .environmentObject(authVM)
                }
            }
            .preferredColorScheme(nil) // Follow system
            .tint(.rocGold)
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .background {
                    // Re-lock if biometric is enabled
                    if authVM.biometricEnabled && authVM.biometricAvailable && authVM.isAuthenticated {
                        authVM.biometricLocked = true
                    }
                }
            }
        }
    }
    
    private func requestPushNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }
}

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
        // Prevent screen capture in task switcher
        NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil, queue: .main
        ) { _ in
            // Add a blur overlay when app goes to background
            let blurEffect = UIBlurEffect(style: .systemUltraThinMaterial)
            let blurView = UIVisualEffectView(effect: blurEffect)
            blurView.frame = UIScreen.main.bounds
            blurView.tag = 999
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first { $0.isKeyWindow }?.addSubview(blurView)
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main
        ) { _ in
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first { $0.isKeyWindow }?.viewWithTag(999)?.removeFromSuperview()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            try? await APIClient.shared.postRaw("/push/register", body: [
                "token": token,
                "platform": "apns"
            ])
        }
    }
    
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("Push registration failed: \(error.localizedDescription)")
    }
}
