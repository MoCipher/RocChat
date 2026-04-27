/**
 * RocChat — User Inbox WebSocket (iOS)
 *
 * A long-lived WebSocket connection to `/api/ws/user/{userId}` that the
 * iOS app keeps open while logged in. Call signaling
 * (`call_offer`, `call_answer`, `call_ice`, `call_end`, `call_audio`,
 * `call_video`, `call_p2p_candidate`) flows through this connection so calls
 * reach the callee even when they have no conversation open.
 *
 * Per-conversation chat messages still use the conversation WS in
 * `MainTabView.swift`; this connection is purely additive.
 */

import Foundation

@MainActor
final class InboxWebSocket {
    static let shared = InboxWebSocket()

    private(set) var task: URLSessionWebSocketTask?
    private var reconnectAttempts: Int = 0
    private var manuallyClosed = false
    private var listeners: [(String, [String: Any]) -> Void] = []

    private init() {}

    /// Subscribe to inbox messages. Called by `CallManager` to dispatch
    /// `call_offer`/`call_answer`/etc.
    func addListener(_ listener: @escaping (String, [String: Any]) -> Void) {
        listeners.append(listener)
    }

    /// Open the inbox WebSocket. Idempotent.
    func connect() {
        if let t = task, t.state == .running { return }
        guard let userId = UserDefaults.standard.string(forKey: "user_id")
        else { return }

        manuallyClosed = false
        Task {
            guard let ticket = await fetchWsTicket() else {
                scheduleReconnect()
                return
            }
            guard var components = URLComponents(string: "wss://rocchat-api.spoass.workers.dev/api/ws/user/\(userId)") else {
                scheduleReconnect()
                return
            }
            components.queryItems = [
                URLQueryItem(name: "userId", value: userId),
                URLQueryItem(name: "deviceId", value: "ios"),
                URLQueryItem(name: "ticket", value: ticket),
            ]
            guard let url = components.url else { return }

            let t = APIClient.shared.webSocketTask(with: url)
            self.task = t
            t.resume()
            receive(task: t)
        }
    }

    private func fetchWsTicket() async -> String? {
        for _ in 0..<2 {
            if let data = try? await APIClient.shared.postRaw("/ws/ticket", body: [:]),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let ticket = json["ticket"] as? String {
                return ticket
            }
        }
        return nil
    }

    /// Send a JSON message over the inbox. Returns true if the WS was
    /// available; the caller can fall back to the conversation WS otherwise.
    @discardableResult
    func send(_ message: [String: Any]) -> Bool {
        guard let t = task, t.state == .running,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let str = String(data: data, encoding: .utf8) else {
            return false
        }
        t.send(.string(str)) { _ in /* errors handled by receive loop */ }
        return true
    }

    func disconnect() {
        manuallyClosed = true
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        reconnectAttempts = 0
    }

    private func receive(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self else { return }
            Task { @MainActor in
                switch result {
                case .success(let message):
                    self.handle(message: message)
                    self.receive(task: task) // continue receiving
                case .failure:
                    self.task = nil
                    if !self.manuallyClosed { self.scheduleReconnect() }
                }
            }
        }
    }

    private func handle(message: URLSessionWebSocketTask.Message) {
        let raw: String?
        switch message {
        case .string(let s): raw = s
        case .data(let d): raw = String(data: d, encoding: .utf8)
        @unknown default: raw = nil
        }
        guard let str = raw,
              let data = str.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String,
              let payload = json["payload"] as? [String: Any] else {
            return
        }
        for listener in listeners {
            listener(type, payload)
        }
    }

    private func scheduleReconnect() {
        reconnectAttempts += 1
        let delay = min(pow(2.0, Double(min(reconnectAttempts, 5))), 30.0)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if !self.manuallyClosed {
                self.connect()
            }
        }
    }
}
