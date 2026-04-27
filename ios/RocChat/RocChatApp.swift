import SwiftUI
import UserNotifications

@main
struct RocChatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var authVM = AuthViewModel()
    @Environment(\.scenePhase) var scenePhase
    @State private var isObscured = false
    @State private var showSplash = true

    var body: some Scene {
        WindowGroup {
            ZStack {
                Group {
                    if authVM.biometricLocked {
                        BiometricLockView()
                            .environmentObject(authVM)
                    } else if authVM.isAuthenticated {
                        MainTabView()
                            .environmentObject(authVM)
                            .onAppear {
                                requestPushNotifications()
                                Task { await KeyRotationManager.shared.performMaintenance() }
                                // Open the always-on user-inbox WS so calls
                                // reach us no matter which conversation is open.
                                InboxWebSocket.shared.connect()
                                InboxWebSocket.shared.addListener { type, payload in
                                    Task { @MainActor in
                                        let cm = CallManager.shared
                                        switch type {
                                        case "call_offer":
                                            cm.handleIncomingOffer(
                                                payload: payload,
                                                conversationId: (payload["conversationId"] as? String) ?? "",
                                                ws: InboxWebSocket.shared.task,
                                            )
                                        case "call_answer":
                                            cm.handleCallAnswer(payload: payload)
                                        case "call_ice":
                                            cm.handleIceCandidate(payload: payload)
                                        case "call_end":
                                            cm.handleCallEnd(payload: payload)
                                        case "call_audio":
                                            cm.handleCallAudio(payload: payload)
                                        case "call_video":
                                            cm.handleCallVideo(payload: payload)
                                        case "call_p2p_candidate":
                                            cm.handleP2PCandidate(payload: payload)
                                        default:
                                            break
                                        }
                                    }
                                }
                            }
                    } else {
                        AuthView()
                            .environmentObject(authVM)
                    }
                }

                // Splash screen overlay — dismiss after 0.8s minimum
                if showSplash {
                    SplashView()
                        .transition(.opacity)
                        .zIndex(999)
                }
            }
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    withAnimation(.easeOut(duration: 0.5)) {
                        showSplash = false
                    }
                }
            }
            .preferredColorScheme(nil) // Follow system
            .tint(.rocGold)
            // Screenshot / app-switcher blur overlay
            .overlay {
                if isObscured {
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .ignoresSafeArea()
                        .transition(.opacity)
                }
            }
            .onChange(of: scenePhase) { _, newPhase in
                withAnimation(.easeInOut(duration: 0.15)) {
                    isObscured = (newPhase == .inactive || newPhase == .background)
                }
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
        let center = UNUserNotificationCenter.current()
        // Register delegate + reply category BEFORE asking for permission so
        // that any cached notifications immediately surface the action.
        center.delegate = appDelegate
        registerNotificationCategories(on: center)
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    /// Inline reply + mark-as-read action shown on lock screen / banner.
    /// Replies are best-effort: the action lands in `userNotificationCenter(_:didReceive:)`
    /// where we POST the plaintext to `/messages` so server-side ratchet
    /// encryption + relay happens. End-to-end encryption from the lock
    /// screen would require a Notification Service Extension with a
    /// shared App Group keychain — tracked separately.
    private func registerNotificationCategories(on center: UNUserNotificationCenter) {
        let reply = UNTextInputNotificationAction(
            identifier: "REPLY_ACTION",
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Message"
        )
        let markRead = UNNotificationAction(
            identifier: "MARK_READ_ACTION",
            title: "Mark as Read",
            options: []
        )
        let category = UNNotificationCategory(
            identifier: "MESSAGE_CATEGORY",
            actions: [reply, markRead],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
        center.setNotificationCategories([category])
    }
}

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
        // Install a lightweight crash reporter — writes uncaught NSExceptions
        // and fatal signals to a local file under Application Support so that
        // the next launch can surface/upload them. No third-party SDK.
        CrashReporter.install()
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

    /// Silent / background push: fetch any pending messages and finish fast so
    /// iOS keeps granting us background wake-ups. Must call completionHandler.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable : Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        Task {
            do {
                // Trigger a sync so the conversation list / unread counts refresh
                // if the user opens the app shortly after the push arrives.
                _ = try await APIClient.shared.getRaw("/conversations")
                completionHandler(.newData)
            } catch {
                completionHandler(.failed)
            }
        }
    }

    // MARK: - Foreground presentation + action handling

    /// Show banners/sound even while the app is foregrounded so the user
    /// notices messages from inactive conversations.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .badge, .list])
    }

    /// Quick-reply / mark-as-read action dispatch. The push payload is
    /// expected to include `conversation_id` (set by the backend).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let conversationId = (info["conversation_id"] as? String) ?? (info["conversationId"] as? String) ?? ""

        switch response.actionIdentifier {
        case "REPLY_ACTION":
            if let textResponse = response as? UNTextInputNotificationResponse,
               !conversationId.isEmpty {
                let body = textResponse.userText
                Task {
                    // Server-side ratchet send. End-to-end encrypted reply
                    // from a Notification Service Extension is tracked
                    // separately — requires App Group keychain sharing.
                    _ = try? await APIClient.shared.postRaw("/messages", body: [
                        "conversation_id": conversationId,
                        "body": body,
                        "client_message_id": UUID().uuidString
                    ])
                }
            }
        case "MARK_READ_ACTION":
            if !conversationId.isEmpty {
                Task {
                    _ = try? await APIClient.shared.postRaw("/messages/conversations/\(conversationId)/read", body: [:])
                }
            }
        default:
            break
        }
        completionHandler()
    }
}

// MARK: - Local crash reporter

/// Shared file path used by the C-compatible signal handler. Must be a
/// file-scope variable because `@convention(c)` closures cannot capture.
fileprivate var _crashLogPath: String?

/// Minimal on-device crash reporter. Catches uncaught Objective-C exceptions
/// and a handful of fatal POSIX signals, writes a single-line summary to
/// `Application Support/rocchat/last_crash.log`, and exits. On next launch
/// callers can inspect `CrashReporter.pendingReport()` and upload/display it.
enum CrashReporter {
    static func install() {
        NSSetUncaughtExceptionHandler { ex in
            let payload = "NSException: \(ex.name.rawValue)\nReason: \(ex.reason ?? "")\nCallStack:\n"
                + ex.callStackSymbols.joined(separator: "\n")
            try? payload.write(to: CrashReporter.logURL, atomically: true, encoding: .utf8)
        }
        // Signal handlers must be plain C function pointers — no captured
        // context. We stash the URL at install time via a file-scope global.
        _crashLogPath = CrashReporter.logURL.path
        let handler: @convention(c) (Int32) -> Void = { s in
            let symbols = Thread.callStackSymbols.joined(separator: "\n")
            let payload = "Signal: \(s)\n" + symbols
            if let path = _crashLogPath,
               let data = payload.data(using: .utf8) {
                // Write atomically enough for our purposes — the default
                // handler will re-raise immediately after this returns.
                try? data.write(to: URL(fileURLWithPath: path))
            }
            signal(s, SIG_DFL)
            raise(s)
        }
        for sig in [SIGABRT, SIGILL, SIGSEGV, SIGFPE, SIGBUS, SIGPIPE] {
            signal(sig, handler)
        }
    }

    fileprivate static var logURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("rocchat", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("last_crash.log")
    }

    static func pendingReport() -> String? {
        let url = logURL
        guard let data = try? Data(contentsOf: url),
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }

    static func clear() {
        try? FileManager.default.removeItem(at: logURL)
    }
}
