import SwiftUI
import UIKit

// MARK: - Data Models

struct ChatConversation: Identifiable {
    let id: String
    let type: String
    var name: String?
    let members: [ConversationMember]
    var lastMessageAt: String?

    struct ConversationMember {
        let userId: String
        let username: String
        let displayName: String
    }
}

struct ChatMessage: Identifiable {
    let id: String
    let conversationId: String
    let senderId: String
    let ciphertext: String
    let iv: String
    let ratchetHeader: String
    let messageType: String
    let createdAt: String
}

// MARK: - Main Tab View

struct MainTabView: View {
    @EnvironmentObject var authVM: AuthViewModel
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatsView()
                .tabItem {
                    Image(systemName: "message.fill")
                    Text("Chats")
                }
                .tag(0)

            CallsHistoryView()
                .tabItem {
                    Image(systemName: "phone.fill")
                    Text("Calls")
                }
                .tag(1)

            SettingsView()
                .tabItem {
                    Image(systemName: "gearshape.fill")
                    Text("Settings")
                }
                .tag(2)
        }
        .tint(.rocGold)
        .overlay {
            CallOverlay()
        }
    }
}

// MARK: - Chats Tab

struct ChatsView: View {
    @State private var searchText = ""
    @State private var conversations: [ChatConversation] = []
    @State private var isLoading = true
    @State private var showNewChat = false
    @State private var selectedConversation: ChatConversation?
    private let userId = UserDefaults.standard.string(forKey: "user_id") ?? ""

    var filteredConversations: [ChatConversation] {
        if searchText.isEmpty { return conversations }
        return conversations.filter {
            conversationName($0).localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                        .tint(.rocGold)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if conversations.isEmpty {
                    emptyState
                } else {
                    conversationList
                }
            }
            .navigationTitle("Chats")
            .searchable(text: $searchText, prompt: "Search conversations")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: { showNewChat = true }) {
                        Image(systemName: "square.and.pencil")
                            .foregroundColor(.rocGold)
                    }
                }
            }
            .sheet(isPresented: $showNewChat) {
                NewChatView { conv in
                    selectedConversation = conv
                    showNewChat = false
                    Task { await loadConversations() }
                }
            }
            .navigationDestination(item: $selectedConversation) { conv in
                ConversationView(conversation: conv)
            }
        }
        .task { await loadConversations() }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "message.fill")
                .font(.system(size: 40))
                .foregroundColor(.rocGold.opacity(0.3))
            Text("No conversations yet")
                .font(.headline)
                .foregroundColor(.textSecondary)
            Text("Start a new conversation to begin messaging securely.")
                .font(.subheadline)
                .foregroundColor(.textSecondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 4) {
                Image(systemName: "lock.fill").font(.caption2)
                Text("End-to-end encrypted").font(.caption)
            }
            .foregroundColor(.turquoise)
        }
        .padding()
    }

    private var conversationList: some View {
        List(filteredConversations) { conv in
            Button {
                selectedConversation = conv
            } label: {
                HStack(spacing: 12) {
                    Circle()
                        .fill(Color.rocGold.opacity(0.15))
                        .frame(width: 48, height: 48)
                        .overlay(
                            Text(initials(for: conv))
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(.rocGold)
                        )

                    VStack(alignment: .leading, spacing: 3) {
                        Text(conversationName(conv))
                            .font(.body.weight(.medium))
                            .lineLimit(1)
                        Text("🔒 Encrypted message")
                            .font(.caption)
                            .foregroundColor(.textSecondary)
                            .lineLimit(1)
                    }

                    Spacer()

                    if let time = conv.lastMessageAt {
                        Text(formatRelativeTime(time))
                            .font(.caption2)
                            .foregroundColor(.textSecondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .listStyle(.plain)
    }

    private func loadConversations() async {
        do {
            let raw = try await APIClient.shared.getConversations()
            conversations = raw.compactMap { dict -> ChatConversation? in
                guard let id = dict["id"] as? String else { return nil }
                let membersArr = dict["members"] as? [[String: Any]] ?? []
                let members = membersArr.map {
                    ChatConversation.ConversationMember(
                        userId: $0["user_id"] as? String ?? "",
                        username: $0["username"] as? String ?? "",
                        displayName: $0["display_name"] as? String ?? ""
                    )
                }
                return ChatConversation(
                    id: id,
                    type: dict["type"] as? String ?? "direct",
                    name: dict["name"] as? String,
                    members: members,
                    lastMessageAt: dict["last_message_at"] as? String
                )
            }
        } catch {}
        isLoading = false
    }

    private func conversationName(_ conv: ChatConversation) -> String {
        if let name = conv.name, !name.isEmpty { return name }
        let others = conv.members.filter { $0.userId != userId }
        if others.isEmpty { return "Unknown" }
        return others.map { $0.displayName.isEmpty ? $0.username : $0.displayName }.joined(separator: ", ")
    }

    private func initials(for conv: ChatConversation) -> String {
        let name = conversationName(conv)
        return String(name.split(separator: " ").prefix(2).compactMap { $0.first }).uppercased()
    }
}

// MARK: - New Chat Sheet

struct NewChatView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var searchQuery = ""
    @State private var results: [(id: String, username: String, displayName: String)] = []
    var onSelect: (ChatConversation) -> Void

    var body: some View {
        NavigationStack {
            VStack {
                TextField("Search @username", text: $searchQuery)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .padding()
                    .onChange(of: searchQuery) { newVal in
                        guard newVal.count >= 3 else { return }
                        Task { await search(newVal) }
                    }

                List(results, id: \.id) { user in
                    Button {
                        Task {
                            do {
                                let body: [String: Any] = ["type": "direct", "member_ids": [user.id]]
                                let data = try await APIClient.shared.postRaw("/messages/conversations", body: body)
                                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                                   let convId = json["conversation_id"] as? String {
                                    let conv = ChatConversation(
                                        id: convId, type: "direct", name: nil,
                                        members: [.init(userId: user.id, username: user.username, displayName: user.displayName)],
                                        lastMessageAt: nil
                                    )
                                    onSelect(conv)
                                }
                            } catch {}
                        }
                    } label: {
                        VStack(alignment: .leading) {
                            Text(user.displayName).font(.body.weight(.medium))
                            Text("@\(user.username)").font(.caption).foregroundColor(.textSecondary)
                        }
                    }
                }
            }
            .navigationTitle("New Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func search(_ query: String) async {
        do {
            let q = query.replacingOccurrences(of: "@", with: "")
            let data = try await APIClient.shared.getRaw("/contacts/search?q=\(q)")
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let arr = json["results"] as? [[String: Any]] {
                results = arr.compactMap {
                    guard let id = $0["userId"] as? String,
                          let un = $0["username"] as? String,
                          let dn = $0["displayName"] as? String else { return nil }
                    return (id: id, username: un, displayName: dn)
                }
            }
        } catch {}
    }
}

// MARK: - Conversation View (Messages)

struct ConversationView: View {
    let conversation: ChatConversation
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var isSending = false
    @State private var wsTask: URLSessionWebSocketTask?
    @State private var disappearTimer: Int = 0
    @State private var showDisappearMenu = false
    private let userId = UserDefaults.standard.string(forKey: "user_id") ?? ""

    private var convName: String {
        if let n = conversation.name, !n.isEmpty { return n }
        let others = conversation.members.filter { $0.userId != userId }
        let name = others.map { $0.displayName.isEmpty ? $0.username : $0.displayName }.joined(separator: ", ")
        return name.isEmpty ? "Unknown" : name
    }

    var body: some View {
        VStack(spacing: 0) {
            // Encryption banner
            HStack(spacing: 6) {
                Image(systemName: "lock.fill").font(.caption2)
                Text("Messages are end-to-end encrypted").font(.caption)
            }
            .foregroundColor(.turquoise)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Color.turquoise.opacity(0.08))

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(messages) { msg in
                            MessageBubbleView(message: msg, isMine: msg.senderId == userId)
                                .id(msg.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .onChange(of: messages.count) { _ in
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            // Composer
            HStack(spacing: 8) {
                TextField("Type a message...", text: $inputText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .onSubmit { sendMessage() }

                Button(action: sendMessage) {
                    Image(systemName: "paperplane.fill")
                        .foregroundColor(inputText.trimmingCharacters(in: .whitespaces).isEmpty ? .textSecondary : .rocGold)
                }
                .disabled(inputText.trimmingCharacters(in: .whitespaces).isEmpty || isSending)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.systemBackground))
        }
        .navigationTitle(convName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(action: {
                    let others = conversation.members.filter { $0.userId != userId }
                    if let peer = others.first, let task = wsTask {
                        CallManager.shared.startCall(
                            conversationId: conversation.id,
                            remoteUserId: peer.userId,
                            remoteName: peer.displayName.isEmpty ? peer.username : peer.displayName,
                            callType: .voice,
                            ws: task
                        )
                    }
                }) {
                    Image(systemName: "phone.fill").foregroundColor(.rocGold)
                }
                Button(action: {
                    let others = conversation.members.filter { $0.userId != userId }
                    if let peer = others.first, let task = wsTask {
                        CallManager.shared.startCall(
                            conversationId: conversation.id,
                            remoteUserId: peer.userId,
                            remoteName: peer.displayName.isEmpty ? peer.username : peer.displayName,
                            callType: .video,
                            ws: task
                        )
                    }
                }) {
                    Image(systemName: "video.fill").foregroundColor(.rocGold)
                }
                Button(action: { showDisappearMenu = true }) {
                    Image(systemName: disappearTimer > 0 ? "timer" : "timer")
                        .foregroundColor(disappearTimer > 0 ? .turquoise : .rocGold)
                }
            }
        }
        .task { await loadMessages() }
        .onAppear { connectWebSocket() }
        .onDisappear { wsTask?.cancel(with: .goingAway, reason: nil); wsTask = nil }
        .confirmationDialog("Disappearing Messages", isPresented: $showDisappearMenu) {
            Button("Off") { disappearTimer = 0 }
            Button("5 minutes") { disappearTimer = 300 }
            Button("1 hour") { disappearTimer = 3600 }
            Button("24 hours") { disappearTimer = 86400 }
            Button("7 days") { disappearTimer = 604800 }
            Button("30 days") { disappearTimer = 2592000 }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("New messages will auto-delete after the selected time.")
        }
    }

    private func loadMessages() async {
        do {
            let data = try await APIClient.shared.getRaw("/messages/\(conversation.id)")
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let arr = json["messages"] as? [[String: Any]] {
                messages = arr.compactMap { m in
                    guard let id = m["id"] as? String,
                          let sid = m["sender_id"] as? String else { return nil }
                    return ChatMessage(
                        id: id,
                        conversationId: conversation.id,
                        senderId: sid,
                        ciphertext: m["ciphertext"] as? String ?? "",
                        iv: m["iv"] as? String ?? "",
                        ratchetHeader: m["ratchet_header"] as? String ?? "",
                        messageType: m["message_type"] as? String ?? "text",
                        createdAt: m["created_at"] as? String ?? ""
                    )
                }
            }
        } catch {}
    }

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !isSending else { return }
        inputText = ""
        isSending = true

        // Haptic feedback
        let impact = UIImpactFeedbackGenerator(style: .light)
        impact.impactOccurred()

        Task {
            do {
                var body: [String: Any] = [
                    "conversation_id": conversation.id,
                    "ciphertext": text,
                    "iv": "",
                    "ratchet_header": "",
                    "message_type": "text",
                ]
                if disappearTimer > 0 {
                    body["expires_in"] = disappearTimer
                }
                _ = try await APIClient.shared.postRaw("/messages/send", body: body)
                messages.append(ChatMessage(
                    id: "local-\(Date().timeIntervalSince1970)",
                    conversationId: conversation.id,
                    senderId: userId,
                    ciphertext: text,
                    iv: "", ratchetHeader: "",
                    messageType: "text",
                    createdAt: ISO8601DateFormatter().string(from: Date())
                ))
            } catch {
                inputText = text
            }
            isSending = false
        }
    }

    private func connectWebSocket() {
        guard let token = UserDefaults.standard.string(forKey: "session_token"),
              !userId.isEmpty else { return }

        let urlStr = "wss://chat.mocipher.com/api/ws/\(conversation.id)?userId=\(userId)&deviceId=ios&token=\(token)"
        guard let url = URL(string: urlStr) else { return }

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        wsTask = task
        task.resume()
        receiveMessages(task: task)
    }

    private func receiveMessages(task: URLSessionWebSocketTask) {
        task.receive { [self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let type = json["type"] as? String,
                       let payload = json["payload"] as? [String: Any] {
                        if type == "message" {
                            let newMsg = ChatMessage(
                                id: payload["id"] as? String ?? "ws-\(Date().timeIntervalSince1970)",
                                conversationId: conversation.id,
                                senderId: payload["fromUserId"] as? String ?? payload["sender_id"] as? String ?? "",
                                ciphertext: payload["ciphertext"] as? String ?? "",
                                iv: payload["iv"] as? String ?? "",
                                ratchetHeader: payload["ratchet_header"] as? String ?? "",
                                messageType: payload["message_type"] as? String ?? "text",
                                createdAt: payload["created_at"] as? String ?? ISO8601DateFormatter().string(from: Date())
                            )
                            DispatchQueue.main.async {
                                messages.append(newMsg)
                            }
                        } else if type == "call_offer" {
                            DispatchQueue.main.async {
                                CallManager.shared.handleIncomingOffer(
                                    payload: payload,
                                    conversationId: conversation.id,
                                    ws: task
                                )
                            }
                        }
                    }
                default: break
                }
                receiveMessages(task: task)
            case .failure:
                // Auto-reconnect after 3 seconds
                DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: DispatchWorkItem {
                    connectWebSocket()
                })
            }
        }
    }
}

// MARK: - Message Bubble

struct MessageBubbleView: View {
    let message: ChatMessage
    let isMine: Bool

    var body: some View {
        HStack {
            if isMine { Spacer(minLength: 60) }

            VStack(alignment: isMine ? .trailing : .leading, spacing: 2) {
                Text(message.ciphertext.isEmpty ? "🔒 Encrypted" : message.ciphertext)
                    .font(.body)
                    .foregroundColor(.textPrimary)

                HStack(spacing: 4) {
                    Text("🔒").font(.system(size: 8))
                    Text(formatRelativeTime(message.createdAt))
                        .font(.system(size: 11))
                        .foregroundColor(.textSecondary)
                    if isMine {
                        Text("✓✓").font(.system(size: 11)).foregroundColor(.turquoise)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(isMine ? Color.rocGold.opacity(0.12) : Color.bubbleTheirs)
            .clipShape(RoundedRectangle(cornerRadius: 16))

            if !isMine { Spacer(minLength: 60) }
        }
    }
}

// MARK: - Settings Tab

struct SettingsView: View {
    @EnvironmentObject var authVM: AuthViewModel
    @State private var discoverable = true
    @State private var readReceipts = true
    @State private var typingIndicators = true
    @State private var username = "loading..."
    @State private var displayName = "Loading..."
    @State private var showQrScanner = false
    @State private var qrScanResult: String?
    @State private var isLinkingDevice = false
    @State private var linkMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section("Account") {
                    HStack {
                        Circle()
                            .fill(Color.rocGold.opacity(0.15))
                            .frame(width: 48, height: 48)
                            .overlay(
                                Text(initials(from: displayName))
                                    .font(.system(size: 18, weight: .bold))
                                    .foregroundColor(.rocGold)
                            )
                        VStack(alignment: .leading) {
                            Text(displayName).font(.headline)
                            Text("@\(username)").font(.subheadline).foregroundColor(.textSecondary)
                        }
                    }
                }

                Section("Linked Devices") {
                    Button {
                        showQrScanner = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.title2)
                                .foregroundColor(.rocGold)
                            VStack(alignment: .leading) {
                                Text("Scan QR Code")
                                    .fontWeight(.medium)
                                    .foregroundColor(.textPrimary)
                                Text("Link RocChat Web or another device")
                                    .font(.caption)
                                    .foregroundColor(.textSecondary)
                            }
                        }
                    }

                    if let msg = linkMessage {
                        HStack {
                            Image(systemName: msg.contains("✓") ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                                .foregroundColor(msg.contains("✓") ? .success : .danger)
                            Text(msg)
                                .font(.caption)
                                .foregroundColor(msg.contains("✓") ? .success : .danger)
                        }
                    }
                }

                Section("Privacy") {
                    Toggle("Discoverable by username", isOn: $discoverable)
                        .onChange(of: discoverable) { val in
                            Task {
                                let body: [String: Any] = ["discoverable": val ? 1 : 0]
                                _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                            }
                        }
                    Toggle("Read receipts", isOn: $readReceipts)
                    Toggle("Typing indicators", isOn: $typingIndicators)
                }
                .tint(.rocGold)

                Section("Encryption") {
                    HStack(spacing: 8) {
                        Image(systemName: "lock.shield.fill").foregroundColor(.turquoise)
                        VStack(alignment: .leading) {
                            Text("End-to-end encrypted")
                                .font(.subheadline.bold())
                                .foregroundColor(.turquoise)
                            Text("X25519 + AES-256-GCM + Double Ratchet")
                                .font(.custom("JetBrains Mono", size: 10))
                                .foregroundColor(.textSecondary)
                        }
                    }
                }

                Section("About") {
                    HStack {
                        Text("Version"); Spacer()
                        Text("0.1.0").foregroundColor(.textSecondary)
                    }
                    HStack(spacing: 4) {
                        Text("Part of the")
                        Text("Roc Family").fontWeight(.semibold).foregroundColor(.rocGold)
                    }
                    .font(.subheadline).foregroundColor(.textSecondary)
                }

                Section {
                    Button("Sign Out") { authVM.logout() }
                        .foregroundColor(.danger)
                }
            }
            .navigationTitle("Settings")
        }
        .sheet(isPresented: $showQrScanner) {
            QrScannerView { code in
                showQrScanner = false
                handleQrCode(code)
            }
        }
        .task {
            do {
                let me = try await APIClient.shared.getMe()
                username = me["username"] as? String ?? "unknown"
                displayName = me["display_name"] as? String ?? username
                if let disc = me["discoverable"] as? Bool { discoverable = disc }
                if let disc = me["discoverable"] as? Int { discoverable = disc != 0 }
            } catch {}
        }
    }

    private func initials(from name: String) -> String {
        String(name.split(separator: " ").prefix(2).compactMap { $0.first }).uppercased()
    }

    private func handleQrCode(_ code: String) {
        // Parse rocchat://web-login?token=UUID
        guard code.hasPrefix("rocchat://web-login?token="),
              let token = URLComponents(string: code)?
                .queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty else {
            linkMessage = "⚠ Invalid QR code"
            return
        }
        isLinkingDevice = true
        linkMessage = nil
        Task {
            do {
                let body: [String: Any] = ["qr_token": token]
                _ = try await APIClient.shared.postRaw("/auth/qr/authorize", body: body)
                linkMessage = "✓ Device linked successfully"
            } catch {
                linkMessage = "⚠ Failed to link device"
            }
            isLinkingDevice = false
        }
    }
}

// MARK: - QR Scanner View

import AVFoundation

struct QrScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> QrScannerViewController {
        QrScannerViewController(onScan: onScan)
    }

    func updateUIViewController(_ uiViewController: QrScannerViewController, context: Context) {}
}

class QrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    let onScan: (String) -> Void
    private var captureSession: AVCaptureSession?
    private var hasScanned = false

    init(onScan: @escaping (String) -> Void) {
        self.onScan = onScan
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupCamera()
        setupOverlay()
    }

    private func setupCamera() {
        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            showError()
            return
        }
        if session.canAddInput(input) { session.addInput(input) }

        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        }

        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.frame = view.bounds
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(previewLayer, at: 0)

        captureSession = session
        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    private func setupOverlay() {
        // Title
        let titleLabel = UILabel()
        titleLabel.text = "Scan QR Code"
        titleLabel.font = .systemFont(ofSize: 22, weight: .bold)
        titleLabel.textColor = .white
        titleLabel.textAlignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(titleLabel)

        let subtitleLabel = UILabel()
        subtitleLabel.text = "Point your camera at the QR code on RocChat Web"
        subtitleLabel.font = .systemFont(ofSize: 14)
        subtitleLabel.textColor = UIColor(white: 1, alpha: 0.7)
        subtitleLabel.textAlignment = .center
        subtitleLabel.numberOfLines = 0
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(subtitleLabel)

        // Viewfinder frame
        let frameSize: CGFloat = 240
        let frameView = UIView()
        frameView.translatesAutoresizingMaskIntoConstraints = false
        frameView.backgroundColor = .clear
        frameView.layer.borderColor = UIColor(red: 212/255, green: 175/255, blue: 55/255, alpha: 0.8).cgColor
        frameView.layer.borderWidth = 3
        frameView.layer.cornerRadius = 16
        view.addSubview(frameView)

        // Close button
        let closeBtn = UIButton(type: .system)
        closeBtn.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal)
        closeBtn.tintColor = .white
        closeBtn.translatesAutoresizingMaskIntoConstraints = false
        closeBtn.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(closeBtn)

        NSLayoutConstraint.activate([
            closeBtn.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            closeBtn.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            closeBtn.widthAnchor.constraint(equalToConstant: 36),
            closeBtn.heightAnchor.constraint(equalToConstant: 36),

            titleLabel.bottomAnchor.constraint(equalTo: frameView.topAnchor, constant: -32),
            titleLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 8),
            subtitleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 40),
            subtitleLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -40),

            frameView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            frameView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            frameView.widthAnchor.constraint(equalToConstant: frameSize),
            frameView.heightAnchor.constraint(equalToConstant: frameSize),
        ])
    }

    @objc private func closeTapped() {
        captureSession?.stopRunning()
        dismiss(animated: true)
    }

    private func showError() {
        let label = UILabel()
        label.text = "Camera access required to scan QR codes"
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
        ])
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !hasScanned,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              obj.type == .qr,
              let value = obj.stringValue else { return }
        hasScanned = true
        captureSession?.stopRunning()
        // Haptic
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        dismiss(animated: true) { [onScan] in
            onScan(value)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession?.stopRunning()
    }
}

// MARK: - Helpers

func formatRelativeTime(_ iso: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
    let diff = Date().timeIntervalSince(date)
    switch diff {
    case ..<60: return "now"
    case ..<3600: return "\(Int(diff / 60))m"
    case ..<86400:
        let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: date)
    case ..<604800:
        let f = DateFormatter(); f.dateFormat = "EEE"; return f.string(from: date)
    default:
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f.string(from: date)
    }
}

// Make ChatConversation Hashable for NavigationLink
extension ChatConversation: Hashable {
    static func == (lhs: ChatConversation, rhs: ChatConversation) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
