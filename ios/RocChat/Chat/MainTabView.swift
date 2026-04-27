import SwiftUI
import UIKit
import CryptoKit
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers
import Speech
import CommonCrypto
import LocalAuthentication

// MARK: - Profile & Group Meta Encryption
// Key: HKDF(vaultKey, "rocchat:profile:encrypt") → AES-GCM-256
// Vault key is passphrase-derived and NEVER leaves the device, so the
// server cannot derive this key (unlike the old public-key-based scheme).
// Format: base64(iv) + "." + base64(ciphertext+tag)

private func profileEncryptionKey() -> SymmetricKey {
    if let vaultData = SecureStorage.shared.getData(forKey: "rocchat_vault_key"), vaultData.count == 32 {
        let vk = SymmetricKey(data: vaultData)
        let info = Data("rocchat:profile:encrypt".utf8)
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: vk, salt: Data(), info: info, outputByteCount: 32)
    }
    let idKey = UserDefaults.standard.string(forKey: "identity_pub") ?? "default"
    let raw = (idKey + ":profile:encrypt").data(using: .utf8)!
    let hash = SHA256.hash(data: raw)
    return SymmetricKey(data: hash)
}

private func legacyProfileKey() -> SymmetricKey {
    let idKey = UserDefaults.standard.string(forKey: "identity_pub") ?? "default"
    let raw = (idKey + ":profile:encrypt").data(using: .utf8)!
    let hash = SHA256.hash(data: raw)
    return SymmetricKey(data: hash)
}

func encryptProfileField(_ value: String) -> String {
    guard !value.isEmpty else { return value }
    let key = profileEncryptionKey()
    let nonce = AES.GCM.Nonce()
    guard let sealed = try? AES.GCM.seal(value.data(using: .utf8)!, using: key, nonce: nonce) else { return value }
    return Data(nonce).base64EncodedString() + "." + (sealed.ciphertext + sealed.tag).base64EncodedString()
}

func decryptProfileField(_ value: String) -> String {
    guard value.contains(".") else { return value }
    let parts = value.split(separator: ".", maxSplits: 1)
    guard parts.count == 2,
          let ivData = Data(base64Encoded: String(parts[0])),
          let ctData = Data(base64Encoded: String(parts[1])),
          ivData.count == 12, ctData.count >= 16 else { return value }
    let nonce = try? AES.GCM.Nonce(data: ivData)
    let ciphertext = ctData.prefix(ctData.count - 16)
    let tag = ctData.suffix(16)
    guard let nonce = nonce,
          let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag) else { return value }
    // Try vault-derived key first, then legacy key for backward compat
    let key = profileEncryptionKey()
    if let plain = try? AES.GCM.open(box, using: key),
       let result = String(data: plain, encoding: .utf8) { return result }
    let legacy = legacyProfileKey()
    if let plain = try? AES.GCM.open(box, using: legacy),
       let result = String(data: plain, encoding: .utf8) { return result }
    return value
}

// MARK: - Data Models

struct ChatConversation: Identifiable {
    let id: String
    let type: String
    var name: String?
    var avatarURL: String?
    let members: [ConversationMember]
    var lastMessageAt: String?
    var lastMessageType: String?
    var muted: Bool
    var archived: Bool

    var isGroup: Bool { type == "group" }

    struct ConversationMember {
        let userId: String
        let username: String
        let displayName: String
        let avatarUrl: String?
    }
}

struct ChatMessage: Identifiable {
    let id: String
    let conversationId: String
    let senderId: String
    var ciphertext: String
    let iv: String
    let ratchetHeader: String
    let messageType: String
    let createdAt: String
    let expiresAt: Int?
    var status: String // "sent", "delivered", "read"
    var reactions: [[String: String]]?

    init(id: String, conversationId: String, senderId: String, ciphertext: String, iv: String, ratchetHeader: String, messageType: String, createdAt: String, expiresAt: Int?, status: String = "sent", reactions: [[String: String]]? = nil) {
        self.id = id; self.conversationId = conversationId; self.senderId = senderId
        self.ciphertext = ciphertext; self.iv = iv; self.ratchetHeader = ratchetHeader
        self.messageType = messageType; self.createdAt = createdAt; self.expiresAt = expiresAt
        self.status = status; self.reactions = reactions
    }
}

// MARK: - Chat Themes

struct ChatThemeOption {
    let key: String
    let label: String
    let color: Color
    let bgColor: Color
    let bubbleMine: Color
    let bubbleTheirs: Color
}

let chatThemeOptions: [ChatThemeOption] = [
    ChatThemeOption(key: "default", label: "Default", color: .clear, bgColor: Color(.systemBackground), bubbleMine: .rocGold.opacity(0.15), bubbleTheirs: Color(.secondarySystemBackground)),
    ChatThemeOption(key: "midnight-blue", label: "Midnight Blue", color: Color(red: 0.04, green: 0.09, blue: 0.16), bgColor: Color(red: 0.04, green: 0.09, blue: 0.16), bubbleMine: Color(red: 0.1, green: 0.21, blue: 0.36).opacity(0.8), bubbleTheirs: Color(red: 0.12, green: 0.16, blue: 0.23).opacity(0.9)),
    ChatThemeOption(key: "forest-green", label: "Forest Green", color: Color(red: 0.04, green: 0.12, blue: 0.04), bgColor: Color(red: 0.04, green: 0.12, blue: 0.04), bubbleMine: Color(red: 0.08, green: 0.33, blue: 0.18).opacity(0.8), bubbleTheirs: Color(red: 0.1, green: 0.18, blue: 0.1).opacity(0.9)),
    ChatThemeOption(key: "sunset-amber", label: "Sunset Amber", color: Color(red: 0.1, green: 0.06, blue: 0.02), bgColor: Color(red: 0.1, green: 0.06, blue: 0.02), bubbleMine: Color(red: 0.49, green: 0.18, blue: 0.07).opacity(0.8), bubbleTheirs: Color(red: 0.16, green: 0.13, blue: 0.09).opacity(0.9)),
    ChatThemeOption(key: "ocean-teal", label: "Ocean Teal", color: Color(red: 0.02, green: 0.18, blue: 0.18), bgColor: Color(red: 0.02, green: 0.18, blue: 0.18), bubbleMine: Color(red: 0.07, green: 0.31, blue: 0.29).opacity(0.8), bubbleTheirs: Color(red: 0.1, green: 0.18, blue: 0.18).opacity(0.9)),
    ChatThemeOption(key: "rose-gold", label: "Rose Gold", color: Color(red: 0.1, green: 0.04, blue: 0.06), bgColor: Color(red: 0.1, green: 0.04, blue: 0.06), bubbleMine: Color(red: 0.51, green: 0.09, blue: 0.26).opacity(0.8), bubbleTheirs: Color(red: 0.16, green: 0.08, blue: 0.13).opacity(0.9)),
    ChatThemeOption(key: "lavender", label: "Lavender", color: Color(red: 0.06, green: 0.04, blue: 0.1), bgColor: Color(red: 0.06, green: 0.04, blue: 0.1), bubbleMine: Color(red: 0.3, green: 0.11, blue: 0.58).opacity(0.8), bubbleTheirs: Color(red: 0.12, green: 0.08, blue: 0.19).opacity(0.9)),
    ChatThemeOption(key: "charcoal", label: "Charcoal", color: Color(red: 0.07, green: 0.07, blue: 0.07), bgColor: Color(red: 0.07, green: 0.07, blue: 0.07), bubbleMine: Color(red: 0.2, green: 0.2, blue: 0.2).opacity(0.9), bubbleTheirs: Color(red: 0.13, green: 0.13, blue: 0.13).opacity(0.9)),
]

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

            ChannelsView()
                .tabItem {
                    Image(systemName: "megaphone.fill")
                    Text("Channels")
                }
                .tag(2)

            SettingsView()
                .tabItem {
                    Image(systemName: "person.circle.fill")
                    Text("Profile")
                }
                .tag(3)
        }
        .tint(.rocGold)
        .overlay {
            CallOverlay()
        }
        .onChange(of: CallManager.shared.callStatus) { _, newStatus in
            // Dismiss keyboard during active calls so it doesn't overlap the call UI
            if newStatus != .idle {
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder),
                    to: nil, from: nil, for: nil
                )
            }
        }
    }
}

// MARK: - Avatar View

struct AvatarView: View {
    let name: String
    let avatarUrl: String?
    let size: CGFloat

    var body: some View {
        if let urlStr = avatarUrl, !urlStr.isEmpty, let url = URL(string: urlStr.hasPrefix("http") ? urlStr : "https://chat.mocipher.com\(urlStr)") {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                        .frame(width: size, height: size)
                        .clipShape(Circle())
                default:
                    fallbackAvatar
                }
            }
        } else {
            fallbackAvatar
        }
    }

    private var fallbackAvatar: some View {
        Circle()
            .fill(LinearGradient(colors: [.rocGoldLight, .rocGold, .rocGoldDark], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: size, height: size)
            .overlay(
                Text(String(name.split(separator: " ").prefix(2).compactMap { $0.first }).uppercased())
                    .font(.system(size: size * 0.33, weight: .bold))
                    .foregroundColor(.white)
            )
            .shadow(color: .rocGold.opacity(0.2), radius: 4, y: 2)
    }
}

// MARK: - Chats Tab

struct ChatsView: View {
    @State private var searchText = ""
    @State private var conversations: [ChatConversation] = []
    @State private var isLoading = true
    @State private var showNewChat = false
    @State private var selectedConversation: ChatConversation?
    @State private var showNotifModePicker = false
    @State private var notifModeConvId: String = ""
    @State private var folders: [(id: String, name: String, icon: String, conversationIds: [String])] = []
    @State private var selectedFolderId: String? = nil
    @State private var showFolderManager = false
    @State private var folderMenuConvId: String = ""
    private let userId = UserDefaults.standard.string(forKey: "user_id") ?? ""

    var filteredConversations: [ChatConversation] {
        var result = conversations
        if let folderId = selectedFolderId,
           let folder = folders.first(where: { $0.id == folderId }) {
            result = result.filter { folder.conversationIds.contains($0.id) }
        }
        if !searchText.isEmpty {
            result = result.filter {
                conversationName($0).localizedCaseInsensitiveContains(searchText)
            }
        }
        return result
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !folders.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            Button {
                                selectedFolderId = nil
                            } label: {
                                Text("All")
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 7)
                                    .background(selectedFolderId == nil ? Color.rocGold : Color.rocGold.opacity(0.15))
                                    .foregroundColor(selectedFolderId == nil ? .white : .rocGold)
                                    .clipShape(Capsule())
                            }
                            ForEach(folders, id: \.id) { folder in
                                Button {
                                    selectedFolderId = folder.id
                                } label: {
                                    HStack(spacing: 4) {
                                        Text(folder.icon)
                                        Text(folder.name)
                                    }
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 7)
                                    .background(selectedFolderId == folder.id ? Color.rocGold : Color.rocGold.opacity(0.15))
                                    .foregroundColor(selectedFolderId == folder.id ? .white : .rocGold)
                                    .clipShape(Capsule())
                                }
                            }
                        }
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                    }
                }

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
            }
            .navigationTitle("Chats")
            .searchable(text: $searchText, prompt: "Search conversations")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: { showFolderManager = true }) {
                        Image(systemName: "folder.fill.badge.plus")
                            .foregroundColor(.rocGold)
                    }
                }
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
            .sheet(isPresented: $showFolderManager) {
                FolderManagerSheet(folders: $folders, onReload: { Task { await loadFolders() } })
            }
        }
        .task {
            await loadConversations()
            await loadFolders()
        }
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
        List {
            ForEach(filteredConversations) { conv in
                Button {
                    selectedConversation = conv
                } label: {
                    HStack(spacing: 14) {
                        let other = conv.members.first { $0.userId != userId }
                        AvatarView(name: conversationName(conv), avatarUrl: other?.avatarUrl, size: 52)

                        VStack(alignment: .leading, spacing: 4) {
                            Text(conversationName(conv))
                                .font(.body.weight(.semibold))
                                .foregroundColor(.adaptiveText)
                                .lineLimit(1)
                            HStack(spacing: 3) {
                                Image(systemName: "lock.fill")
                                    .font(.caption2)
                                    .imageScale(.small)
                                    .foregroundColor(.adaptiveTextSec)
                                Text(mediaTypePreview(conv.lastMessageType))
                                    .font(.subheadline)
                                    .foregroundColor(.adaptiveTextSec)
                                    .lineLimit(1)
                            }
                        }

                        Spacer()

                        VStack(alignment: .trailing, spacing: 4) {
                            if let time = conv.lastMessageAt {
                                Text(formatRelativeTime(time))
                                    .font(.caption)
                                    .foregroundColor(.adaptiveTextSec)
                            }
                            if conv.muted {
                                Image(systemName: "speaker.slash.fill")
                                    .font(.caption2)
                                    .foregroundColor(.adaptiveTextSec)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .contextMenu {
                    if !folders.isEmpty {
                        Menu("Add to Folder") {
                            ForEach(folders, id: \.id) { folder in
                                if !folder.conversationIds.contains(conv.id) {
                                    Button {
                                        Task { await addToFolder(folderId: folder.id, convId: conv.id) }
                                    } label: {
                                        Label("\(folder.icon) \(folder.name)", systemImage: "folder.badge.plus")
                                    }
                                }
                            }
                        }
                        let containingFolders = folders.filter { $0.conversationIds.contains(conv.id) }
                        if !containingFolders.isEmpty {
                            Menu("Remove from Folder") {
                                ForEach(containingFolders, id: \.id) { folder in
                                    Button(role: .destructive) {
                                        Task { await removeFromFolder(folderId: folder.id, convId: conv.id) }
                                    } label: {
                                        Label("\(folder.icon) \(folder.name)", systemImage: "folder.badge.minus")
                                    }
                                }
                            }
                        }
                    }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        Task { await deleteConversation(conv.id) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    Button {
                        Task { await toggleArchive(conv.id) }
                    } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    .tint(.blue)
                    Button {
                        notifModeConvId = conv.id
                        showNotifModePicker = true
                    } label: {
                        Label("Notifications", systemImage: "bell.badge")
                    }
                    .tint(.orange)
                }
            }
        }
        .listStyle(.plain)
        .refreshable {
            await loadConversations()
        }
        .confirmationDialog("Notification Mode", isPresented: $showNotifModePicker) {
            Button("Normal — All notifications") { Task { await setNotificationMode(notifModeConvId, "normal") } }
            Button("Quiet — Badge only, no sound") { Task { await setNotificationMode(notifModeConvId, "quiet") } }
            Button("Focus — @mentions & replies only") { Task { await setNotificationMode(notifModeConvId, "focus") } }
            Button("Emergency — Calls ring only") { Task { await setNotificationMode(notifModeConvId, "emergency") } }
            Button("Silent — No notifications") { Task { await setNotificationMode(notifModeConvId, "silent") } }
            Button("Cancel", role: .cancel) {}
        }
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
                        displayName: $0["display_name"] as? String ?? "",
                        avatarUrl: $0["avatar_url"] as? String
                    )
                }
                let muted = dict["muted"] as? Bool ?? false
                let archived = dict["archived"] as? Bool ?? false
                if archived { return nil } // hide archived
                return ChatConversation(
                    id: id,
                    type: dict["type"] as? String ?? "direct",
                    name: dict["name"] as? String,
                    avatarURL: dict["avatar_url"] as? String,
                    members: members,
                    lastMessageAt: dict["last_message_at"] as? String,
                    lastMessageType: dict["last_message_type"] as? String,
                    muted: muted,
                    archived: archived
                )
            }
        } catch {}
        isLoading = false
    }

    private func mediaTypePreview(_ type: String?) -> String {
        switch type {
        case "image":       return "📷 Photo"
        case "video":       return "🎥 Video"
        case "voice_note":  return "🎤 Voice message"
        case "file":        return "📎 File"
        case "call_offer", "call_answer", "call_end": return "📞 Call activity"
        default:            return "Encrypted message"
        }
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

    private func setNotificationMode(_ convId: String, _ mode: String) async {
        do {
            let _ = try await APIClient.shared.postRaw("/messages/conversations/\(convId)/notification-mode", body: ["mode": mode])
            if let idx = conversations.firstIndex(where: { $0.id == convId }) {
                conversations[idx].muted = mode != "normal"
            }
        } catch {}
    }

    private func toggleArchive(_ convId: String) async {
        do {
            let data = try await APIClient.shared.postRaw("/messages/conversations/\(convId)/archive", body: [:])
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let archived = json["archived"] as? Bool, archived {
                conversations.removeAll { $0.id == convId }
                if selectedConversation?.id == convId { selectedConversation = nil }
            }
        } catch {}
    }

    private func deleteConversation(_ convId: String) async {
        do {
            _ = try await APIClient.shared.deleteRaw("/messages/conversations/\(convId)")
            conversations.removeAll { $0.id == convId }
            if selectedConversation?.id == convId { selectedConversation = nil }
        } catch {}
    }

    private func loadFolders() async {
        do {
            let data = try await APIClient.shared.getRaw("/features/folders")
            if let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                folders = arr.compactMap { dict in
                    guard let id = dict["id"] as? String,
                          let name = dict["name"] as? String else { return nil }
                    let icon = dict["icon"] as? String ?? "📁"
                    let convIds = dict["conversation_ids"] as? [String] ?? []
                    return (id: id, name: name, icon: icon, conversationIds: convIds)
                }
            }
        } catch {}
    }

    private func addToFolder(folderId: String, convId: String) async {
        do {
            _ = try await APIClient.shared.postRaw("/features/folders/\(folderId)/chats", body: ["conversation_id": convId])
            await loadFolders()
        } catch {}
    }

    private func removeFromFolder(folderId: String, convId: String) async {
        do {
            _ = try await APIClient.shared.deleteRaw("/features/folders/\(folderId)/chats/\(convId)")
            await loadFolders()
        } catch {}
    }
}

// MARK: - Folder Manager Sheet

struct FolderManagerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var folders: [(id: String, name: String, icon: String, conversationIds: [String])]
    var onReload: () -> Void
    @State private var newFolderName = ""
    @State private var newFolderIcon = "📁"
    @State private var showNewFolder = false

    private let emojiPresets = ["📁", "⭐", "💼", "👥", "🏠", "🎮", "🏢", "❤️", "🔒", "📌", "🎵", "📸", "✈️", "🛒", "📚", "🏋️", "🍕", "🎉", "💬", "🔔"]

    var body: some View {
        NavigationStack {
            List {
                if showNewFolder {
                    Section("New Folder") {
                        TextField("Folder name", text: $newFolderName)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(emojiPresets, id: \.self) { emoji in
                                    Button {
                                        newFolderIcon = emoji
                                    } label: {
                                        Text(emoji)
                                            .font(.title2)
                                            .padding(6)
                                            .background(newFolderIcon == emoji ? Color.rocGold.opacity(0.3) : Color.clear)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                    }
                                }
                            }
                        }
                        Button("Create") {
                            guard !newFolderName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                            Task { await createFolder() }
                        }
                        .disabled(newFolderName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }

                Section("Folders") {
                    if folders.isEmpty {
                        Text("No folders yet")
                            .foregroundColor(.textSecondary)
                    }
                    ForEach(folders, id: \.id) { folder in
                        HStack {
                            Text(folder.icon)
                            Text(folder.name)
                                .font(.body.weight(.medium))
                            Spacer()
                            Text("\(folder.conversationIds.count) chats")
                                .font(.caption)
                                .foregroundColor(.textSecondary)
                        }
                    }
                    .onDelete { indexSet in
                        for idx in indexSet {
                            let folder = folders[idx]
                            Task { await deleteFolder(folder.id) }
                        }
                    }
                }
            }
            .navigationTitle("Chat Folders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewFolder.toggle()
                    } label: {
                        Image(systemName: showNewFolder ? "minus.circle" : "plus.circle")
                            .foregroundColor(.rocGold)
                    }
                }
            }
        }
    }

    private func createFolder() async {
        do {
            let body: [String: Any] = ["name": newFolderName.trimmingCharacters(in: .whitespaces), "icon": newFolderIcon]
            let data = try await APIClient.shared.postRaw("/features/folders", body: body)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let id = json["id"] as? String,
               let name = json["name"] as? String {
                let icon = json["icon"] as? String ?? "📁"
                folders.append((id: id, name: name, icon: icon, conversationIds: []))
                newFolderName = ""
                newFolderIcon = "📁"
                showNewFolder = false
            }
        } catch {}
    }

    private func deleteFolder(_ folderId: String) async {
        do {
            _ = try await APIClient.shared.deleteRaw("/features/folders/\(folderId)")
            folders.removeAll { $0.id == folderId }
            onReload()
        } catch {}
    }
}

// MARK: - New Chat Sheet

struct NewChatView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var searchQuery = ""
    @State private var results: [(id: String, username: String, displayName: String)] = []
    @State private var isGroupMode = false
    @State private var selectedMembers: [(id: String, username: String, displayName: String)] = []
    @State private var groupName = ""
    var onSelect: (ChatConversation) -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Group toggle
                Picker("", selection: $isGroupMode) {
                    Text("Direct").tag(false)
                    Text("Group").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.top, 8)

                if isGroupMode {
                    TextField("Group Name", text: $groupName)
                        .textFieldStyle(.roundedBorder)
                        .padding(.horizontal)
                        .padding(.top, 8)

                    if !selectedMembers.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(selectedMembers, id: \.id) { member in
                                    HStack(spacing: 4) {
                                        Text(member.displayName).font(.caption).lineLimit(1)
                                        Button(action: { selectedMembers.removeAll { $0.id == member.id } }) {
                                            Image(systemName: "xmark.circle.fill").font(.caption2)
                                        }
                                    }
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color.rocGold.opacity(0.15))
                                    .clipShape(Capsule())
                                }
                            }
                            .padding(.horizontal)
                            .padding(.vertical, 6)
                        }
                    }
                }

                TextField("Search @username", text: $searchQuery)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .onChange(of: searchQuery) { _, newVal in
                        guard newVal.count >= 3 else { return }
                        Task { await search(newVal) }
                    }

                List(results, id: \.id) { user in
                    Button {
                        if isGroupMode {
                            if !selectedMembers.contains(where: { $0.id == user.id }) {
                                selectedMembers.append(user)
                            }
                        } else {
                            Task { await createDirect(user) }
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(user.displayName).font(.body.weight(.medium))
                                Text("@\(user.username)").font(.caption).foregroundColor(.textSecondary)
                            }
                            Spacer()
                            if isGroupMode && selectedMembers.contains(where: { $0.id == user.id }) {
                                Image(systemName: "checkmark.circle.fill").foregroundColor(.rocGold)
                            }
                        }
                    }
                }
            }
            .navigationTitle(isGroupMode ? "New Group" : "New Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if isGroupMode {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Create") {
                            Task { await createGroup() }
                        }
                        .disabled(selectedMembers.count < 2 || groupName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
    }

    private func createDirect(_ user: (id: String, username: String, displayName: String)) async {
        do {
            let body: [String: Any] = ["type": "direct", "member_ids": [user.id]]
            let data = try await APIClient.shared.postRaw("/messages/conversations", body: body)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let convId = json["conversation_id"] as? String {
                let conv = ChatConversation(
                    id: convId, type: "direct", name: nil, avatarURL: nil,
                    members: [.init(userId: user.id, username: user.username, displayName: user.displayName, avatarUrl: nil)],
                    lastMessageAt: nil, lastMessageType: nil, muted: false, archived: false
                )
                onSelect(conv)
            }
        } catch {}
    }

    private func createGroup() async {
        do {
            let memberIds = selectedMembers.map { $0.id }
            let encMeta = encryptProfileField(groupName.trimmingCharacters(in: .whitespaces))
            let body: [String: Any] = ["type": "group", "member_ids": memberIds, "encrypted_meta": encMeta]
            let data = try await APIClient.shared.postRaw("/messages/conversations", body: body)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let convId = json["conversation_id"] as? String {
                let members = selectedMembers.map { ChatConversation.ConversationMember(userId: $0.id, username: $0.username, displayName: $0.displayName, avatarUrl: nil) }
                let conv = ChatConversation(
                    id: convId, type: "group", name: groupName, avatarURL: nil,
                    members: members, lastMessageAt: nil, lastMessageType: nil, muted: false, archived: false
                )
                onSelect(conv)
            }
        } catch {}
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
    @State private var wsReconnectAttempt: Int = 0
    @State private var disappearTimer: Int = 0
    @State private var showDisappearMenu = false
    @State private var showSafetyNumber = false
    @State private var safetyNumber = ""
    @State private var isOffline = false
    @State private var isRecording = false
    @State private var audioRecorder: AVAudioRecorder?
    @State private var recordingURL: URL?
    @State private var recordingElapsed: Int = 0
    @State private var recordingTimer: Timer?
    @State private var recordingLevels: [CGFloat] = Array(repeating: 0.1, count: 32)
    @State private var pendingAudioURL: URL?
    @State private var pendingAudioDuration: Int = 0
    @State private var showVideoRecorder = false
    @State private var showScheduleSheet = false
    @State private var scheduleDate = Date().addingTimeInterval(3600)
    @State private var editingMessageId: String?
    @State private var replyingTo: ChatMessage?
    @State private var showPhotoPicker = false
    @State private var showFilePicker = false
    @State private var showAttachMenu = false
    @State private var showStickerPicker = false
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var showForwardSheet = false
    @State private var forwardMessage: ChatMessage?
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var lastTypingSent: Date = .distantPast
    @State private var isRemoteTyping = false
    @State private var remoteOnlineStatus: String = ""
    @State private var showThemePicker = false
    @State private var chatTheme: String = "default"
    @State private var showVaultComposer = false
    @State private var vaultType = "password"
    @State private var vaultLabel = ""
    @State private var vaultFields: [String: String] = [:]
    @State private var vaultViewOnce = false
    @State private var showPinnedMessages = false
    @State private var pinnedMessages: [ChatMessage] = []
    @State private var showMediaGallery = false
    @State private var showGroupAdmin = false
    @State private var groupMembers: [[String: Any]] = []
    private let userId = UserDefaults.standard.string(forKey: "user_id") ?? ""

    private var convName: String {
        if let n = conversation.name, !n.isEmpty { return n }
        let others = conversation.members.filter { $0.userId != userId }
        let name = others.map { $0.displayName.isEmpty ? $0.username : $0.displayName }.joined(separator: ", ")
        return name.isEmpty ? "Unknown" : name
    }

    private var activeTheme: ChatThemeOption {
        chatThemeOptions.first(where: { $0.key == chatTheme }) ?? chatThemeOptions[0]
    }

    private var filteredMessages: [ChatMessage] {
        let now = Int(Date().timeIntervalSince1970)
        return messages.filter { msg in
            if let expires = msg.expiresAt, expires <= now { return false }
            if !searchText.isEmpty {
                return msg.ciphertext.localizedCaseInsensitiveContains(searchText)
            }
            return true
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            encryptionBanner
            messageListSection
            replyBanner
            composerSection
        }
        .background(chatTheme == "default" ? Color(.systemBackground) : activeTheme.bgColor)
        .navigationTitle(convName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar { conversationToolbarItems }
        .searchable(text: $searchText, isPresented: $isSearching, prompt: "Search messages")
        .task { await loadMessages() }
        .onAppear {
            disappearTimer = UserDefaults.standard.integer(forKey: "disappear_\(conversation.id)")
            connectWebSocket()
            Task { await flushMessageQueue() }
            NotificationCenter.default.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: .main) { _ in
                Task { await notifyScreenshot() }
            }
        }
        .onDisappear { wsTask?.cancel(with: .goingAway, reason: nil); wsTask = nil }
        .onChange(of: disappearTimer) { _, newValue in
            UserDefaults.standard.set(newValue, forKey: "disappear_\(conversation.id)")
        }
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
        .sheet(isPresented: $showSafetyNumber) {
            SafetyNumberSheet(safetyNumber: safetyNumber, otherName: convName)
        }
        .sheet(isPresented: $showVideoRecorder) {
            VideoMessageRecorder { url, duration in
                showVideoRecorder = false
                if let u = url {
                    Task { await sendVideoNote(url: u, duration: duration) }
                }
            }
        }
        .sheet(isPresented: $showScheduleSheet) { scheduleSheetContent }
        .sheet(isPresented: $showThemePicker) { themePickerContent }
        .sheet(isPresented: $showVaultComposer) { vaultComposerContent }
        .sheet(isPresented: $showPinnedMessages) { pinnedMessagesContent }
        .sheet(isPresented: $showStickerPicker) {
            StickerPickerView { emoji in
                inputText += emoji
                showStickerPicker = false
            }
            .presentationDetents([.medium])
        }
        .sheet(isPresented: $showMediaGallery) { mediaGalleryContent }
        .sheet(isPresented: $showGroupAdmin) { groupAdminContent }
        .onAppear {
            chatTheme = UserDefaults.standard.string(forKey: "theme_\(conversation.id)") ?? "default"
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhotoItem, matching: .any(of: [.images, .videos]))
        .onChange(of: selectedPhotoItem) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self) {
                    await sendPhotoAttachment(data: data)
                }
                selectedPhotoItem = nil
            }
        }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first {
                guard url.startAccessingSecurityScopedResource() else { return }
                defer { url.stopAccessingSecurityScopedResource() }
                if let data = try? Data(contentsOf: url) {
                    let filename = url.lastPathComponent
                    let mime = url.mimeType
                    Task { await sendFileAttachment(data: data, filename: filename, mime: mime) }
                }
            }
        }
        .sheet(isPresented: $showForwardSheet) {
            ForwardMessageSheet(message: forwardMessage) { targetConversationId in
                showForwardSheet = false
                guard let msg = forwardMessage else { return }
                Task { await forwardMessageTo(msg, targetConversationId: targetConversationId) }
            }
        }
    }

    // MARK: - Extracted Sub-Views

    @ViewBuilder
    private var encryptionBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "lock.fill").font(.caption2)
            Text("Messages are end-to-end encrypted").font(.caption)
        }
        .foregroundColor(.turquoise)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color.turquoise.opacity(0.08))
    }

    @ViewBuilder
    private var messageListSection: some View {
        let msgs = filteredMessages
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(msgs.enumerated()), id: \.element.id) { index, msg in
                        let prev: ChatMessage? = index > 0 ? msgs[index - 1] : nil
                        let next: ChatMessage? = index < msgs.count - 1 ? msgs[index + 1] : nil

                        let curDate = parseISODate(msg.createdAt)
                        let prevDate = prev.flatMap { parseISODate($0.createdAt) }
                        let needsDateSep = curDate != nil && (prevDate == nil || !Calendar.current.isDate(curDate!, inSameDayAs: prevDate!))

                        if needsDateSep, let d = curDate {
                            Text(dateSeparatorLabel(for: d))
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(.adaptiveTextSec)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Color(.secondarySystemBackground).opacity(0.7))
                                .clipShape(Capsule())
                                .frame(maxWidth: .infinity)
                                .padding(.top, index == 0 ? 4 : 12)
                                .padding(.bottom, 4)
                        }

                        if msg.messageType == "screenshot_alert" {
                            let senderName = conversation.members.first(where: { $0.userId == msg.senderId })?.displayName
                                ?? conversation.members.first(where: { $0.userId == msg.senderId })?.username
                                ?? "Someone"
                            HStack {
                                Spacer()
                                Text("📸 \(senderName) took a screenshot")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 4)
                                    .background(Color(.secondarySystemBackground))
                                    .clipShape(Capsule())
                                Spacer()
                            }
                            .padding(.top, 4)
                            .id(msg.id)
                        } else {
                            let sameAsPrev = prev != nil
                                && prev!.senderId == msg.senderId
                                && prev!.messageType != "screenshot_alert"
                                && messagesWithinGroupWindow(prev!, msg)
                                && !needsDateSep
                            let sameAsNext = next != nil
                                && next!.senderId == msg.senderId
                                && next!.messageType != "screenshot_alert"
                                && messagesWithinGroupWindow(msg, next!)
                                && {
                                    guard let nd = parseISODate(next!.createdAt), let cd = curDate else { return true }
                                    return Calendar.current.isDate(nd, inSameDayAs: cd)
                                }()
                            let gp: MessageGroupPosition = {
                                switch (sameAsPrev, sameAsNext) {
                                case (false, false): return .single
                                case (false, true):  return .first
                                case (true, true):   return .middle
                                case (true, false):  return .last
                                }
                            }()

                            MessageBubbleView(
                                message: msg,
                                isMine: msg.senderId == userId,
                                bubbleMineColor: activeTheme.bubbleMine,
                                bubbleTheirsColor: activeTheme.bubbleTheirs,
                                groupPosition: gp,
                                showSenderName: !sameAsPrev,
                                showTimestamp: !sameAsNext,
                                onReact: { emoji in Task { await reactToMessage(msg.id, emoji: emoji) } },
                                onEdit: { editingMessageId = msg.id; inputText = msg.ciphertext },
                                onDelete: { Task { await deleteMessage(msg.id) } },
                                onPin: { Task { await pinMessage(msg.id) } },
                                onReply: {
                                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                        replyingTo = msg
                                    }
                                },
                                onForward: {
                                    forwardMessage = msg
                                    showForwardSheet = true
                                },
                                onBlock: {
                                    Task {
                                        _ = try? await APIClient.shared.postRaw("/contacts/block", body: ["userId": msg.senderId, "blocked": true])
                                    }
                                }
                            )
                            .id(msg.id)
                            .padding(.top, sameAsPrev ? 1 : 4)
                            .transition(.asymmetric(
                                insertion: .scale(scale: 0.85, anchor: .bottomTrailing)
                                    .combined(with: .opacity)
                                    .combined(with: .offset(y: 12)),
                                removal: .opacity.combined(with: .scale(scale: 0.9))
                            ))
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .onChange(of: messages.count) { _, _ in
                if let last = messages.last, last.senderId != userId {
                    #if canImport(UIKit)
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    #endif
                }
                if let last = messages.last {
                    withAnimation(.spring(response: 0.42, dampingFraction: 0.72)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var replyBanner: some View {
        if let reply = replyingTo {
            HStack(spacing: 10) {
                Rectangle()
                    .fill(Color.rocGold)
                    .frame(width: 3)
                    .cornerRadius(1.5)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Replying to \(reply.senderId == userId ? "yourself" : "message")")
                        .font(.caption2)
                        .foregroundColor(.rocGold)
                    Text(reply.ciphertext.isEmpty ? "🔒 Encrypted" : reply.ciphertext)
                        .font(.caption)
                        .foregroundColor(.adaptiveTextSec)
                        .lineLimit(1)
                }
                Spacer()
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                        replyingTo = nil
                    }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundColor(.adaptiveTextSec)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.rocGold.opacity(0.08))
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private var composerSection: some View {
        if let url = pendingAudioURL {
            AudioPreviewBar(
                url: url,
                duration: pendingAudioDuration,
                onDiscard: {
                    try? FileManager.default.removeItem(at: url)
                    pendingAudioURL = nil
                },
                onSend: {
                    let u = url; let d = pendingAudioDuration
                    pendingAudioURL = nil
                    Task { await sendAudioNote(url: u, duration: d) }
                }
            )
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if isRecording {
            RecordingBar(
                elapsed: recordingElapsed,
                levels: recordingLevels,
                onCancel: { cancelRecording() },
                onSend: { finishRecording() }
            )
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else {
            typingAndInputBar
        }
    }

    @ViewBuilder
    private var typingAndInputBar: some View {
        if isRemoteTyping {
            HStack(spacing: 4) {
                Text("typing")
                    .font(.caption2)
                    .foregroundColor(.adaptiveTextSec)
                TypingDotsView()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
            .transition(.opacity)
        }
        if !remoteOnlineStatus.isEmpty {
            HStack(spacing: 4) {
                Circle()
                    .fill(remoteOnlineStatus == "online" ? Color.green : Color.gray)
                    .frame(width: 8, height: 8)
                Text(remoteOnlineStatus == "online" ? "Online" : "Offline")
                    .font(.caption2)
                    .foregroundColor(remoteOnlineStatus == "online" ? .green : .secondary)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 2)
        }
        HStack(alignment: .bottom, spacing: 10) {
            Menu {
                Button(action: { showPhotoPicker = true }) {
                    Label("Photo & Video", systemImage: "photo.on.rectangle")
                }
                Button(action: { showFilePicker = true }) {
                    Label("Document", systemImage: "doc.fill")
                }
                Button(action: { startRecording() }) {
                    Label("Voice Note", systemImage: "mic.fill")
                }
                Button(action: { showVideoRecorder = true }) {
                    Label("Video Message", systemImage: "video.fill")
                }
                Button(action: { showVaultComposer = true }) {
                    Label("Vault Item", systemImage: "lock.shield")
                }
            } label: {
                ZStack {
                    Circle()
                        .fill(Color.rocGold.opacity(0.12))
                        .frame(width: 40, height: 40)
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.rocGold)
                }
            }

            HStack(alignment: .center, spacing: 6) {
                TextField("Type a message...", text: $inputText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .onSubmit { sendMessage() }
                    .onChange(of: inputText) { _, _ in sendTypingIndicator() }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                Button(action: { showStickerPicker = true }) {
                    Image(systemName: "face.smiling")
                        .font(.system(size: 20))
                        .foregroundColor(.rocGold.opacity(0.7))
                }
                .padding(.trailing, 8)
                .accessibilityLabel("Open sticker picker")
            }
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(Color.rocGold.opacity(inputText.isEmpty ? 0.0 : 0.4), lineWidth: 1)
            )
            .animation(.easeInOut(duration: 0.18), value: inputText.isEmpty)

            Button(action: sendMessage) {
                ZStack {
                    Circle()
                        .fill(
                            inputText.trimmingCharacters(in: .whitespaces).isEmpty
                            ? Color.gray.opacity(0.18)
                            : Color.rocGold
                        )
                        .frame(width: 40, height: 40)
                        .shadow(color: Color.rocGold.opacity(inputText.isEmpty ? 0 : 0.35), radius: 6, y: 2)
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(
                            inputText.trimmingCharacters(in: .whitespaces).isEmpty ? .gray : .white
                        )
                        .rotationEffect(.degrees(inputText.isEmpty ? 0 : -0))
                }
                .scaleEffect(inputText.trimmingCharacters(in: .whitespaces).isEmpty ? 0.92 : 1.0)
                .animation(.spring(response: 0.35, dampingFraction: 0.6), value: inputText)
            }
            .buttonStyle(.plain)
            .disabled(inputText.trimmingCharacters(in: .whitespaces).isEmpty || isSending)
            .accessibilityLabel(isSending ? "Sending message" : "Send message")
            .accessibilityHint("Long-press to schedule")
            .contextMenu {
                Button {
                    showScheduleSheet = true
                } label: {
                    Label("Schedule Message", systemImage: "clock")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
    }

    @ToolbarContentBuilder
    private var conversationToolbarItems: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if conversation.isGroup {
                Button(action: {
                    if let task = wsTask {
                        let memberIds = conversation.members.map { $0.userId }
                        CallManager.shared.startGroupCall(
                            conversationId: conversation.id,
                            callType: .voice,
                            ws: task,
                            members: memberIds
                        )
                    }
                }) {
                    Image(systemName: "phone.fill").foregroundColor(.rocGold)
                }
            } else {
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
            }

            Button(action: { withAnimation { isSearching.toggle() } }) {
                Image(systemName: "magnifyingglass").foregroundColor(.rocGold)
            }

            Menu {
                Button(action: { showDisappearMenu = true }) {
                    Label(disappearTimer > 0 ? "Timer (On)" : "Disappearing Timer", systemImage: "timer")
                }
                Button(action: { loadSafetyNumber() }) {
                    Label("Safety Number", systemImage: "shield.fill")
                }
                Button(action: { showThemePicker = true }) {
                    Label("Chat Theme", systemImage: "paintpalette.fill")
                }
                Button(action: { Task { await loadPinnedMessages() }; showPinnedMessages = true }) {
                    Label("Pinned Messages", systemImage: "pin.fill")
                }
                Button(action: { showMediaGallery = true }) {
                    Label("Media Gallery", systemImage: "photo.on.rectangle")
                }
                if conversation.isGroup {
                    Button(action: { Task { await loadGroupMembers() }; showGroupAdmin = true }) {
                        Label("Group Members", systemImage: "person.3.fill")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundColor(.rocGold)
            }
        }
    }

    @ViewBuilder
    private var scheduleSheetContent: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text("Schedule Message").font(.headline)
                DatePicker("Send at", selection: $scheduleDate, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    .datePickerStyle(.graphical)
                    .tint(.rocGold)
                Button("Schedule") {
                    scheduleMessage()
                    showScheduleSheet = false
                }
                .buttonStyle(.borderedProminent)
                .tint(.rocGold)
                .disabled(inputText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showScheduleSheet = false }
                }
            }
        }
        .presentationDetents([.medium])
    }

    @ViewBuilder
    private var themePickerContent: some View {
            NavigationStack {
                List {
                    ForEach(chatThemeOptions, id: \.key) { theme in
                        Button(action: {
                            chatTheme = theme.key
                            UserDefaults.standard.set(theme.key, forKey: "theme_\(conversation.id)")
                            Task {
                                try? await APIClient.shared.postRaw("/messages/conversations/\(conversation.id)/theme", body: ["theme": theme.key], method: "PUT")
                            }
                            showThemePicker = false
                        }) {
                            HStack {
                                Circle()
                                    .fill(theme.color)
                                    .frame(width: 32, height: 32)
                                Text(theme.label)
                                    .foregroundColor(.primary)
                                Spacer()
                                if chatTheme == theme.key {
                                    Image(systemName: "checkmark").foregroundColor(.rocGold)
                                }
                            }
                        }
                    }
                }
                .navigationTitle("Chat Theme")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showThemePicker = false }
                    }
                }
            }
            .presentationDetents([.medium])
    }

    @ViewBuilder
    private var vaultComposerContent: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $vaultType) {
                    Text("🔑 Password").tag("password")
                    Text("📶 WiFi").tag("wifi")
                    Text("💳 Card").tag("card")
                    Text("📝 Note").tag("note")
                }
                .onChange(of: vaultType) { _, _ in vaultFields = [:] }
                TextField("Label", text: $vaultLabel)
                switch vaultType {
                case "password":
                    TextField("Username", text: Binding(get: { vaultFields["username"] ?? "" }, set: { vaultFields["username"] = $0 }))
                    SecureField("Password", text: Binding(get: { vaultFields["password"] ?? "" }, set: { vaultFields["password"] = $0 }))
                    TextField("URL (optional)", text: Binding(get: { vaultFields["url"] ?? "" }, set: { vaultFields["url"] = $0 }))
                case "wifi":
                    TextField("Network Name", text: Binding(get: { vaultFields["ssid"] ?? "" }, set: { vaultFields["ssid"] = $0 }))
                    SecureField("Password", text: Binding(get: { vaultFields["password"] ?? "" }, set: { vaultFields["password"] = $0 }))
                case "card":
                    TextField("Card Number", text: Binding(get: { vaultFields["number"] ?? "" }, set: { vaultFields["number"] = $0 }))
                        .keyboardType(.numberPad)
                    TextField("Expiry (MM/YY)", text: Binding(get: { vaultFields["expiry"] ?? "" }, set: { vaultFields["expiry"] = $0 }))
                    TextField("Cardholder Name", text: Binding(get: { vaultFields["name"] ?? "" }, set: { vaultFields["name"] = $0 }))
                case "note":
                    TextEditor(text: Binding(get: { vaultFields["text"] ?? "" }, set: { vaultFields["text"] = $0 }))
                        .frame(minHeight: 100)
                default: EmptyView()
                }
                Toggle("View once", isOn: $vaultViewOnce)
            }
            .navigationTitle("Share Vault Item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showVaultComposer = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { sendVaultItem() }
                        .disabled(vaultLabel.isEmpty)
                }
            }
        }
    }

    @ViewBuilder
    private var pinnedMessagesContent: some View {
        NavigationStack {
            List {
                if pinnedMessages.isEmpty {
                    Text("No pinned messages").foregroundColor(.secondary)
                }
                ForEach(pinnedMessages) { msg in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(msg.ciphertext.isEmpty ? "🔒 Encrypted" : msg.ciphertext)
                            .lineLimit(3)
                        Text(formatRelativeTime(msg.createdAt))
                            .font(.caption).foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Pinned Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { showPinnedMessages = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private var mediaGalleryContent: some View {
        NavigationStack {
            let mediaMessages = messages.filter { msg in
                guard let data = msg.ciphertext.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
                return json["blobId"] != nil
            }
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 4) {
                    ForEach(mediaMessages) { msg in
                        if let data = msg.ciphertext.data(using: .utf8),
                           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let blobId = json["blobId"] as? String {
                            AsyncImage(url: URL(string: "https://chat.mocipher.com/api/media/\(blobId)?cid=\(conversation.id)")) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                Rectangle().fill(Color.gray.opacity(0.2))
                                    .overlay(Image(systemName: "doc.fill").foregroundColor(.secondary))
                            }
                            .frame(width: 100, height: 100)
                            .clipped()
                        }
                    }
                }
                .padding(8)
            }
            .navigationTitle("Media")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { showMediaGallery = false }
                }
            }
        }
    }

    @ViewBuilder
    private var groupAdminContent: some View {
        NavigationStack {
            List {
                Section("Members (\(groupMembers.count))") {
                    ForEach(Array(groupMembers.enumerated()), id: \.offset) { _, member in
                        let name = member["display_name"] as? String ?? member["username"] as? String ?? "Unknown"
                        let role = member["role"] as? String ?? "member"
                        let memberId = member["user_id"] as? String ?? ""
                        HStack {
                            VStack(alignment: .leading) {
                                Text(name).font(.body)
                                Text(role).font(.caption).foregroundColor(.secondary)
                            }
                            Spacer()
                            if memberId != userId {
                                Menu {
                                    Button("Promote to Admin") {
                                        Task {
                                            _ = try? await APIClient.shared.postRaw("/groups/\(conversation.id)/promote", body: ["user_id": memberId, "role": "admin"])
                                            await loadGroupMembers()
                                        }
                                    }
                                    Button("Remove", role: .destructive) {
                                        Task {
                                            _ = try? await APIClient.shared.postRaw("/groups/\(conversation.id)/kick", body: ["user_id": memberId])
                                            await loadGroupMembers()
                                        }
                                    }
                                } label: {
                                    Image(systemName: "ellipsis.circle").foregroundColor(.rocGold)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Group Admin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { showGroupAdmin = false }
                }
            }
        }
    }

    // MARK: - Photo/File Attachment

    private func sendPhotoAttachment(data: Data) async {
        do {
            let recipientId = conversation.members.first(where: { $0.userId != userId })?.userId ?? ""
            // Encrypt file with random key
            let fileKey = SymmetricKey(size: .bits256)
            let iv = AES.GCM.Nonce()
            let sealed = try AES.GCM.seal(data, using: fileKey, nonce: iv)
            guard let encrypted = sealed.combined else { return }

            // Upload to R2
            let uploadResult = try await APIClient.shared.uploadMedia(encrypted, headers: [
                "x-conversation-id": conversation.id,
                "x-encrypted-filename": encryptProfileField("photo.jpg"),
                "x-encrypted-mimetype": encryptProfileField("image/jpeg"),
            ])
            let blobId = uploadResult

            // Send message with file metadata via Double Ratchet
            let payload: [String: Any] = [
                "type": "file",
                "blob_id": blobId,
                "file_key": fileKey.withUnsafeBytes { Data($0).base64EncodedString() },
                "file_iv": Data(iv).base64EncodedString(),
                "filename": "photo.jpg",
                "mime": "image/jpeg",
                "size": data.count
            ]
            let plaintext = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8) ?? ""

            var body: [String: Any] = [
                "conversation_id": conversation.id,
                "message_type": "file",
            ]
            if !recipientId.isEmpty {
                let envelope = try await SessionManager.shared.encryptMessage(
                    conversationId: conversation.id, recipientUserId: recipientId, plaintext: plaintext)
                body["ciphertext"] = envelope.ciphertext
                body["iv"] = envelope.iv
                body["ratchet_header"] = envelope.ratchetHeader
            } else if conversation.isGroup {
                let members = conversation.members.map { ($0.userId, $0.username) }
                _ = try await GroupSessionManager.shared.ensureDistributed(
                    groupId: conversation.id, members: members, myUserId: userId)
                guard let plaintextData = plaintext.data(using: .utf8) else {
                    throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode file message"])
                }
                let groupEnvelope = try GroupSessionManager.shared.encrypt(
                    groupId: conversation.id, plaintext: plaintextData, myUserId: userId)
                body["ciphertext"] = groupEnvelope.ciphertext
                body["iv"] = ""
                body["ratchet_header"] = groupEnvelope.ratchetHeader
            } else {
                throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Cannot send unencrypted message"])
            }
            _ = try await APIClient.shared.postRaw("/messages/send", body: body)
            messages.append(ChatMessage(id: "local-\(Date().timeIntervalSince1970)",
                conversationId: conversation.id, senderId: userId,
                ciphertext: "📎 Photo sent", iv: "", ratchetHeader: "",
                messageType: "file", createdAt: ISO8601DateFormatter().string(from: Date()), expiresAt: nil))
        } catch {}
    }

    private func sendFileAttachment(data: Data, filename: String, mime: String) async {
        do {
            let recipientId = conversation.members.first(where: { $0.userId != userId })?.userId ?? ""
            let fileKey = SymmetricKey(size: .bits256)
            let iv = AES.GCM.Nonce()
            let sealed = try AES.GCM.seal(data, using: fileKey, nonce: iv)
            guard let encrypted = sealed.combined else { return }

            let uploadResult = try await APIClient.shared.uploadMedia(encrypted, headers: [
                "x-conversation-id": conversation.id,
                "x-encrypted-filename": encryptProfileField(filename),
                "x-encrypted-mimetype": encryptProfileField(mime),
            ])
            let blobId = uploadResult

            let payload: [String: Any] = [
                "type": "file",
                "blob_id": blobId,
                "file_key": fileKey.withUnsafeBytes { Data($0).base64EncodedString() },
                "file_iv": Data(iv).base64EncodedString(),
                "filename": filename,
                "mime": mime,
                "size": data.count
            ]
            let plaintext = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8) ?? ""

            var body: [String: Any] = [
                "conversation_id": conversation.id,
                "message_type": "file",
            ]
            if !recipientId.isEmpty {
                let envelope = try await SessionManager.shared.encryptMessage(
                    conversationId: conversation.id, recipientUserId: recipientId, plaintext: plaintext)
                body["ciphertext"] = envelope.ciphertext
                body["iv"] = envelope.iv
                body["ratchet_header"] = envelope.ratchetHeader
            } else if conversation.isGroup {
                let members = conversation.members.map { ($0.userId, $0.username) }
                _ = try await GroupSessionManager.shared.ensureDistributed(
                    groupId: conversation.id, members: members, myUserId: userId)
                guard let plaintextData = plaintext.data(using: .utf8) else {
                    throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode file message"])
                }
                let groupEnvelope = try GroupSessionManager.shared.encrypt(
                    groupId: conversation.id, plaintext: plaintextData, myUserId: userId)
                body["ciphertext"] = groupEnvelope.ciphertext
                body["iv"] = ""
                body["ratchet_header"] = groupEnvelope.ratchetHeader
            } else {
                throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Cannot send unencrypted message"])
            }
            _ = try await APIClient.shared.postRaw("/messages/send", body: body)
            messages.append(ChatMessage(id: "local-\(Date().timeIntervalSince1970)",
                conversationId: conversation.id, senderId: userId,
                ciphertext: "📎 \(filename)", iv: "", ratchetHeader: "",
                messageType: "file", createdAt: ISO8601DateFormatter().string(from: Date()), expiresAt: nil))
        } catch {}
    }

    private func forwardMessageTo(_ msg: ChatMessage, targetConversationId: String) async {
        do {
            let allConvs = try await APIClient.shared.getConversations()
            guard let targetDict = allConvs.first(where: { ($0["id"] as? String) == targetConversationId }) else { return }

            let membersArr = targetDict["members"] as? [[String: Any]] ?? []
            let targetType = targetDict["type"] as? String ?? ""
            let isGroup = targetType == "group"
            let plaintext = msg.ciphertext

            var body: [String: Any] = [
                "conversation_id": targetConversationId,
                "message_type": msg.messageType,
            ]

            let recipientId = membersArr.first(where: { ($0["user_id"] as? String) != userId })?["user_id"] as? String ?? ""

            if !recipientId.isEmpty && !isGroup {
                let envelope = try await SessionManager.shared.encryptMessage(
                    conversationId: targetConversationId, recipientUserId: recipientId, plaintext: plaintext)
                body["ciphertext"] = envelope.ciphertext
                body["iv"] = envelope.iv
                body["ratchet_header"] = envelope.ratchetHeader
            } else if isGroup {
                let members = membersArr.map { (
                    $0["user_id"] as? String ?? "",
                    $0["username"] as? String ?? ""
                ) }
                _ = try await GroupSessionManager.shared.ensureDistributed(
                    groupId: targetConversationId, members: members, myUserId: userId)
                guard let plaintextData = plaintext.data(using: .utf8) else {
                    throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode forwarded message"])
                }
                let groupEnvelope = try GroupSessionManager.shared.encrypt(
                    groupId: targetConversationId, plaintext: plaintextData, myUserId: userId)
                body["ciphertext"] = groupEnvelope.ciphertext
                body["iv"] = ""
                body["ratchet_header"] = groupEnvelope.ratchetHeader
            } else {
                throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Cannot forward unencrypted message"])
            }

            _ = try await APIClient.shared.postRaw("/messages/send", body: body)
        } catch {}
    }

    private func sendTypingIndicator() {
        guard let task = wsTask, Date().timeIntervalSince(lastTypingSent) >= 3 else { return }
        lastTypingSent = Date()
        if let enc = encryptMeta(["isTyping": true]) {
            let msg: [String: Any] = ["type": "typing", "payload": ["e": enc]]
            if let data = try? JSONSerialization.data(withJSONObject: msg),
               let str = String(data: data, encoding: .utf8) {
                task.send(.string(str)) { _ in }
            }
        }
    }

    private func sendReadReceipt(messageId: String) {
        guard let task = wsTask else { return }
        if let enc = encryptMeta(["message_id": messageId]) {
            let msg: [String: Any] = ["type": "read_receipt", "payload": ["e": enc]]
            if let data = try? JSONSerialization.data(withJSONObject: msg),
               let str = String(data: data, encoding: .utf8) {
                task.send(.string(str)) { _ in }
            }
        }
    }

    // MARK: - Encrypted metadata (typing, presence, read receipts)
    // Key: SHA256(identityKey + ":meta:" + conversationId) → AES-GCM-256
    // Format: base64(iv) + "." + base64(ciphertext+tag) — matches web encryptMeta()

    private func getMetaKey() -> SymmetricKey {
        if let vaultData = SecureStorage.shared.getData(forKey: "rocchat_vault_key"), vaultData.count == 32 {
            let vk = SymmetricKey(data: vaultData)
            let info = Data(("rocchat:meta:" + conversation.id).utf8)
            return HKDF<SHA256>.deriveKey(inputKeyMaterial: vk, salt: Data(), info: info, outputByteCount: 32)
        }
        let idKey = UserDefaults.standard.string(forKey: "identity_pub") ?? conversation.id
        let raw = (idKey + ":meta:" + conversation.id).data(using: .utf8)!
        let hash = SHA256.hash(data: raw)
        return SymmetricKey(data: hash)
    }

    private func encryptMeta(_ dict: [String: Any]) -> String? {
        guard let plain = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
        let key = getMetaKey()
        let nonce = AES.GCM.Nonce()
        guard let sealed = try? AES.GCM.seal(plain, using: key, nonce: nonce) else { return nil }
        let ivData = Data(nonce)
        let ctAndTag = sealed.ciphertext + sealed.tag
        return ivData.base64EncodedString() + "." + ctAndTag.base64EncodedString()
    }

    private func decryptMeta(_ payload: String) -> [String: Any]? {
        let parts = payload.split(separator: ".", maxSplits: 1)
        guard parts.count == 2,
              let ivData = Data(base64Encoded: String(parts[0])),
              let ctData = Data(base64Encoded: String(parts[1])),
              ivData.count == 12, ctData.count >= 16 else { return nil }
        let key = getMetaKey()
        guard let nonce = try? AES.GCM.Nonce(data: ivData) else { return nil }
        let ciphertext = ctData.prefix(ctData.count - 16)
        let tag = ctData.suffix(16)
        guard let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag),
              let plain = try? AES.GCM.open(box, using: key) else { return nil }
        return try? JSONSerialization.jsonObject(with: plain) as? [String: Any]
    }

    private func loadSafetyNumber() {
        Task {
            guard let myKeyB64 = UserDefaults.standard.string(forKey: "identity_pub") else { return }
            let others = conversation.members.filter { $0.userId != userId }
            guard let peer = others.first else { return }
            do {
                let data = try await APIClient.shared.getRaw("/keys/bundle/\(peer.userId)")
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let bundle = json["bundle"] as? [String: Any],
                   let theirKeyB64 = bundle["identity_key"] as? String,
                   let myKey = Data(base64Encoded: myKeyB64),
                   let theirKey = Data(base64Encoded: theirKeyB64) {
                    // Sort keys for deterministic order, then SHA-512 → 12 groups of 5 digits
                    let sorted = myKey.lexicographicallyPrecedes(theirKey)
                        ? myKey + theirKey : theirKey + myKey
                    let hash = SHA512.hash(data: sorted)
                    let bytes = Array(hash)
                    var groups: [String] = []
                    var i = 0
                    while groups.count < 12 && i + 3 < bytes.count {
                        let num = (UInt32(bytes[i]) << 24) | (UInt32(bytes[i+1]) << 16) |
                                  (UInt32(bytes[i+2]) << 8) | UInt32(bytes[i+3])
                        groups.append(String(format: "%05d", num % 100000))
                        i += 5
                    }
                    safetyNumber = groups.joined(separator: " ")
                    showSafetyNumber = true
                }
            } catch { /* ignore */ }
        }
    }

    private func startRecording() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default)
            try session.setActive(true)
        } catch { return }

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice_note_\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            recorder.record()
            audioRecorder = recorder
            recordingURL = url
            recordingElapsed = 0
            recordingLevels = Array(repeating: 0.1, count: 32)
            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { isRecording = true }

            // Poll levels + timer at 10Hz
            recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
                guard let r = audioRecorder else { return }
                r.updateMeters()
                let p = r.averagePower(forChannel: 0) // dB, -160..0
                let norm = max(0.05, min(1.0, CGFloat(pow(10, p / 20))))
                recordingLevels.removeFirst()
                recordingLevels.append(norm)
                let secs = Int(r.currentTime)
                if secs != recordingElapsed { recordingElapsed = secs }
                if secs >= 300 { finishRecording() } // 5 min cap
            }
            if let t = recordingTimer { RunLoop.main.add(t, forMode: .common) }
        } catch { /* ignore */ }
    }

    private func cancelRecording() {
        recordingTimer?.invalidate(); recordingTimer = nil
        audioRecorder?.stop()
        if let url = recordingURL { try? FileManager.default.removeItem(at: url) }
        audioRecorder = nil
        recordingURL = nil
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { isRecording = false }
    }

    private func finishRecording() {
        recordingTimer?.invalidate(); recordingTimer = nil
        guard let recorder = audioRecorder, let url = recordingURL else {
            withAnimation { isRecording = false }
            return
        }
        let duration = Int(recorder.currentTime)
        recorder.stop()
        audioRecorder = nil
        recordingURL = nil
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
            isRecording = false
            pendingAudioURL = url
            pendingAudioDuration = max(1, duration)
        }
    }

    private func sendAudioNote(url: URL, duration: Int) async {
        guard let fileData = try? Data(contentsOf: url) else { return }

        // Transcribe in background (best-effort, doesn't block send)
        let transcript = await transcribeAudio(url: url)
        try? FileManager.default.removeItem(at: url)

        let others = conversation.members.filter { $0.userId != userId }
        guard let recipientId = others.first?.userId else { return }

        // Encrypt file
        let fileKey = SymmetricKey(size: .bits256)
        let nonce = AES.GCM.Nonce()
        guard let sealed = try? AES.GCM.seal(fileData, using: fileKey, nonce: nonce),
              let combined = sealed.combined else { return }
        let ciphertextWithTag = combined.dropFirst(12)
        let fileIvData = Data(nonce)
        let fileKeyData = fileKey.withUnsafeBytes { Data($0) }
        let fileHash = SHA256.hash(data: fileData)

        guard let uploadData = try? await APIClient.shared.uploadBinary(
            "/media/upload",
            data: Data(ciphertextWithTag),
            headers: [
                "Content-Type": "application/octet-stream",
                "x-conversation-id": conversation.id,
                "x-encrypted-filename": "voice_note.m4a",
                "x-encrypted-mimetype": "audio/mp4",
            ]
        ) else { return }
        guard let json = try? JSONSerialization.jsonObject(with: uploadData) as? [String: Any],
              let mediaId = json["mediaId"] as? String else { return }

        var voiceMsg: [String: Any] = [
            "type": "voice_note",
            "blobId": mediaId,
            "fileKey": fileKeyData.base64EncodedString(),
            "fileIv": fileIvData.base64EncodedString(),
            "fileHash": Data(fileHash).base64EncodedString(),
            "filename": "voice_note.m4a",
            "mime": "audio/mp4",
            "size": fileData.count,
            "duration": duration,
        ]
        if let transcript = transcript, !transcript.isEmpty {
            voiceMsg["transcript"] = transcript
        }
        guard let msgData = try? JSONSerialization.data(withJSONObject: voiceMsg),
              let msgStr = String(data: msgData, encoding: .utf8) else { return }

        guard let envelope = try? await SessionManager.shared.encryptMessage(
            conversationId: conversation.id,
            recipientUserId: recipientId,
            plaintext: msgStr
        ) else { return }

        _ = try? await APIClient.shared.postRaw("/messages/send", body: [
            "conversation_id": conversation.id,
            "ciphertext": envelope.ciphertext,
            "iv": envelope.iv,
            "ratchet_header": envelope.ratchetHeader,
            "message_type": "voice_note",
        ])

        await MainActor.run {
            messages.append(ChatMessage(
                id: UUID().uuidString,
                conversationId: conversation.id,
                senderId: userId,
                ciphertext: "🎙️ Voice note (\(duration)s)",
                iv: "", ratchetHeader: "",
                messageType: "voice_note",
                createdAt: ISO8601DateFormatter().string(from: Date()),
                expiresAt: disappearTimer > 0 ? Int(Date().timeIntervalSince1970) + disappearTimer : nil
            ))
        }
    }

    private func transcribeAudio(url: URL) async -> String? {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized ||
              SFSpeechRecognizer.authorizationStatus() == .notDetermined else { return nil }
        return await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                guard status == .authorized else { cont.resume(returning: nil); return }
                let recognizer = SFSpeechRecognizer()
                guard recognizer?.isAvailable == true else { cont.resume(returning: nil); return }
                let request = SFSpeechURLRecognitionRequest(url: url)
                request.shouldReportPartialResults = false
                recognizer?.recognitionTask(with: request) { result, error in
                    if let result = result, result.isFinal {
                        cont.resume(returning: result.bestTranscription.formattedString)
                    } else if error != nil {
                        cont.resume(returning: nil)
                    }
                }
            }
        }
    }

    private func sendVideoNote(url: URL, duration: Int) async {
        guard let fileData = try? Data(contentsOf: url) else { return }
        try? FileManager.default.removeItem(at: url)
        let others = conversation.members.filter { $0.userId != userId }
        guard let recipientId = others.first?.userId else { return }

        let fileKey = SymmetricKey(size: .bits256)
        let nonce = AES.GCM.Nonce()
        guard let sealed = try? AES.GCM.seal(fileData, using: fileKey, nonce: nonce),
              let combined = sealed.combined else { return }
        let ciphertextWithTag = combined.dropFirst(12)
        let fileIvData = Data(nonce)
        let fileKeyData = fileKey.withUnsafeBytes { Data($0) }
        let fileHash = SHA256.hash(data: fileData)

        guard let uploadData = try? await APIClient.shared.uploadBinary(
            "/media/upload", data: Data(ciphertextWithTag),
            headers: [
                "Content-Type": "application/octet-stream",
                "x-conversation-id": conversation.id,
                "x-encrypted-filename": "video_note.mp4",
                "x-encrypted-mimetype": "video/mp4",
            ]
        ) else { return }
        guard let json = try? JSONSerialization.jsonObject(with: uploadData) as? [String: Any],
              let mediaId = json["mediaId"] as? String else { return }

        let vm: [String: Any] = [
            "type": "video_note",
            "blobId": mediaId,
            "fileKey": fileKeyData.base64EncodedString(),
            "fileIv": fileIvData.base64EncodedString(),
            "fileHash": Data(fileHash).base64EncodedString(),
            "filename": "video_note.mp4",
            "mime": "video/mp4",
            "size": fileData.count,
            "duration": duration,
        ]
        guard let msgData = try? JSONSerialization.data(withJSONObject: vm),
              let msgStr = String(data: msgData, encoding: .utf8) else { return }

        guard let envelope = try? await SessionManager.shared.encryptMessage(
            conversationId: conversation.id,
            recipientUserId: recipientId,
            plaintext: msgStr
        ) else { return }

        _ = try? await APIClient.shared.postRaw("/messages/send", body: [
            "conversation_id": conversation.id,
            "ciphertext": envelope.ciphertext,
            "iv": envelope.iv,
            "ratchet_header": envelope.ratchetHeader,
            "message_type": "video_note",
        ])
        await MainActor.run {
            messages.append(ChatMessage(
                id: UUID().uuidString,
                conversationId: conversation.id,
                senderId: userId,
                ciphertext: "🎥 Video message (\(duration)s)",
                iv: "", ratchetHeader: "",
                messageType: "video_note",
                createdAt: ISO8601DateFormatter().string(from: Date()),
                expiresAt: disappearTimer > 0 ? Int(Date().timeIntervalSince1970) + disappearTimer : nil
            ))
        }
    }

    private func stopRecording() {
        // Legacy entry point kept for any external callers — now routes through finish.
        finishRecording()
    }

    private func loadMessages() async {
        do {
            let data = try await APIClient.shared.getRaw("/messages/\(conversation.id)")
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let arr = json["messages"] as? [[String: Any]] {
                messages = arr.compactMap { m in
                    guard let id = m["id"] as? String,
                          let sid = m["sender_id"] as? String else { return nil }
                    let ct = m["ciphertext"] as? String ?? ""
                    let iv = m["iv"] as? String ?? ""
                    let rh = m["ratchet_header"] as? String ?? ""
                    let displayText: String
                    if !rh.isEmpty {
                        if let rhData = rh.data(using: .utf8),
                           let rhJson = try? JSONSerialization.jsonObject(with: rhData) as? [String: Any],
                           rhJson["groupEncrypted"] as? Bool == true,
                           let groupSenderId = rhJson["senderId"] as? String {
                            displayText = (try? String(data: GroupSessionManager.shared.decrypt(
                                groupId: conversation.id, senderId: groupSenderId,
                                ciphertextB64: ct, ratchetHeader: rh), encoding: .utf8)) ?? "[Unable to decrypt]"
                        } else if !iv.isEmpty {
                            displayText = (try? SessionManager.shared.decryptMessage(
                                conversationId: conversation.id,
                                ciphertext: ct, iv: iv, ratchetHeaderStr: rh
                            )) ?? "[Unable to decrypt]"
                        } else {
                            displayText = "[Unable to decrypt]"
                        }
                    } else {
                        displayText = "[Unable to decrypt]"
                    }
                    return ChatMessage(
                        id: id,
                        conversationId: conversation.id,
                        senderId: sid,
                        ciphertext: displayText,
                        iv: iv,
                        ratchetHeader: rh,
                        messageType: m["message_type"] as? String ?? "text",
                        createdAt: m["created_at"] as? String ?? "",
                        expiresAt: m["expires_at"] as? Int,
                        status: m["status"] as? String ?? "sent"
                    )
                }
            }
            // Send read receipt for the last message from another user
            if let lastFromOther = messages.last(where: { $0.senderId != userId }) {
                sendReadReceipt(messageId: lastFromOther.id)
            }
        } catch {}
    }

    private func sendVaultItem() {
        let payload = try? JSONSerialization.data(withJSONObject: vaultFields)
        let encoded = payload?.base64EncodedString() ?? ""
        let vault: [String: Any] = [
            "type": "vault_item",
            "vaultType": vaultType,
            "label": vaultLabel,
            "encryptedPayload": encoded,
            "viewOnce": vaultViewOnce,
            "timestamp": Int(Date().timeIntervalSince1970),
        ]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: vault),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return }
        showVaultComposer = false
        vaultLabel = ""; vaultFields = [:]; vaultViewOnce = false
        Task {
            let recipientId = conversation.members.first(where: { $0.userId != userId })?.userId ?? ""
            var body: [String: Any] = [
                "conversation_id": conversation.id,
                "message_type": "vault_item",
            ]
            if !recipientId.isEmpty {
                let envelope = try await SessionManager.shared.encryptMessage(
                    conversationId: conversation.id,
                    recipientUserId: recipientId,
                    plaintext: jsonString
                )
                body["ciphertext"] = envelope.ciphertext
                body["iv"] = envelope.iv
                body["ratchet_header"] = envelope.ratchetHeader
            } else {
                body["encrypted"] = jsonString
            }
            _ = try? await APIClient.shared.postRaw("/messages/send", body: body)
        }
    }

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !isSending else { return }
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        // Dismiss the soft keyboard after tapping send — matches iMessage
        // and keeps the timeline visible instead of half-occluded.
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil, from: nil, for: nil)
        #endif
        let wasReplyingTo = replyingTo
        replyingTo = nil
        inputText = ""
        isSending = true

        // Handle edit mode
        if let editId = editingMessageId {
            editingMessageId = nil
            Task {
                do {
                    let recipientId = conversation.members.first(where: { $0.userId != userId })?.userId ?? ""
                    var encryptedPayload: [String: Any]
                    if !recipientId.isEmpty {
                        let envelope = try await SessionManager.shared.encryptMessage(
                            conversationId: conversation.id,
                            recipientUserId: recipientId,
                            plaintext: text
                        )
                        encryptedPayload = [
                            "ciphertext": envelope.ciphertext,
                            "iv": envelope.iv,
                            "ratchet_header": envelope.ratchetHeader,
                            "message_type": "text",
                        ]
                    } else if conversation.isGroup {
                        let members = conversation.members.map { ($0.userId, $0.username) }
                        _ = try await GroupSessionManager.shared.ensureDistributed(
                            groupId: conversation.id,
                            members: members,
                            myUserId: userId
                        )
                        guard let plaintextData = text.data(using: .utf8) else {
                            throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode message"])
                        }
                        let groupEnvelope = try GroupSessionManager.shared.encrypt(
                            groupId: conversation.id,
                            plaintext: plaintextData,
                            myUserId: userId
                        )
                        encryptedPayload = [
                            "ciphertext": groupEnvelope.ciphertext,
                            "iv": "",
                            "ratchet_header": groupEnvelope.ratchetHeader,
                            "message_type": "text",
                        ]
                    } else {
                        throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Cannot send unencrypted edit"])
                    }
                    let jsonData = try JSONSerialization.data(withJSONObject: encryptedPayload)
                    let jsonString = String(data: jsonData, encoding: .utf8) ?? "{}"
                    _ = try await APIClient.shared.postRaw("/messages/\(editId)", body: ["encrypted": jsonString], method: "PATCH")
                    if let idx = messages.firstIndex(where: { $0.id == editId }) {
                        messages[idx] = ChatMessage(id: editId, conversationId: conversation.id, senderId: userId,
                            ciphertext: text, iv: "", ratchetHeader: "", messageType: "text",
                            createdAt: messages[idx].createdAt, expiresAt: messages[idx].expiresAt)
                    }
                } catch {}
                isSending = false
            }
            return
        }

        // Haptic feedback
        let impact = UIImpactFeedbackGenerator(style: .light)
        impact.impactOccurred()

        let localId = "queued-\(Date().timeIntervalSince1970)"

        Task {
            do {
                let recipientId = conversation.members.first(where: { $0.userId != userId })?.userId ?? ""
                var body: [String: Any] = [
                    "conversation_id": conversation.id,
                    "message_type": "text",
                ]
                if let replyMsg = wasReplyingTo {
                    body["reply_to"] = replyMsg.id
                }
                if !recipientId.isEmpty {
                    let envelope = try await SessionManager.shared.encryptMessage(
                        conversationId: conversation.id,
                        recipientUserId: recipientId,
                        plaintext: text
                    )
                    body["ciphertext"] = envelope.ciphertext
                    body["iv"] = envelope.iv
                    body["ratchet_header"] = envelope.ratchetHeader
                } else if conversation.isGroup {
                    let members = conversation.members.map { ($0.userId, $0.username) }
                    _ = try await GroupSessionManager.shared.ensureDistributed(
                        groupId: conversation.id,
                        members: members,
                        myUserId: userId
                    )
                    guard let plaintextData = text.data(using: .utf8) else {
                        throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode message"])
                    }
                    let groupEnvelope = try GroupSessionManager.shared.encrypt(
                        groupId: conversation.id,
                        plaintext: plaintextData,
                        myUserId: userId
                    )
                    body["ciphertext"] = groupEnvelope.ciphertext
                    body["iv"] = ""
                    body["ratchet_header"] = groupEnvelope.ratchetHeader
                } else {
                    throw NSError(domain: "RocChat", code: -1, userInfo: [NSLocalizedDescriptionKey: "Cannot send unencrypted message"])
                }
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
                    createdAt: ISO8601DateFormatter().string(from: Date()),
                    expiresAt: disappearTimer > 0 ? Int(Date().timeIntervalSince1970) + disappearTimer : nil
                ))
            } catch {
                // Queue message for later delivery
                queueMessage(localId: localId, text: text)
                messages.append(ChatMessage(
                    id: localId,
                    conversationId: conversation.id,
                    senderId: userId,
                    ciphertext: "⏳ \(text)",
                    iv: "", ratchetHeader: "",
                    messageType: "text",
                    createdAt: ISO8601DateFormatter().string(from: Date()),
                    expiresAt: disappearTimer > 0 ? Int(Date().timeIntervalSince1970) + disappearTimer : nil
                ))
                isOffline = true
            }
            isSending = false
        }
    }

    // MARK: - Offline Message Queue

    // MARK: - Reactions / Edit / Delete / Pin

    private func reactToMessage(_ msgId: String, emoji: String) async {
        do {
            let encrypted = encryptProfileField(emoji)
            _ = try await APIClient.shared.postRaw("/messages/\(msgId)/react", body: ["encrypted_reaction": encrypted])
        } catch {}
    }

    private func deleteMessage(_ msgId: String) async {
        do {
            _ = try await APIClient.shared.deleteRaw("/messages/\(msgId)")
            messages.removeAll { $0.id == msgId }
        } catch {}
    }

    private func pinMessage(_ msgId: String) async {
        do {
            _ = try await APIClient.shared.postRaw("/messages/conversations/\(conversation.id)/pin/\(msgId)", body: [:])
        } catch {}
    }

    private static let queueKey = "rocchat_message_queue"

    private func queueMessage(localId: String, text: String) {
        var queue = loadQueue()
        let item: [String: String] = [
            "localId": localId,
            "conversationId": conversation.id,
            "text": text,
            "recipientUserId": conversation.members.first(where: { $0.userId != userId })?.userId ?? "",
        ]
        queue.append(item)
        saveQueue(queue)
    }

    private func loadQueue() -> [[String: String]] {
        guard let data = UserDefaults.standard.data(forKey: Self.queueKey),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else {
            return []
        }
        return arr
    }

    private func saveQueue(_ queue: [[String: String]]) {
        if let data = try? JSONSerialization.data(withJSONObject: queue) {
            UserDefaults.standard.set(data, forKey: Self.queueKey)
        }
    }

    private func flushMessageQueue() async {
        let queue = loadQueue()
        var remaining: [[String: String]] = []
        for item in queue {
            guard let convId = item["conversationId"],
                  let text = item["text"],
                  let recipientId = item["recipientUserId"],
                  let localId = item["localId"] else { continue }
            do {
                var body: [String: Any] = ["conversation_id": convId, "message_type": "text"]
                if !recipientId.isEmpty {
                    let envelope = try await SessionManager.shared.encryptMessage(
                        conversationId: convId, recipientUserId: recipientId, plaintext: text
                    )
                    body["ciphertext"] = envelope.ciphertext
                    body["iv"] = envelope.iv
                    body["ratchet_header"] = envelope.ratchetHeader
                } else {
                    body["ciphertext"] = text; body["iv"] = ""; body["ratchet_header"] = ""
                }
                _ = try await APIClient.shared.postRaw("/messages/send", body: body)
                // Update local message from queued to sent
                if let idx = messages.firstIndex(where: { $0.id == localId }) {
                    messages[idx] = ChatMessage(
                        id: "sent-\(Date().timeIntervalSince1970)",
                        conversationId: convId,
                        senderId: userId,
                        ciphertext: text,
                        iv: "", ratchetHeader: "",
                        messageType: "text",
                        createdAt: ISO8601DateFormatter().string(from: Date()),
                        expiresAt: nil
                    )
                }
            } catch {
                remaining.append(item)
                break // Still offline
            }
        }
        saveQueue(remaining)
        if remaining.isEmpty { isOffline = false }
    }

    private func scheduleMessage() {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        inputText = ""
        Task {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            let body: [String: Any] = [
                "conversation_id": conversation.id,
                "ciphertext": text,
                "scheduled_at": iso.string(from: scheduleDate),
            ]
            _ = try? await APIClient.shared.postRaw("/features/scheduled", body: body)
        }
    }

    private func loadPinnedMessages() async {
        do {
            let data = try await APIClient.shared.getRaw("/messages/conversations/\(conversation.id)/pins")
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let pins = json["pins"] as? [[String: Any]] {
                pinnedMessages = pins.compactMap { m in
                    ChatMessage(
                        id: m["id"] as? String ?? UUID().uuidString,
                        conversationId: conversation.id,
                        senderId: m["sender_id"] as? String ?? "",
                        ciphertext: m["ciphertext"] as? String ?? "",
                        iv: m["iv"] as? String ?? "",
                        ratchetHeader: m["ratchet_header"] as? String ?? "",
                        messageType: m["message_type"] as? String ?? "text",
                        createdAt: m["created_at"] as? String ?? "",
                        expiresAt: m["expires_at"] as? Int,
                        status: "sent"
                    )
                }
            }
        } catch {}
    }

    private func loadGroupMembers() async {
        do {
            let data = try await APIClient.shared.getRaw("/groups/\(conversation.id)/members")
            if let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                groupMembers = arr
            }
        } catch {}
    }

    private func notifyScreenshot() async {
        // Encrypt the screenshot alert through the Double Ratchet session
        let recipientId = conversation.members.first(where: { $0.userId != userId })?.userId ?? ""
        var body: [String: Any] = [
            "conversation_id": conversation.id,
            "message_type": "screenshot_alert",
        ]
        if !recipientId.isEmpty {
            if let envelope = try? await SessionManager.shared.encryptMessage(
                conversationId: conversation.id,
                recipientUserId: recipientId,
                plaintext: "📸 Screenshot taken"
            ) {
                body["ciphertext"] = envelope.ciphertext
                body["iv"] = envelope.iv
                body["ratchet_header"] = envelope.ratchetHeader
            } else {
                return // Don't send unencrypted
            }
        } else {
            return
        }
        _ = try? await APIClient.shared.postRaw("/messages/send", body: body)
    }

    private func connectWebSocket() {
          guard !userId.isEmpty else { return }

        Task {
            let deviceId = "ios"

            guard let ticket = await fetchWsTicket(),
                  var components = URLComponents(string: "wss://rocchat-api.spoass.workers.dev/api/ws/\(conversation.id)") else { return }
            components.queryItems = [
                URLQueryItem(name: "userId", value: userId),
                URLQueryItem(name: "deviceId", value: deviceId),
                URLQueryItem(name: "ticket", value: ticket),
            ]
            guard let url = components.url else { return }

            let task = APIClient.shared.webSocketTask(with: url)
            wsTask = task
            task.resume()
            // Successful resume does not mean the socket is open, but receive()
            // failing is our only signal — so reset the attempt counter optimistically
            // here and let the failure branch bump it back up.
            wsReconnectAttempt = 0
            receiveMessages(task: task)
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
                            let ct = payload["ciphertext"] as? String ?? ""
                            let iv = payload["iv"] as? String ?? ""
                            let rh = payload["ratchet_header"] as? String ?? ""
                            let displayText: String
                            if !rh.isEmpty {
                                if let rhData = rh.data(using: .utf8),
                                   let rhJson = try? JSONSerialization.jsonObject(with: rhData) as? [String: Any],
                                   rhJson["groupEncrypted"] as? Bool == true,
                                   let groupSenderId = rhJson["senderId"] as? String {
                                    displayText = (try? String(data: GroupSessionManager.shared.decrypt(
                                        groupId: conversation.id, senderId: groupSenderId,
                                        ciphertextB64: ct, ratchetHeader: rh), encoding: .utf8)) ?? "[Unable to decrypt]"
                                } else if !iv.isEmpty {
                                    displayText = (try? SessionManager.shared.decryptMessage(
                                        conversationId: conversation.id,
                                        ciphertext: ct, iv: iv, ratchetHeaderStr: rh
                                    )) ?? "[Unable to decrypt]"
                                } else {
                                    displayText = "[Unable to decrypt]"
                                }
                            } else {
                                displayText = "[Unable to decrypt]"
                            }
                            let newMsg = ChatMessage(
                                id: payload["id"] as? String ?? "ws-\(Date().timeIntervalSince1970)",
                                conversationId: conversation.id,
                                senderId: payload["fromUserId"] as? String ?? payload["sender_id"] as? String ?? "",
                                ciphertext: displayText,
                                iv: "",
                                ratchetHeader: "",
                                messageType: payload["message_type"] as? String ?? "text",
                                createdAt: payload["created_at"] as? String ?? ISO8601DateFormatter().string(from: Date()),
                                expiresAt: payload["expires_at"] as? Int
                            )
                            DispatchQueue.main.async {
                                messages.append(newMsg)
                                // Send delivery receipt back (encrypted, matching Android/web)
                                if newMsg.senderId != userId, let msgId = payload["id"] as? String {
                                    if let enc = encryptMeta(["message_id": msgId]) {
                                        let receipt: [String: Any] = ["type": "delivery_receipt", "payload": ["e": enc]]
                                        if let data = try? JSONSerialization.data(withJSONObject: receipt),
                                           let str = String(data: data, encoding: .utf8) {
                                            task.send(.string(str)) { _ in }
                                        }
                                    }
                                }
                            }
                        } else if type == "call_offer" {
                            DispatchQueue.main.async {
                                CallManager.shared.handleIncomingOffer(
                                    payload: payload,
                                    conversationId: conversation.id,
                                    ws: task
                                )
                            }
                        } else if type == "call_answer" {
                            DispatchQueue.main.async {
                                CallManager.shared.handleCallAnswer(payload: payload)
                            }
                        } else if type == "call_ice" {
                            DispatchQueue.main.async {
                                CallManager.shared.handleIceCandidate(payload: payload)
                            }
                        } else if type == "call_end" {
                            DispatchQueue.main.async {
                                CallManager.shared.handleCallEnd(payload: payload)
                            }
                        } else if type == "call_audio" {
                            DispatchQueue.main.async {
                                CallManager.shared.handleCallAudio(payload: payload)
                            }
                        } else if type == "call_video" {
                            DispatchQueue.main.async {
                                CallManager.shared.handleCallVideo(payload: payload)
                            }
                        } else if type == "call_p2p_candidate" {
                            DispatchQueue.main.async {
                                CallManager.shared.handleP2PCandidate(payload: payload)
                            }
                        } else if type == "delivery_receipt" || type == "read_receipt" {
                            if let enc = payload["e"] as? String, let meta = decryptMeta(enc) {
                                let msgId = meta["message_id"] as? String ?? ""
                                let newStatus = type == "read_receipt" ? "read" : "delivered"
                                DispatchQueue.main.async {
                                    if let idx = messages.firstIndex(where: { $0.id == msgId }) {
                                        messages[idx].status = newStatus
                                    }
                                }
                            }
                        } else if type == "typing" {
                            if let enc = payload["e"] as? String, let meta = decryptMeta(enc) {
                                let isTyping = meta["isTyping"] as? Bool ?? false
                                DispatchQueue.main.async {
                                    if isTyping {
                                        withAnimation { isRemoteTyping = true }
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                                            withAnimation { isRemoteTyping = false }
                                        }
                                    } else {
                                        withAnimation { isRemoteTyping = false }
                                    }
                                }
                            }
                        } else if type == "presence" {
                            if let enc = payload["e"] as? String, let meta = decryptMeta(enc) {
                                let status = meta["status"] as? String ?? ""
                                DispatchQueue.main.async { remoteOnlineStatus = status }
                            }
                        } else if type == "reaction" {
                            let msgId = payload["message_id"] as? String ?? ""
                            let encryptedReaction = payload["encrypted_reaction"] as? String ?? ""
                            let reactUserId = payload["user_id"] as? String ?? payload["fromUserId"] as? String ?? ""
                            let emoji = decryptProfileField(encryptedReaction)
                            DispatchQueue.main.async {
                                if let idx = messages.firstIndex(where: { $0.id == msgId }) {
                                    var reactions = messages[idx].reactions ?? []
                                    reactions.append(["emoji": emoji, "user_id": reactUserId])
                                    messages[idx].reactions = reactions
                                }
                            }
                        } else if type == "message_edit" {
                            let msgId = payload["message_id"] as? String ?? ""
                            let newCiphertext = payload["ciphertext"] as? String ?? ""
                            let newIv = payload["iv"] as? String ?? ""
                            let newRh = payload["ratchet_header"] as? String ?? ""
                            DispatchQueue.main.async {
                                if let idx = messages.firstIndex(where: { $0.id == msgId }) {
                                    let displayText: String
                                    if !newRh.isEmpty {
                                        if let rhData = newRh.data(using: .utf8),
                                           let rhJson = try? JSONSerialization.jsonObject(with: rhData) as? [String: Any],
                                           rhJson["groupEncrypted"] as? Bool == true,
                                           let groupSenderId = rhJson["senderId"] as? String {
                                            displayText = (try? String(data: GroupSessionManager.shared.decrypt(
                                                groupId: conversation.id, senderId: groupSenderId,
                                                ciphertextB64: newCiphertext, ratchetHeader: newRh), encoding: .utf8)) ?? "[Unable to decrypt]"
                                        } else if !newIv.isEmpty {
                                            displayText = (try? SessionManager.shared.decryptMessage(
                                                conversationId: conversation.id,
                                                ciphertext: newCiphertext, iv: newIv, ratchetHeaderStr: newRh
                                            )) ?? "[Unable to decrypt]"
                                        } else {
                                            displayText = "[Unable to decrypt]"
                                        }
                                    } else {
                                        displayText = "[Unable to decrypt]"
                                    }
                                    messages[idx].ciphertext = displayText + " (edited)"
                                }
                            }
                        } else if type == "message_delete" {
                            let msgId = payload["message_id"] as? String ?? ""
                            DispatchQueue.main.async {
                                messages.removeAll { $0.id == msgId }
                            }
                        } else if type == "message_pin" {
                            // Pin updates — just refresh the pinned list if viewing
                        }
                    }
                default: break
                }
                receiveMessages(task: task)
            case .failure:
                // Exponential backoff with jitter. Steps (seconds): 1,2,4,8,16,32,60.
                // This avoids hammering the server when the network flaps or
                // when we're caught in a TURN / auth loop.
                let steps: [Double] = [1, 2, 4, 8, 16, 32, 60]
                let idx = min(wsReconnectAttempt, steps.count - 1)
                let base = steps[idx]
                let jitter = Double.random(in: 0...0.5)
                wsReconnectAttempt += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + base + jitter, execute: DispatchWorkItem {
                    connectWebSocket()
                    Task { await flushMessageQueue() }
                })
            }
        }
    }
}

// MARK: - Message Grouping

enum MessageGroupPosition {
    case single, first, middle, last
}

private func parseISODate(_ iso: String) -> Date? {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
}

private func dateSeparatorLabel(for date: Date) -> String {
    let cal = Calendar.current
    if cal.isDateInToday(date) { return "Today" }
    if cal.isDateInYesterday(date) { return "Yesterday" }
    let f = DateFormatter()
    f.dateFormat = cal.isDate(date, equalTo: Date(), toGranularity: .year) ? "MMM d" : "MMM d, yyyy"
    return f.string(from: date)
}

private func messagesWithinGroupWindow(_ a: ChatMessage, _ b: ChatMessage) -> Bool {
    guard let da = parseISODate(a.createdAt), let db = parseISODate(b.createdAt) else { return false }
    return abs(da.timeIntervalSince(db)) < 120
}

// MARK: - Message Bubble

struct MessageBubbleView: View {
    let message: ChatMessage
    let isMine: Bool
    var bubbleMineColor: Color = Color.rocGold.opacity(0.12)
    var bubbleTheirsColor: Color = Color.adaptiveBubbleTheirs
    var groupPosition: MessageGroupPosition = .single
    var showSenderName: Bool = true
    var showTimestamp: Bool = true
    var onReact: ((String) -> Void)?
    var onEdit: (() -> Void)?
    var onDelete: (() -> Void)?
    var onPin: (() -> Void)?
    var onReply: (() -> Void)?
    var onForward: (() -> Void)?
    var onBlock: (() -> Void)?
    @State private var viewOnceRevealed = false
    @State private var viewOnceImage: UIImage?
    @State private var showViewOnceModal = false
    @State private var swipeOffset: CGFloat = 0
    @State private var didTriggerReply = false

    private var parsedFileMessage: [String: Any]? {
        guard let data = message.ciphertext.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["blobId"] != nil else { return nil }
        return json
    }

    private var isViewOnce: Bool {
        parsedFileMessage?["viewOnce"] as? Bool == true
    }

    private var viewOnceViewedKey: String {
        "rocchat_viewed_\(message.id)"
    }

    private var alreadyViewed: Bool {
        UserDefaults.standard.bool(forKey: viewOnceViewedKey)
    }

    private var groupedBubbleShape: UnevenRoundedRectangle {
        let full: CGFloat = 18
        let tight: CGFloat = 6
        switch groupPosition {
        case .single:
            return UnevenRoundedRectangle(topLeadingRadius: full, bottomLeadingRadius: full, bottomTrailingRadius: full, topTrailingRadius: full)
        case .first:
            return isMine
                ? UnevenRoundedRectangle(topLeadingRadius: full, bottomLeadingRadius: full, bottomTrailingRadius: tight, topTrailingRadius: full)
                : UnevenRoundedRectangle(topLeadingRadius: full, bottomLeadingRadius: tight, bottomTrailingRadius: full, topTrailingRadius: full)
        case .middle:
            return isMine
                ? UnevenRoundedRectangle(topLeadingRadius: full, bottomLeadingRadius: full, bottomTrailingRadius: tight, topTrailingRadius: tight)
                : UnevenRoundedRectangle(topLeadingRadius: tight, bottomLeadingRadius: tight, bottomTrailingRadius: full, topTrailingRadius: full)
        case .last:
            return isMine
                ? UnevenRoundedRectangle(topLeadingRadius: full, bottomLeadingRadius: full, bottomTrailingRadius: full, topTrailingRadius: tight)
                : UnevenRoundedRectangle(topLeadingRadius: tight, bottomLeadingRadius: full, bottomTrailingRadius: full, topTrailingRadius: full)
        }
    }

    var body: some View {
        HStack {
            if isMine { Spacer(minLength: 60) }

            VStack(alignment: isMine ? .trailing : .leading, spacing: 3) {
                if isViewOnce {
                    viewOnceContent
                } else if let vaultItem = parseVaultItem(message.ciphertext) {
                    VaultItemView(vault: vaultItem, messageId: message.id)
                } else {
                    Text(message.ciphertext.isEmpty ? "🔒 Encrypted" : message.ciphertext)
                        .font(.body)
                        .foregroundColor(.adaptiveText)
                    // Link preview
                    if let url = extractURL(from: message.ciphertext) {
                        LinkPreviewView(urlString: url)
                    }
                }

                if showTimestamp {
                    HStack(spacing: 4) {
                        Image(systemName: "lock.fill")
                            .font(.caption2)
                            .imageScale(.small)
                            .foregroundColor(.adaptiveTextSec)
                        Text(formatRelativeTime(message.createdAt))
                            .font(.caption2)
                            .foregroundColor(.adaptiveTextSec)
                        if isMine {
                            switch message.status {
                            case "read":
                                Text("✓✓").font(.caption2).foregroundColor(.turquoise)
                            case "delivered":
                                Text("✓✓").font(.caption2).foregroundColor(.adaptiveTextSec)
                            default:
                                Text("✓").font(.caption2).foregroundColor(.adaptiveTextSec)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(isMine ? bubbleMineColor : bubbleTheirsColor)
            .clipShape(groupedBubbleShape)
            .shadow(color: .black.opacity(0.04), radius: 2, y: 1)

            // Reactions display
            if let reactions = message.reactions, !reactions.isEmpty {
                let grouped = Dictionary(grouping: reactions, by: { $0["emoji"] ?? "" })
                HStack(spacing: 4) {
                    ForEach(Array(grouped.keys.sorted()), id: \.self) { emoji in
                        let count = grouped[emoji]?.count ?? 0
                        Text("\(emoji) \(count)")
                            .font(.system(size: 12))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.rocGold.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
            }

            if !isMine { Spacer(minLength: 60) }
        }
        .contextMenu {
            // Quick reactions
            ForEach(["❤️", "👍", "😂", "😮", "😢", "🙏"], id: \.self) { emoji in
                Button(emoji) { onReact?(emoji) }
            }
            Divider()
            Button { onReply?() } label: {
                Label("Reply", systemImage: "arrowshape.turn.up.left")
            }
            Button { UIPasteboard.general.string = message.ciphertext } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            if isMine {
                Button { onEdit?() } label: {
                    Label("Edit", systemImage: "pencil")
                }
            }
            Button { onPin?() } label: {
                Label("Pin", systemImage: "pin")
            }
            Button { onForward?() } label: {
                Label("Forward", systemImage: "arrowshape.turn.up.right")
            }
            if isMine {
                Button(role: .destructive) { onDelete?() } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
            if !isMine {
                Divider()
                Button(role: .destructive) { onBlock?() } label: {
                    Label("Block User", systemImage: "hand.raised.fill")
                }
            }
        }
        .overlay(alignment: isMine ? .trailing : .leading) {
            // Telegram-style swipe-to-reply indicator
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.rocGold)
                .padding(8)
                .background(Color.rocGold.opacity(0.15))
                .clipShape(Circle())
                .opacity(Double(min(abs(swipeOffset), 60) / 60))
                .scaleEffect(0.6 + 0.4 * Double(min(abs(swipeOffset), 60) / 60))
                .offset(x: isMine ? 36 : -36)
                .allowsHitTesting(false)
        }
        .offset(x: swipeOffset)
        .animation(.interactiveSpring(response: 0.28, dampingFraction: 0.85), value: swipeOffset)
        .gesture(
            DragGesture(minimumDistance: 12, coordinateSpace: .local)
                .onChanged { value in
                    let dx = value.translation.width
                    // Incoming: drag RIGHT to reply. Outgoing: drag LEFT.
                    let valid = isMine ? (dx < 0 && dx > -120) : (dx > 0 && dx < 120)
                    if valid {
                        swipeOffset = dx
                        if !didTriggerReply && abs(dx) > 60 {
                            didTriggerReply = true
                            #if canImport(UIKit)
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            #endif
                            onReply?()
                        }
                    }
                }
                .onEnded { _ in
                    swipeOffset = 0
                    didTriggerReply = false
                }
        )
        .fullScreenCover(isPresented: $showViewOnceModal) {
            ViewOnceModalView(image: viewOnceImage, onClose: {
                showViewOnceModal = false
                UserDefaults.standard.set(true, forKey: viewOnceViewedKey)
                viewOnceRevealed = false
                viewOnceImage = nil
            })
        }
    }

    @ViewBuilder
    private var viewOnceContent: some View {
        if alreadyViewed || (viewOnceRevealed && viewOnceImage == nil) {
            HStack(spacing: 6) {
                Image(systemName: "eye")
                    .font(.system(size: 14))
                    .foregroundColor(.adaptiveTextSec)
                Text("Opened")
                    .font(.subheadline)
                    .foregroundColor(.adaptiveTextSec)
            }
        } else {
            Button(action: { revealViewOnce() }) {
                HStack(spacing: 8) {
                    Image(systemName: "eye.circle.fill")
                        .font(.system(size: 24))
                        .foregroundColor(.rocGold)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("View once photo")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.adaptiveText)
                        Text("Tap to open")
                            .font(.caption)
                            .foregroundColor(.adaptiveTextSec)
                    }
                }
                .padding(4)
            }
            .buttonStyle(.plain)
        }
    }

    private func revealViewOnce() {
        guard let fileMsg = parsedFileMessage,
              let blobId = fileMsg["blobId"] as? String,
              let fileKeyB64 = fileMsg["fileKey"] as? String,
              let fileIvB64 = fileMsg["fileIv"] as? String,
              let fileKeyData = Data(base64Encoded: fileKeyB64),
              let fileIvData = Data(base64Encoded: fileIvB64) else { return }
        let expectedHash: Data? = (fileMsg["fileHash"] as? String).flatMap { Data(base64Encoded: $0) }

        viewOnceRevealed = true
        Task {
            do {
                let data = try await APIClient.shared.getRaw("/media/\(blobId)")
                let key = SymmetricKey(data: fileKeyData)
                let nonce = try AES.GCM.Nonce(data: fileIvData)
                let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: data.dropLast(16), tag: data.suffix(16))
                let plainData = try AES.GCM.open(sealedBox, using: key)
                // Verify hash integrity
                if let expected = expectedHash {
                    let computed = Data(SHA256.hash(data: plainData))
                    guard computed == expected else { throw MediaManager.MediaError.hashMismatch }
                }
                if let img = UIImage(data: plainData) {
                    viewOnceImage = img
                    showViewOnceModal = true
                }
            } catch {
                // Mark as viewed even on error to prevent retries
                UserDefaults.standard.set(true, forKey: viewOnceViewedKey)
            }
        }
    }
}

// MARK: - View Once Modal

struct ViewOnceModalView: View {
    let image: UIImage?
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let img = image {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFit()
                    .padding()
            }
            VStack {
                HStack {
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title)
                            .foregroundColor(.white.opacity(0.8))
                    }
                    .padding()
                }
                Spacer()
                Text("This media will disappear when closed")
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.6))
                    .padding(.bottom, 40)
            }
        }
        .statusBarHidden()
    }
}

// MARK: - Settings Tab

struct SettingsView: View {
    @EnvironmentObject var authVM: AuthViewModel
    @State private var discoverable = true
    @State private var readReceipts = true
    @State private var typingIndicators = true
    @State private var onlineVisibility = "everyone"
    @State private var whoCanAdd = "everyone"
    @State private var lastSeenVisibility = "everyone"
    @State private var photoVisibility = "everyone"
    @State private var screenshotDetection = true
    @State private var ghostMode = false
    @State private var username = "loading..."
    @State private var displayName = "Loading..."
    @State private var statusText = ""
    @State private var isEditingStatus = false
    @State private var editStatusText = ""
    @State private var avatarUrl: String?
    @State private var showQrScanner = false
    @State private var qrScanResult: String?
    @State private var isLinkingDevice = false
    @State private var linkMessage: String?
    @State private var quietStart = Date()
    @State private var quietEnd = Date()
    @State private var quietHoursEnabled = false
    @State private var alertKeywords: [String] = []
    @State private var newKeyword = ""

    @State private var showPhotoPicker = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isUploadingAvatar = false
    @AppStorage("app_theme") private var appTheme = "system"

    // Invite link
    @State private var inviteLink: String?
    @State private var isGeneratingLink = false

    // Chat import
    @State private var importSource = ""
    @State private var showImportPicker = false
    @State private var importStatus = ""

    // Device management
    @State private var devices: [[String: Any]] = []
    @State private var verifyCode: String?
    @State private var verifyExpiry: Int = 0
    @State private var verifyInput = ""
    @State private var showMyQRCode = false
    @State private var blockedContacts: [[String: Any]] = []
    @State private var showBlockedList = false
    @State private var isEditingName = false
    @State private var editNameText = ""
    @State private var showDeleteConfirm = false
    @State private var identityKeyFingerprint = ""
    @State private var defaultDisappearTimer = 0
    @State private var showRecoveryPhrase = false
    @State private var recoveryPhrase = ""
    @State private var showBiometricImportPrompt = false
    @State private var biometricImportB64 = ""
    @State private var biometricExportStatus = ""

    // Decoy conversations
    @State private var showDecoyManager = false
    @State private var decoyConversations: [[String: Any]] = []
    @State private var decoyNameInput = ""
    @State private var decoyMessageInput = ""

    // Custom emoji
    @State private var showEmojiManager = false
    @State private var customEmojis: [[String: String]] = []
    @State private var emojiShortcodeInput = ""
    @State private var showEmojiPhotoPicker = false
    @State private var emojiPhotoItem: PhotosPickerItem?

    // Donation
    @State private var showDonationSheet = false
    @State private var donorTier = ""
    @State private var donorSince = ""

    // Encrypted backup
    @State private var showBackupSheet = false
    @State private var showBackupFilePicker = false
    @State private var backupPassphrase = ""
    @State private var backupStatus = ""

    // Saved contacts
    @State private var showSavedContacts = false
    @State private var savedContacts: [[String: Any]] = []
    @State private var showNicknameAlert = false
    @State private var editNicknameContactId = ""
    @State private var editNicknameText = ""

    @ViewBuilder
    private var keywordAlertsView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Keyword Alerts", systemImage: "bell.badge.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.rocGold)
            Text("Get notified even during Quiet Hours when a message contains these keywords.")
                .font(.caption)
                .foregroundColor(.textSecondary)

            if !alertKeywords.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(alertKeywords, id: \.self) { kw in
                        keywordChip(kw)
                    }
                }
            }

            HStack {
                TextField("Add keyword...", text: $newKeyword)
                    .textFieldStyle(RoundedBorderTextFieldStyle())
                    .font(.caption)
                    .autocapitalization(.none)
                    .onSubmit { addKeyword() }
                Button {
                    addKeyword()
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .foregroundColor(.rocGold)
                }
                .disabled(newKeyword.trimmingCharacters(in: .whitespaces).isEmpty || alertKeywords.count >= 20)
            }

            if alertKeywords.count >= 20 {
                Text("Maximum 20 keywords")
                    .font(.caption2)
                    .foregroundColor(.danger)
            }
        }
    }

    @ViewBuilder
    private func keywordChip(_ kw: String) -> some View {
        HStack(spacing: 4) {
            Text(kw)
                .font(.caption)
                .foregroundColor(.textPrimary)
            Button {
                alertKeywords.removeAll { $0 == kw }
                saveKeywords()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption2)
                    .foregroundColor(.danger)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Color.bgCard)
        .cornerRadius(20)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.shadowBronze.opacity(0.3), lineWidth: 1))
    }

    var body: some View {
        NavigationStack {
            List {
                // ── Roc Family Hero Card ──────────────────────────────
                Section {
                    ZStack {
                        // Animated gradient background
                        LinearGradient(
                            colors: [
                                Color.rocGold.opacity(0.22),
                                Color(red: 0.08, green: 0.58, blue: 0.62).opacity(0.18), // turquoise
                                Color.black.opacity(0.08),
                            ],
                            startPoint: .topLeading, endPoint: .bottomTrailing
                        )
                        // Decorative wing silhouettes
                        HStack {
                            Image(systemName: "bird.fill")
                                .font(.system(size: 90))
                                .foregroundStyle(Color.rocGold.opacity(0.08))
                                .rotationEffect(.degrees(-18))
                                .offset(x: -14, y: -22)
                            Spacer()
                            Image(systemName: "bird.fill")
                                .font(.system(size: 70))
                                .foregroundStyle(Color.rocGold.opacity(0.07))
                                .rotationEffect(.degrees(18))
                                .scaleEffect(x: -1)
                                .offset(x: 16, y: 30)
                        }

                        VStack(spacing: 12) {
                            // Avatar with gold ring + edit badge
                            ZStack(alignment: .bottomTrailing) {
                                Circle()
                                    .stroke(
                                        AngularGradient(
                                            colors: [.rocGold, Color(red: 0.08, green: 0.58, blue: 0.62), .rocGold],
                                            center: .center
                                        ),
                                        lineWidth: 3
                                    )
                                    .frame(width: 104, height: 104)
                                AvatarView(name: displayName, avatarUrl: avatarUrl, size: 92)
                                if isUploadingAvatar {
                                    Circle()
                                        .fill(Color.black.opacity(0.35))
                                        .frame(width: 92, height: 92)
                                    ProgressView()
                                        .tint(.white)
                                }
                                Circle()
                                    .fill(Color.rocGold)
                                    .frame(width: 30, height: 30)
                                    .overlay(
                                        Image(systemName: "camera.fill")
                                            .font(.system(size: 13, weight: .bold))
                                            .foregroundColor(.white)
                                    )
                                    .shadow(color: .black.opacity(0.25), radius: 4, y: 2)
                            }
                            .onTapGesture { showPhotoPicker = true }

                            VStack(spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(displayName)
                                        .font(.title3.weight(.bold))
                                    Button(action: {
                                        editNameText = displayName
                                        isEditingName = true
                                    }) {
                                        Image(systemName: "pencil.circle.fill")
                                            .foregroundColor(.rocGold)
                                            .font(.system(size: 16))
                                    }
                                }
                                Text("@\(username)")
                                    .font(.subheadline)
                                    .foregroundColor(.adaptiveTextSec)
                                Button(action: {
                                    editStatusText = statusText
                                    isEditingStatus = true
                                }) {
                                    Text(statusText.isEmpty ? "Set a status..." : statusText)
                                        .font(.caption)
                                        .foregroundColor(statusText.isEmpty ? .adaptiveTextSec : .adaptiveText)
                                }
                            }

                            // Roc Family solidarity banner
                            HStack(spacing: 6) {
                                Text("🕊️")
                                Text("Voice of Freedom")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(.rocGold)
                                Text("🇵🇸")
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 5)
                            .background(
                                Capsule().fill(Color.rocGold.opacity(0.12))
                            )
                            .overlay(
                                Capsule().stroke(Color.rocGold.opacity(0.4), lineWidth: 1)
                            )
                        }
                        .padding(.vertical, 20)
                        .padding(.horizontal, 16)
                    }
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }

                Section("My QR Code") {
                    Button {
                        showMyQRCode.toggle()
                    } label: {
                        Label(showMyQRCode ? "Hide QR Code" : "Show My QR Code", systemImage: "qrcode")
                    }
                    if showMyQRCode {
                        if let qrImage = generateQRCode(from: "rocchat://user/\(username)") {
                            Image(uiImage: qrImage)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(width: 200, height: 200)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        }
                        Text("Others can scan this to add you")
                            .font(.caption)
                            .foregroundColor(.secondary)
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

                    // Device list
                    ForEach(devices.indices, id: \.self) { idx in
                        let d = devices[idx]
                        let name = d["device_name"] as? String ?? "Unknown"
                        let platform = d["platform"] as? String ?? ""
                        let icon = (platform == "ios" || platform == "android") ? "📱" : "💻"
                        HStack {
                            Text("\(icon) \(name) · \(platform)")
                                .font(.subheadline)
                            Spacer()
                            Button(role: .destructive) {
                                Task {
                                    if let deviceId = d["id"] as? String {
                                        _ = try? await APIClient.shared.deleteRaw("/devices/\(deviceId)")
                                        await loadDevices()
                                    }
                                }
                            } label: {
                                Image(systemName: "trash").font(.caption)
                            }
                        }
                    }

                    // Verify device
                    Button {
                        Task {
                            let data = try await APIClient.shared.postRaw("/devices/verify/initiate", body: [:])
                            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                               let code = json["code"] as? String {
                                verifyCode = code
                                // Poll for pending key transfer requests from new device
                                pollForKeyTransferRequests()
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "key.fill").foregroundColor(.rocGold)
                            VStack(alignment: .leading) {
                                Text("Generate Verification Code").fontWeight(.medium)
                                Text("6-digit code for new device").font(.caption).foregroundColor(.textSecondary)
                            }
                        }
                    }
                    if let code = verifyCode {
                        Text(code).font(.system(size: 28, design: .monospaced)).tracking(6).foregroundColor(.rocGold)
                    }
                    HStack {
                        TextField("Enter 6-digit code", text: $verifyInput)
                            .keyboardType(.numberPad)
                            .textFieldStyle(.roundedBorder)
                        Button("Verify") {
                            Task {
                                let body: [String: Any] = ["code": verifyInput]
                                let data = try await APIClient.shared.postRaw("/devices/verify/confirm", body: body)
                                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                                   json["verified"] as? Bool == true {
                                    linkMessage = "✓ Verified — requesting keys..."
                                    verifyInput = ""
                                    // Request key transfer as new device
                                    await requestKeyTransferAsNewDevice()
                                } else {
                                    linkMessage = "Invalid or expired code"
                                }
                            }
                        }
                        .disabled(verifyInput.count != 6)
                    }
                }

                Section("Invite Link") {
                    Button {
                        isGeneratingLink = true
                        Task {
                            let data = try await APIClient.shared.getRaw("/contacts/invite-link")
                            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                               let link = json["link"] as? String {
                                inviteLink = link
                            }
                            isGeneratingLink = false
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "link.badge.plus").foregroundColor(.rocGold)
                            Text(isGeneratingLink ? "Generating..." : (inviteLink != nil ? "Regenerate" : "Generate Invite Link"))
                        }
                    }
                    .disabled(isGeneratingLink)
                    if let link = inviteLink {
                        HStack {
                            Text(link)
                                .font(.caption.monospaced())
                                .foregroundColor(.turquoise)
                                .lineLimit(1)
                            Spacer()
                            Button {
                                UIPasteboard.general.string = link
                            } label: {
                                Image(systemName: "doc.on.doc").font(.caption)
                            }
                            Button {
                                let av = UIActivityViewController(activityItems: [link], applicationActivities: nil)
                                UIApplication.shared.connectedScenes
                                    .compactMap { $0 as? UIWindowScene }
                                    .flatMap { $0.windows }
                                    .first?.rootViewController?.present(av, animated: true)
                            } label: {
                                Image(systemName: "square.and.arrow.up").font(.caption)
                            }
                        }
                    }
                }

                Section("Import Chat History") {
                    Text("Upload an exported chat file. Messages are re-encrypted with your RocChat keys.")
                        .font(.caption).foregroundColor(.textSecondary)
                    Button("📱 WhatsApp (.txt)") {
                        importSource = "whatsapp"
                        showImportPicker = true
                    }
                    Button("✈️ Telegram (.json)") {
                        importSource = "telegram"
                        showImportPicker = true
                    }
                    Button("🔒 Signal (.json)") {
                        importSource = "signal"
                        showImportPicker = true
                    }
                    if !importStatus.isEmpty {
                        Text(importStatus).font(.caption).foregroundColor(.turquoise)
                    }
                }

                Section("Privacy") {
                    Toggle(isOn: $ghostMode) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("👻 Ghost Mode").fontWeight(.bold)
                            Text("No receipts, no typing, no online status, 24h auto-delete")
                                .font(.caption)
                                .foregroundColor(.textSecondary)
                        }
                    }
                    .onChange(of: ghostMode) { _, val in
                        Task {
                            if val {
                                let body: [String: Any] = ["show_read_receipts": 0, "show_typing_indicator": 0, "show_online_to": "nobody", "default_disappear_timer": 86400]
                                _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                                readReceipts = false; typingIndicators = false; onlineVisibility = "nobody"
                            } else {
                                let body: [String: Any] = ["show_read_receipts": 1, "show_typing_indicator": 1, "show_online_to": "everyone", "default_disappear_timer": 0]
                                _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                                readReceipts = true; typingIndicators = true; onlineVisibility = "everyone"
                            }
                        }
                    }
                    Toggle("Discoverable by username", isOn: $discoverable)
                        .onChange(of: discoverable) { _, val in
                            Task {
                                let body: [String: Any] = ["discoverable": val ? 1 : 0]
                                _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                            }
                        }
                    Toggle("Read receipts", isOn: $readReceipts)
                        .onChange(of: readReceipts) { _, val in
                            Task {
                                let body: [String: Any] = ["show_read_receipts": val ? 1 : 0]
                                _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                            }
                        }
                    Toggle("Typing indicators", isOn: $typingIndicators)
                        .onChange(of: typingIndicators) { _, val in
                            Task {
                                let body: [String: Any] = ["show_typing_indicator": val ? 1 : 0]
                                _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                            }
                        }
                    Picker("Online status visible to", selection: $onlineVisibility) {
                        Text("Everyone").tag("everyone")
                        Text("Contacts only").tag("contacts")
                        Text("Nobody").tag("nobody")
                    }
                    .onChange(of: onlineVisibility) { _, val in
                        Task {
                            let body: [String: Any] = ["show_online_to": val]
                            _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                        }
                    }
                    Picker("Who can add me", selection: $whoCanAdd) {
                        Text("Everyone").tag("everyone")
                        Text("Nobody").tag("nobody")
                    }
                    .onChange(of: whoCanAdd) { _, val in
                        Task {
                            let body: [String: Any] = ["who_can_add": val]
                            _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                        }
                    }
                    Picker("Last seen visible to", selection: $lastSeenVisibility) {
                        Text("Everyone").tag("everyone")
                        Text("Contacts only").tag("contacts")
                        Text("Nobody").tag("nobody")
                    }
                    .onChange(of: lastSeenVisibility) { _, val in
                        Task {
                            let body: [String: Any] = ["show_last_seen_to": val]
                            _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                        }
                    }
                    Picker("Profile photo visible to", selection: $photoVisibility) {
                        Text("Everyone").tag("everyone")
                        Text("Contacts only").tag("contacts")
                        Text("Nobody").tag("nobody")
                    }
                    .onChange(of: photoVisibility) { _, val in
                        Task {
                            let body: [String: Any] = ["show_photo_to": val]
                            _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                        }
                    }
                    Picker("Link previews", selection: Binding(
                        get: { UserDefaults.standard.string(forKey: "link_preview_mode") ?? "server" },
                        set: { UserDefaults.standard.set($0, forKey: "link_preview_mode") }
                    )) {
                        Text("Server (default)").tag("server")
                        Text("Client-side (private)").tag("client")
                        Text("Disabled").tag("disabled")
                    }
                    Toggle("Screenshot detection", isOn: $screenshotDetection)
                        .onChange(of: screenshotDetection) { _, val in
                            Task {
                                let body: [String: Any] = ["screenshot_detection": val ? 1 : 0]
                                _ = try? await APIClient.shared.postRaw("/me/settings", body: body, method: "PATCH")
                            }
                        }
                }
                .tint(.rocGold)

                Section("Blocked Contacts") {
                    Button {
                        Task { await loadBlockedContacts() }
                        showBlockedList = true
                    } label: {
                        Label("View Blocked Users", systemImage: "hand.raised.fill")
                    }
                }

                Section("Default Disappearing Timer") {
                    Picker("New chats auto-delete", selection: $defaultDisappearTimer) {
                        Text("Off").tag(0)
                        Text("5 minutes").tag(300)
                        Text("1 hour").tag(3600)
                        Text("24 hours").tag(86400)
                        Text("7 days").tag(604800)
                        Text("30 days").tag(2592000)
                    }
                    .onChange(of: defaultDisappearTimer) { _, val in
                        UserDefaults.standard.set(val, forKey: "default_disappear_timer")
                        Task {
                            _ = try? await APIClient.shared.postRaw("/me/settings", body: ["default_disappear_timer": val], method: "PATCH")
                        }
                    }
                }
                .tint(.rocGold)

                Section("Appearance") {
                    Picker("Theme", selection: $appTheme) {
                        Text("System").tag("system")
                        Text("Dark").tag("dark")
                        Text("Light").tag("light")
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: appTheme) { _, newValue in
                        let style: UIUserInterfaceStyle = switch newValue {
                        case "dark": .dark
                        case "light": .light
                        default: .unspecified
                        }
                        UIApplication.shared.connectedScenes
                            .compactMap { $0 as? UIWindowScene }
                            .flatMap { $0.windows }
                            .forEach { $0.overrideUserInterfaceStyle = style }
                    }
                }

                Section("Quiet Hours") {
                    Toggle("Enable Quiet Hours", isOn: $quietHoursEnabled)
                        .onChange(of: quietHoursEnabled) { _, val in
                            Task {
                                if val {
                                    let formatter = DateFormatter()
                                    formatter.dateFormat = "HH:mm"
                                    let body: [String: Any] = [
                                        "quiet_start": formatter.string(from: quietStart),
                                        "quiet_end": formatter.string(from: quietEnd),
                                    ]
                                    _ = try? await APIClient.shared.postRaw("/features/quiet-hours", body: body, method: "PUT")
                                } else {
                                    _ = try? await APIClient.shared.deleteRaw("/features/quiet-hours")
                                }
                            }
                        }
                    if quietHoursEnabled {
                        DatePicker("From", selection: $quietStart, displayedComponents: .hourAndMinute)
                            .tint(.rocGold)
                            .onChange(of: quietStart) { _, _ in saveQuietHours() }
                        DatePicker("To", selection: $quietEnd, displayedComponents: .hourAndMinute)
                            .tint(.rocGold)
                            .onChange(of: quietEnd) { _, _ in saveQuietHours() }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("During quiet hours, notifications are silenced.")
                            .font(.caption)
                            .foregroundColor(.textSecondary)
                        Text("DND exceptions can bypass this on the web settings.")
                            .font(.caption)
                            .foregroundColor(.textSecondary)
                    }

                    // Keyword Alerts
                    keywordAlertsView
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
                                .font(.custom("JetBrains Mono", size: 10, relativeTo: .caption))
                                .foregroundColor(.textSecondary)
                        }
                    }
                    if !identityKeyFingerprint.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Your Identity Key")
                                .font(.caption.bold())
                            Text(identityKeyFingerprint)
                                .font(.custom("JetBrains Mono", size: 10, relativeTo: .caption))
                                .foregroundColor(.textSecondary)
                                .textSelection(.enabled)
                        }
                        Button {
                            biometricExportIdentityKey()
                        } label: {
                            Label("Export Identity Key (Biometric)", systemImage: "faceid")
                        }
                        Button {
                            showBiometricImportPrompt = true
                        } label: {
                            Label("Import Identity Key (Biometric)", systemImage: "arrow.down.doc.fill")
                        }
                    }
                    Button {
                        showRecoveryPhrase = true
                        if recoveryPhrase.isEmpty {
                            generateRecoveryPhrase()
                        }
                    } label: {
                        Label("Recovery Phrase", systemImage: "key.fill")
                    }
                }

                Section("Premium Features") {
                    HStack(spacing: 12) {
                        Image(systemName: "crown.fill")
                            .foregroundColor(.rocGold)
                            .font(.title2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("RocChat Premium")
                                .font(.subheadline.bold())
                                .foregroundColor(.rocGold)
                            Text("Chat themes, scheduled messages, chat folders & more")
                                .font(.caption)
                                .foregroundColor(.textSecondary)
                        }
                    }
                    .padding(.vertical, 4)

                    HStack(spacing: 8) {
                        Image(systemName: "paintpalette.fill").foregroundColor(.adaptiveTextSec).frame(width: 20)
                        Text("Chat Themes").foregroundColor(.adaptiveText)
                        Spacer()
                        Text("Free").font(.caption).foregroundColor(.success)
                    }
                    HStack(spacing: 8) {
                        Image(systemName: "clock.fill").foregroundColor(.adaptiveTextSec).frame(width: 20)
                        Text("Scheduled Messages").foregroundColor(.adaptiveText)
                        Spacer()
                        Text("Free").font(.caption).foregroundColor(.success)
                    }
                    HStack(spacing: 8) {
                        Image(systemName: "folder.fill").foregroundColor(.adaptiveTextSec).frame(width: 20)
                        Text("Chat Folders").foregroundColor(.adaptiveText)
                        Spacer()
                        Text("Free").font(.caption).foregroundColor(.success)
                    }
                }

                Section("Power-User Features") {
                    Button {
                        loadDecoys()
                        showDecoyManager = true
                    } label: {
                        Label("Decoy Conversations", systemImage: "theatermask.and.paintbrush.fill")
                    }
                    Button {
                        loadCustomEmojis()
                        showEmojiManager = true
                    } label: {
                        Label("Custom Emoji", systemImage: "face.smiling.inverse")
                    }
                    Button {
                        showBackupSheet = true
                    } label: {
                        Label("Encrypted Backup", systemImage: "externaldrive.badge.checkmark")
                    }
                }

                Section("Saved Contacts") {
                    Button {
                        Task { await loadSavedContacts() }
                        showSavedContacts = true
                    } label: {
                        Label("Manage Saved Contacts", systemImage: "person.crop.rectangle.stack.fill")
                    }
                }

                Section("Support RocChat") {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Text("💛")
                            Text("All features are free forever")
                                .font(.subheadline.bold())
                                .foregroundColor(.rocGold)
                        }
                        Text("RocChat is built with love. If you enjoy the app, consider supporting development with a donation.")
                            .font(.caption)
                            .foregroundColor(.textSecondary)
                    }
                    .padding(.vertical, 4)

                    Button {
                        Task { await loadDonorStatus() }
                        showDonationSheet = true
                    } label: {
                        Label("Donate", systemImage: "heart.fill")
                    }
                    if !donorTier.isEmpty {
                        HStack {
                            Text("Current Badge:")
                            Text(donorBadgeEmoji(donorTier)).font(.title2)
                            Text(donorTier.capitalized).foregroundColor(.rocGold).font(.caption)
                        }
                    }
                }


                Section("About") {
                    NavigationLink {
                        CanaryView()
                    } label: {
                        Label("Roc Bird Status", systemImage: "bird")
                    }
                    NavigationLink {
                        TransparencyView()
                    } label: {
                        Label("Transparency Reports", systemImage: "doc.text.magnifyingglass")
                    }
                    NavigationLink {
                        SupportersView()
                    } label: {
                        Label("Supporters", systemImage: "heart.circle")
                    }
                    HStack {
                        Text("Version"); Spacer()
                        Text("0.1.0").foregroundColor(.textSecondary)
                    }
                    HStack(spacing: 4) {
                        Text("Free & open for everyone")
                    }
                    .font(.subheadline).foregroundColor(.textSecondary)
                    HStack(spacing: 4) {
                        Text("Part of the")
                        Text("Roc Family").fontWeight(.semibold).foregroundColor(.rocGold)
                    }
                    .font(.subheadline).foregroundColor(.textSecondary)
                }

                Section("🪶 Roc Family Manifesto") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("We are the voice of freedom.\nWe are the voice of the people.")
                            .font(.subheadline.bold())
                            .foregroundColor(.rocGold)
                        Text("Zero third-party dependencies. No Google, no Apple services, no corporate APIs. Every component is self-hosted or open-source.")
                            .font(.caption)
                            .foregroundColor(.textSecondary)
                        Text("We do not support or depend on entities that participate in the oppression of people anywhere in the world.")
                            .font(.caption)
                            .foregroundColor(.textSecondary)
                        Text("Privacy is a human right. End-to-end encryption by default. We cannot read your messages.")
                            .font(.caption)
                            .foregroundColor(.textSecondary)
                        Text("Built with love, for the people. 🇵🇸")
                            .font(.caption.italic())
                            .foregroundColor(.rocGold)
                    }
                    .padding(.vertical, 4)
                }

                Section {
                    Button("Export My Data") {
                        Task {
                            do {
                                let data = try await APIClient.shared.getRaw("/me/export")
                                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                                if let exportObj = json?["export"] {
                                    let exportData = try JSONSerialization.data(withJSONObject: exportObj, options: .prettyPrinted)
                                    let tmpUrl = FileManager.default.temporaryDirectory.appendingPathComponent("rocchat-export-\(Int(Date().timeIntervalSince1970)).json")
                                    try exportData.write(to: tmpUrl)
                                    await MainActor.run {
                                        let ac = UIActivityViewController(activityItems: [tmpUrl], applicationActivities: nil)
                                        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                                           let root = scene.windows.first?.rootViewController {
                                            root.present(ac, animated: true)
                                        }
                                    }
                                }
                            } catch { print("Export failed: \(error)") }
                        }
                    }
                    .foregroundColor(.rocGold)
                    Button("Delete Account", role: .destructive) {
                        showDeleteConfirm = true
                    }
                    Button("Sign Out") { authVM.logout() }
                        .foregroundColor(.danger)
                }
            }
            .navigationTitle("Profile")
        }
        .sheet(isPresented: $showQrScanner) {
            QrScannerView { code in
                showQrScanner = false
                handleQrCode(code)
            }
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhoto, matching: .images)
        .onChange(of: selectedPhoto) { _, newItem in
            guard let newItem else { return }
            Task { await uploadAvatar(item: newItem) }
        }
        .fileImporter(isPresented: $showImportPicker, allowedContentTypes: [.plainText, .json], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first {
                guard url.startAccessingSecurityScopedResource() else { return }
                defer { url.stopAccessingSecurityScopedResource() }
                guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
                Task { await processImport(source: importSource, text: text) }
            }
        }
        .alert("Import Identity Key", isPresented: $showBiometricImportPrompt) {
            TextField("Paste base64 key bundle", text: $biometricImportB64)
            Button("Import") { biometricImportIdentityKey(b64: biometricImportB64) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Paste the exported identity key bundle, then authenticate with biometrics.")
        }
        .alert("Identity Key", isPresented: .constant(!biometricExportStatus.isEmpty)) {
            Button("OK") { biometricExportStatus = "" }
        } message: {
            Text(biometricExportStatus)
        }
        .alert("Edit Display Name", isPresented: $isEditingName) {
            TextField("Display name", text: $editNameText)
            Button("Save") {
                let newName = editNameText.trimmingCharacters(in: .whitespaces)
                guard !newName.isEmpty else { return }
                displayName = newName
                Task {
                    let encrypted = encryptProfileField(newName)
                    _ = try? await APIClient.shared.postRaw("/me/settings", body: ["display_name": encrypted], method: "PATCH")
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Set Status", isPresented: $isEditingStatus) {
            TextField("What's on your mind?", text: $editStatusText)
            Button("Save") {
                let text = String(editStatusText.trimmingCharacters(in: .whitespaces).prefix(140))
                statusText = text
                Task {
                    let encrypted = encryptProfileField(text)
                    _ = try? await APIClient.shared.postRaw("/me/settings", body: ["status_text": encrypted], method: "PATCH")
                }
            }
            Button("Clear") {
                statusText = ""
                Task {
                    _ = try? await APIClient.shared.postRaw("/me/settings", body: ["status_text": ""], method: "PATCH")
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Delete Account", isPresented: $showDeleteConfirm) {
            Button("Delete", role: .destructive) {
                Task {
                    _ = try? await APIClient.shared.deleteRaw("/me")
                    await MainActor.run { authVM.logout() }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete your account, all messages, and keys. This cannot be undone.")
        }
        .sheet(isPresented: $showBlockedList) {
            NavigationStack {
                List {
                    if blockedContacts.isEmpty {
                        Text("No blocked contacts").foregroundColor(.secondary)
                    }
                    ForEach(Array(blockedContacts.enumerated()), id: \.offset) { _, contact in
                        let name = contact["display_name"] as? String ?? contact["username"] as? String ?? "Unknown"
                        let blockedId = contact["user_id"] as? String ?? contact["id"] as? String ?? ""
                        HStack {
                            Text(name)
                            Spacer()
                            Button("Unblock") {
                                Task {
                                    _ = try? await APIClient.shared.postRaw("/contacts/block", body: ["userId": blockedId, "blocked": false])
                                    await loadBlockedContacts()
                                }
                            }
                            .foregroundColor(.rocGold)
                            .font(.subheadline)
                        }
                    }
                }
                .navigationTitle("Blocked Contacts")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showBlockedList = false }
                    }
                }
            }
        }
        .sheet(isPresented: $showRecoveryPhrase) {
            NavigationStack {
                VStack(spacing: 20) {
                    Image(systemName: "key.fill")
                        .font(.system(size: 48))
                        .foregroundColor(.rocGold)
                    Text("Recovery Phrase")
                        .font(.title2.bold())
                    Text("Write these words down and store them safely. They are the only way to recover your encryption keys.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                    if !recoveryPhrase.isEmpty {
                        let words = recoveryPhrase.components(separatedBy: " ")
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                            ForEach(Array(words.enumerated()), id: \.offset) { idx, word in
                                HStack(spacing: 4) {
                                    Text("\(idx + 1).").font(.caption).foregroundColor(.secondary)
                                    Text(word).font(.system(.body, design: .monospaced))
                                }
                                .padding(.vertical, 4)
                                .padding(.horizontal, 8)
                                .background(Color.rocGold.opacity(0.08))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }
                        .padding()
                    }
                }
                .padding()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showRecoveryPhrase = false }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        // MARK: Decoy Conversations Sheet
        .sheet(isPresented: $showDecoyManager) {
            NavigationStack {
                List {
                    Section("Add Decoy") {
                        TextField("Contact name", text: $decoyNameInput)
                        TextField("Messages (sender|text per line)", text: $decoyMessageInput, axis: .vertical)
                            .lineLimit(3...6)
                        Button("Add Decoy") { addDecoy() }
                            .disabled(decoyNameInput.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    Section("Decoys") {
                        if decoyConversations.isEmpty {
                            Text("No decoy conversations").foregroundColor(.secondary)
                        }
                        ForEach(Array(decoyConversations.enumerated()), id: \.offset) { idx, decoy in
                            let name = decoy["name"] as? String ?? "Unnamed"
                            let msgs = decoy["messages"] as? [[String: String]] ?? []
                            VStack(alignment: .leading) {
                                Text(name).font(.subheadline.bold())
                                Text("\(msgs.count) messages").font(.caption).foregroundColor(.secondary)
                            }
                            .swipeActions(edge: .trailing) {
                                Button("Delete", role: .destructive) { removeDecoy(at: idx) }
                            }
                        }
                    }
                    Section(footer: Text("Decoy conversations appear in your chat list but contain only fake messages. They are stored locally and never sent over the network.")) { EmptyView() }
                }
                .navigationTitle("Decoy Conversations")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showDecoyManager = false }
                    }
                }
            }
        }
        // MARK: Custom Emoji Sheet
        .sheet(isPresented: $showEmojiManager) {
            NavigationStack {
                List {
                    Section("Add Emoji") {
                        TextField("Shortcode (e.g. thumbsup)", text: $emojiShortcodeInput)
                            .autocapitalization(.none)
                        PhotosPicker(selection: $emojiPhotoItem, matching: .images) {
                            Label("Pick Image", systemImage: "photo")
                        }
                        Text("Max 64 emoji, 1MB each").font(.caption).foregroundColor(.secondary)
                    }
                    Section("Your Emoji (\(customEmojis.count)/64)") {
                        if customEmojis.isEmpty {
                            Text("No custom emoji yet").foregroundColor(.secondary)
                        }
                        ForEach(Array(customEmojis.enumerated()), id: \.offset) { idx, emoji in
                            HStack {
                                if let dataUrl = emoji["data_url"],
                                   let base64 = dataUrl.components(separatedBy: "base64,").last,
                                   let imgData = Data(base64Encoded: base64),
                                   let uiImg = UIImage(data: imgData) {
                                    Image(uiImage: uiImg).resizable().frame(width: 28, height: 28)
                                }
                                Text(":\(emoji["shortcode"] ?? ""):")
                                    .font(.system(.body, design: .monospaced))
                                Spacer()
                            }
                            .swipeActions(edge: .trailing) {
                                Button("Delete", role: .destructive) {
                                    customEmojis.remove(at: idx)
                                    saveCustomEmojis()
                                }
                            }
                        }
                    }
                }
                .navigationTitle("Custom Emoji")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showEmojiManager = false }
                    }
                }
                .onChange(of: emojiPhotoItem) { _, newItem in
                    guard let newItem else { return }
                    Task {
                        if let data = try? await newItem.loadTransferable(type: Data.self) {
                            addCustomEmoji(imageData: data)
                        }
                        emojiPhotoItem = nil
                    }
                }
            }
        }
        // MARK: Donation Sheet
        .sheet(isPresented: $showDonationSheet) {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 16) {
                        Image(systemName: "heart.fill")
                            .font(.system(size: 48))
                            .foregroundColor(.rocGold)
                        Text("Support RocChat")
                            .font(.title2.bold())
                        Text("All features are free forever. Donations support development and server costs.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)

                        if !donorTier.isEmpty {
                            HStack {
                                Text(donorBadgeEmoji(donorTier)).font(.largeTitle)
                                VStack(alignment: .leading) {
                                    Text(donorTier.capitalized + " Supporter").font(.headline).foregroundColor(.rocGold)
                                    if !donorSince.isEmpty {
                                        Text("Since \(donorSince.prefix(10))").font(.caption).foregroundColor(.secondary)
                                    }
                                }
                            }
                            .padding()
                            .background(RoundedRectangle(cornerRadius: 12).fill(Color.rocGold.opacity(0.1)))
                        }

                        let tiers: [(String, String, Int)] = [
                            ("coffee", "☕ Coffee", 3),
                            ("feather", "🪶 Feather", 5),
                            ("wing", "🦅 Wing", 10),
                            ("mountain", "🏔️ Mountain", 25),
                            ("patron", "👑 Patron", 50),
                        ]
                        ForEach(tiers, id: \.0) { tier, label, amount in
                            Button {
                                Task { await submitDonation(tier: tier, amount: amount) }
                            } label: {
                                HStack {
                                    Text(label).font(.headline)
                                    Spacer()
                                    Text("$\(amount)").font(.headline).foregroundColor(.rocGold)
                                }
                                .padding()
                                .background(RoundedRectangle(cornerRadius: 12).stroke(Color.rocGold, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }

                        if !donorTier.isEmpty {
                            Button("Remove Badge", role: .destructive) {
                                Task {
                                    _ = try? await APIClient.shared.deleteRaw("/features/donor")
                                    donorTier = ""
                                }
                            }
                            .font(.caption)
                        }
                    }
                    .padding()
                }
                .navigationTitle("Donate")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showDonationSheet = false }
                    }
                }
            }
        }
        // MARK: Encrypted Backup Sheet
        .sheet(isPresented: $showBackupSheet) {
            NavigationStack {
                VStack(spacing: 20) {
                    Image(systemName: "externaldrive.badge.checkmark")
                        .font(.system(size: 48))
                        .foregroundColor(.rocGold)
                    Text("Encrypted Backup")
                        .font(.title2.bold())
                    Text("Export or import an encrypted backup of your keys, sessions, and settings.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)

                    SecureField("Passphrase (12+ characters)", text: $backupPassphrase)
                        .textFieldStyle(.roundedBorder)
                        .padding(.horizontal)

                    HStack(spacing: 16) {
                        Button {
                            Task { await exportBackup() }
                        } label: {
                            Label("Export", systemImage: "arrow.up.doc.fill")
                                .frame(maxWidth: .infinity)
                                .padding()
                                .background(RoundedRectangle(cornerRadius: 12).fill(Color.rocGold))
                                .foregroundColor(.white)
                        }
                        Button {
                            showBackupFilePicker = true
                        } label: {
                            Label("Import", systemImage: "arrow.down.doc.fill")
                                .frame(maxWidth: .infinity)
                                .padding()
                                .background(RoundedRectangle(cornerRadius: 12).stroke(Color.rocGold, lineWidth: 1))
                        }
                    }
                    .padding(.horizontal)
                    .fileImporter(isPresented: $showBackupFilePicker, allowedContentTypes: [.data]) { result in
                        switch result {
                        case .success(let url):
                            Task { await importBackup(from: url) }
                        case .failure:
                            backupStatus = "Failed to select file"
                        }
                    }

                    if !backupStatus.isEmpty {
                        Text(backupStatus)
                            .font(.caption)
                            .foregroundColor(backupStatus.starts(with: "✅") ? .green : .secondary)
                            .multilineTextAlignment(.center)
                    }

                    Spacer()
                }
                .padding()
                .navigationTitle("Backup")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showBackupSheet = false }
                    }
                }
            }
        }
        // MARK: Saved Contacts Sheet
        .sheet(isPresented: $showSavedContacts) {
            NavigationStack {
                List {
                    if savedContacts.isEmpty {
                        Text("No saved contacts").foregroundColor(.secondary)
                    }
                    ForEach(Array(savedContacts.enumerated()), id: \.offset) { _, contact in
                        let name = contact["display_name"] as? String ?? contact["username"] as? String ?? "Unknown"
                        let nickname = contact["nickname"] as? String ?? ""
                        let cid = contact["contact_id"] as? String ?? contact["id"] as? String ?? ""
                        HStack {
                            VStack(alignment: .leading) {
                                Text(name).font(.subheadline)
                                if !nickname.isEmpty {
                                    Text(nickname).font(.caption).foregroundColor(.rocGold)
                                }
                            }
                            Spacer()
                            Button("Nickname") {
                                editNicknameContactId = cid
                                editNicknameText = nickname
                                showNicknameAlert = true
                            }
                            .font(.caption)
                            Button("Remove") {
                                Task { await removeSavedContact(id: cid) }
                            }
                            .foregroundColor(.danger)
                            .font(.caption)
                        }
                    }
                }
                .navigationTitle("Saved Contacts")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showSavedContacts = false }
                    }
                }
            }
        }
        .alert("Set Nickname", isPresented: $showNicknameAlert) {
            TextField("Nickname", text: $editNicknameText)
            Button("Save") {
                Task { await saveContactNickname(id: editNicknameContactId, nickname: editNicknameText) }
            }
            Button("Clear", role: .destructive) {
                Task { await saveContactNickname(id: editNicknameContactId, nickname: "") }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Enter a nickname for this contact")
        }
        .task {
            do {
                let me = try await APIClient.shared.getMe()
                username = me["username"] as? String ?? "unknown"
                let rawName = me["display_name"] as? String ?? username
                displayName = decryptProfileField(rawName)
                let rawStatus = me["status_text"] as? String ?? ""
                statusText = decryptProfileField(rawStatus)
                avatarUrl = me["avatar_url"] as? String
                if let disc = me["discoverable"] as? Bool { discoverable = disc }
                if let disc = me["discoverable"] as? Int { discoverable = disc != 0 }
                if let rr = me["show_read_receipts"] as? Int { readReceipts = rr != 0 }
                if let ti = me["show_typing_indicator"] as? Int { typingIndicators = ti != 0 }
                if let ov = me["show_online_to"] as? String { onlineVisibility = ov }
                if let wa = me["who_can_add"] as? String { whoCanAdd = wa }
                if let ls = me["show_last_seen_to"] as? String { lastSeenVisibility = ls }
                if let pp = me["show_photo_to"] as? String { photoVisibility = pp }
                if let sd = me["screenshot_detection"] as? Int { screenshotDetection = sd != 0 }
                if let sd = me["screenshot_detection"] as? Bool { screenshotDetection = sd }
                // Detect ghost mode
                ghostMode = !readReceipts && !typingIndicators && onlineVisibility == "nobody"
                // Load default disappear timer
                if let ddt = me["default_disappear_timer"] as? Int { defaultDisappearTimer = ddt }
                // Generate identity key fingerprint from local key
                if let keyData = secureData(forKey: "identity_key_public") {
                    identityKeyFingerprint = keyData.map { String(format: "%02x", $0) }.joined(separator: " ").uppercased()
                }
            } catch {}
            // Load quiet hours
            do {
                let qhData = try await APIClient.shared.getRaw("/features/quiet-hours")
                if let qh = try JSONSerialization.jsonObject(with: qhData) as? [String: Any] {
                    let formatter = DateFormatter()
                    formatter.dateFormat = "HH:mm"
                    if let qs = qh["quiet_start"] as? String, let qe = qh["quiet_end"] as? String,
                       let startDate = formatter.date(from: qs), let endDate = formatter.date(from: qe) {
                        quietStart = startDate
                        quietEnd = endDate
                        quietHoursEnabled = true
                    }
                    if let kws = qh["alert_keywords"] as? [String] {
                        alertKeywords = kws
                    }
                }
            } catch {}
            // Load devices
            await loadDevices()
        }
    }

    private func loadDevices() async {
        do {
            let data = try await APIClient.shared.getRaw("/devices")
            if let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                devices = arr
            }
        } catch {}
    }

    private func loadBlockedContacts() async {
        do {
            let data = try await APIClient.shared.getRaw("/contacts")
            if let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                blockedContacts = arr.filter { ($0["blocked"] as? Int ?? 0) == 1 || ($0["blocked"] as? Bool ?? false) }
            }
        } catch {}
    }

    private func secureData(forKey key: String) -> Data? {
        SecureStorage.shared.getData(forKey: key) ?? UserDefaults.standard.data(forKey: key)
    }

    private func secureString(forKey key: String) -> String? {
        SecureStorage.shared.get(forKey: key) ?? UserDefaults.standard.string(forKey: key)
    }

    private func storeSecureData(_ data: Data, forKey key: String) {
        SecureStorage.shared.setData(data, forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
    }

    // MARK: - Biometric Identity Key Export / Import

    private func biometricExportIdentityKey() {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            biometricExportStatus = "Biometrics not available"
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                                localizedReason: "Authenticate to export your identity key") { success, _ in
            DispatchQueue.main.async {
                guard success else { self.biometricExportStatus = "Authentication failed"; return }
                guard let privKey = self.secureData(forKey: "identity_key_private"),
                      let pubKey = self.secureData(forKey: "identity_key_public") else {
                    self.biometricExportStatus = "Identity key not found"
                    return
                }
                let dhPriv = self.secureData(forKey: "rocchat_identity_dh_priv")
                let dhPub = self.secureData(forKey: "rocchat_identity_dh_pub")
                // Pack both keys as JSON, base64-encode for sharing
                let bundle: [String: String] = [
                    "identity_key_private": privKey.base64EncodedString(),
                    "identity_key_public": pubKey.base64EncodedString(),
                    "rocchat_identity_dh_priv": dhPriv?.base64EncodedString() ?? "",
                    "rocchat_identity_dh_pub": dhPub?.base64EncodedString() ?? "",
                ]
                if let json = try? JSONSerialization.data(withJSONObject: bundle) {
                    let b64 = json.base64EncodedString()
                    let av = UIActivityViewController(activityItems: [b64], applicationActivities: nil)
                    if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                       let root = scene.windows.first?.rootViewController {
                        root.present(av, animated: true)
                    }
                    self.biometricExportStatus = "Key exported"
                }
            }
        }
    }

    private func biometricImportIdentityKey(b64: String) {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            biometricExportStatus = "Biometrics not available"
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                                localizedReason: "Authenticate to import your identity key") { success, _ in
            DispatchQueue.main.async {
                guard success else { self.biometricExportStatus = "Authentication failed"; return }
                guard let jsonData = Data(base64Encoded: b64),
                      let bundle = try? JSONSerialization.jsonObject(with: jsonData) as? [String: String] else {
                    self.biometricExportStatus = "Invalid key bundle"
                    return
                }
                if let privB64 = bundle["identity_key_private"], let priv = Data(base64Encoded: privB64) {
                    self.storeSecureData(priv, forKey: "identity_key_private")
                }
                if let pubB64 = bundle["identity_key_public"], let pub = Data(base64Encoded: pubB64) {
                    self.storeSecureData(pub, forKey: "identity_key_public")
                    self.identityKeyFingerprint = pub.map { String(format: "%02x", $0) }.joined(separator: " ").uppercased()
                }
                if let dhPrivB64 = bundle["rocchat_identity_dh_priv"],
                   !dhPrivB64.isEmpty,
                   let dhPriv = Data(base64Encoded: dhPrivB64) {
                    self.storeSecureData(dhPriv, forKey: "rocchat_identity_dh_priv")
                }
                if let dhPubB64 = bundle["rocchat_identity_dh_pub"],
                   !dhPubB64.isEmpty,
                   let dhPub = Data(base64Encoded: dhPubB64) {
                    self.storeSecureData(dhPub, forKey: "rocchat_identity_dh_pub")
                }
                self.biometricExportStatus = "Key imported successfully"
            }
        }
    }

    private func storeSecureString(_ value: String, forKey key: String) {
        SecureStorage.shared.set(value, forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
    }

    private func generateRecoveryPhrase() {
        let result = BIP39.generate()
        recoveryPhrase = result.mnemonic

        // Derive recovery key and encrypt the identity private keys for server-side backup
        let recoveryKey = BIP39.deriveRecoveryKey(entropy: result.entropy)
        if let identityPriv = secureData(forKey: "rocchat_identity_dh_priv") {
            let keyBundle: [String: String] = [
                "identityDHPrivate": identityPriv.base64EncodedString(),
                "identityPrivate": (secureData(forKey: "identity_key_private") ?? Data()).base64EncodedString()
            ]
            if let bundleData = try? JSONSerialization.data(withJSONObject: keyBundle),
               let encrypted = try? BIP39.encryptForRecovery(keyBundle: bundleData, recoveryKey: recoveryKey) {
                // Upload recovery vault blob to server
                Task {
                    try? await APIClient.shared.postRaw("/recovery/vault", body: [
                        "blob": encrypted.base64EncodedString()
                    ])
                }
            }
        }

        // Store mnemonic in Keychain (not UserDefaults)
        storeSecureString(recoveryPhrase, forKey: "recovery_phrase")
    }

    // MARK: - Key Transfer (Source Device)

    private func pollForKeyTransferRequests() {
        Task {
            for _ in 0..<30 { // Poll for 60 seconds
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard verifyCode != nil else { return }
                let data = try await APIClient.shared.getRaw("/devices/key-transfer/pending")
                guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let requests = json["requests"] as? [[String: Any]],
                      let first = requests.first,
                      let requestId = first["requestId"] as? String,
                      let remoteEphPub = first["ephemeralPub"] as? String else { continue }

                // Generate our ephemeral X25519 key pair
                let myEphemeral = Curve25519.KeyAgreement.PrivateKey()
                let myEphPub = myEphemeral.publicKey.rawRepresentation.base64EncodedString()

                // Import remote ephemeral public key and do ECDH
                guard let remotePubData = Data(base64Encoded: remoteEphPub) else { continue }
                let remotePubKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: remotePubData)
                let sharedSecret = try myEphemeral.sharedSecretFromKeyAgreement(with: remotePubKey)

                // Derive AES key via HKDF
                let symmetricKey = sharedSecret.hkdfDerivedSymmetricKey(
                    using: SHA256.self,
                    salt: Data(),
                    sharedInfo: Data("rocchat-key-transfer".utf8),
                    outputByteCount: 32
                )

                // Gather local keys
                let keyBundle: [String: String] = [
                    "identityDHPrivate": (secureData(forKey: "rocchat_identity_dh_priv") ?? Data()).base64EncodedString(),
                    "identityDHPublic": (secureData(forKey: "rocchat_identity_dh_pub") ?? Data()).base64EncodedString(),
                    "identityPrivate": (secureData(forKey: "identity_key_private") ?? Data()).base64EncodedString(),
                    "identityPublic": (secureData(forKey: "identity_key_public") ?? Data()).base64EncodedString()
                ]
                let bundleData = try JSONSerialization.data(withJSONObject: keyBundle)

                // Encrypt with ECDH-derived key
                let sealedBox = try AES.GCM.seal(bundleData, using: symmetricKey)
                let encrypted = sealedBox.combined!.base64EncodedString()

                // Upload
                _ = try await APIClient.shared.postRaw("/devices/key-transfer/bundle", body: [
                    "requestId": requestId,
                    "encryptedBundle": encrypted,
                    "ephemeralPub": myEphPub
                ])
                linkMessage = "✓ Keys transferred"
                return
            }
        }
    }

    // MARK: - Key Transfer (New Device)

    private func requestKeyTransferAsNewDevice() async {
        do {
            // Generate ephemeral X25519 key pair
            let myEphemeral = Curve25519.KeyAgreement.PrivateKey()
            let myEphPub = myEphemeral.publicKey.rawRepresentation.base64EncodedString()

            // Send transfer request
            let reqData = try await APIClient.shared.postRaw("/devices/key-transfer/request", body: ["ephemeralPub": myEphPub])
            guard let reqJson = try? JSONSerialization.jsonObject(with: reqData) as? [String: Any],
                  let requestId = reqJson["requestId"] as? String else {
                linkMessage = "Key transfer request failed"
                return
            }

            // Poll for bundle
            for _ in 0..<30 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let bundleData = try await APIClient.shared.getRaw("/devices/key-transfer/bundle?requestId=\(requestId)")
                guard let json = try? JSONSerialization.jsonObject(with: bundleData) as? [String: Any],
                      json["ready"] as? Bool == true,
                      let encryptedBundle = json["encryptedBundle"] as? String,
                      let remoteEphPub = json["ephemeralPub"] as? String else { continue }

                // Import remote ephemeral public key and do ECDH
                guard let remotePubData = Data(base64Encoded: remoteEphPub),
                      let combinedData = Data(base64Encoded: encryptedBundle) else { continue }
                let remotePubKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: remotePubData)
                let sharedSecret = try myEphemeral.sharedSecretFromKeyAgreement(with: remotePubKey)

                // Derive same AES key
                let symmetricKey = sharedSecret.hkdfDerivedSymmetricKey(
                    using: SHA256.self,
                    salt: Data(),
                    sharedInfo: Data("rocchat-key-transfer".utf8),
                    outputByteCount: 32
                )

                // Decrypt
                let sealedBox = try AES.GCM.SealedBox(combined: combinedData)
                let decrypted = try AES.GCM.open(sealedBox, using: symmetricKey)
                guard let keyBundle = try? JSONSerialization.jsonObject(with: decrypted) as? [String: String] else { continue }

                // Store received keys
                if let v = keyBundle["identityDHPrivate"], let d = Data(base64Encoded: v) {
                    storeSecureData(d, forKey: "rocchat_identity_dh_priv")
                    SessionManager.shared.identityDHPrivate = d
                }
                if let v = keyBundle["identityDHPublic"], let d = Data(base64Encoded: v) {
                    storeSecureData(d, forKey: "rocchat_identity_dh_pub")
                    SessionManager.shared.identityDHPublic = d
                }
                if let v = keyBundle["identityPrivate"], let d = Data(base64Encoded: v) {
                    storeSecureData(d, forKey: "identity_key_private")
                }
                if let v = keyBundle["identityPublic"], let d = Data(base64Encoded: v) {
                    storeSecureData(d, forKey: "identity_key_public")
                }

                linkMessage = "✓ Keys received — encryption ready"
                return
            }
            linkMessage = "Key transfer timed out"
        } catch {
            linkMessage = "Key transfer failed"
        }
    }

    private func processImport(source: String, text: String) async {
        importStatus = "Parsing \(source) export..."
        var parsed: [[String: Any]] = []

        if source == "whatsapp" {
            for line in text.components(separatedBy: "\n") {
                let pattern = #"^(\d{1,2}/\d{1,2}/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*-\s*([^:]+):\s*(.+)$"#
                if let regex = try? NSRegularExpression(pattern: pattern),
                   let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) {
                    let ts = String(line[Range(match.range(at: 1), in: line)!])
                    let sender = String(line[Range(match.range(at: 2), in: line)!]).trimmingCharacters(in: .whitespaces)
                    let body = String(line[Range(match.range(at: 3), in: line)!])
                    parsed.append(["timestamp": ts, "sender_name": sender, "body": body])
                }
            }
        } else if source == "telegram" || source == "signal" {
            if let data = text.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msgs = (json["messages"] as? [[String: Any]]) {
                for m in msgs {
                    let body = (source == "telegram" ? m["text"] : m["body"]) as? String ?? ""
                    let sender = (source == "telegram" ? (m["from"] as? String ?? "Unknown") : (m["source"] as? String ?? "Unknown"))
                    let ts = (m["date"] ?? m["sent_at"] ?? m["timestamp"]) as? String ?? ""
                    if !body.isEmpty { parsed.append(["timestamp": ts, "sender_name": sender, "body": body]) }
                }
            }
        }

        guard !parsed.isEmpty else { importStatus = "No messages found in file"; return }

        // Create conversation and batch upload
        do {
            let convBody: [String: Any] = ["type": "direct", "member_ids": [] as [String], "name": "\(source) import"]
            let convData = try await APIClient.shared.postRaw("/messages/conversations", body: convBody)
            guard let convJson = try JSONSerialization.jsonObject(with: convData) as? [String: Any],
                  let convId = convJson["conversation_id"] as? String else {
                importStatus = "Failed to create conversation"; return
            }
            var total = 0
            let chunkSize = 500
            for i in stride(from: 0, to: parsed.count, by: chunkSize) {
                let batch = Array(parsed[i..<min(i + chunkSize, parsed.count)])
                let body: [String: Any] = ["source": source, "conversation_id": convId, "messages": batch]
                let resData = try await APIClient.shared.postRaw("/features/import", body: body)
                if let res = try? JSONSerialization.jsonObject(with: resData) as? [String: Any] {
                    total += res["imported"] as? Int ?? batch.count
                }
                importStatus = "Imported \(total) of \(parsed.count) messages..."
            }
            importStatus = "✅ Imported \(total) messages from \(source)"
        } catch {
            importStatus = "Import failed — check file format"
        }
    }

    private func saveQuietHours() {
        guard quietHoursEnabled else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        Task {
            let body: [String: Any] = [
                "quiet_start": formatter.string(from: quietStart),
                "quiet_end": formatter.string(from: quietEnd),
            ]
            _ = try? await APIClient.shared.postRaw("/features/quiet-hours", body: body, method: "PUT")
        }
    }

    private func addKeyword() {
        let kw = newKeyword.trimmingCharacters(in: .whitespaces).lowercased()
        guard !kw.isEmpty, !alertKeywords.contains(kw), alertKeywords.count < 20 else { return }
        alertKeywords.append(kw)
        newKeyword = ""
        saveKeywords()
    }

    private func saveKeywords() {
        Task {
            _ = try? await APIClient.shared.postRaw("/features/quiet-hours", body: [
                "alert_keywords": alertKeywords
            ], method: "PUT")
        }
    }

    private func initials(from name: String) -> String {
        String(name.split(separator: " ").prefix(2).compactMap { $0.first }).uppercased()
    }

    private func uploadAvatar(item: PhotosPickerItem) async {
        await MainActor.run { isUploadingAvatar = true }
        defer { Task { @MainActor in isUploadingAvatar = false; selectedPhoto = nil } }
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else { return }
            // Resize to max 512x512 and recompress as JPEG
            let maxDim: CGFloat = 512
            let scale = min(maxDim / image.size.width, maxDim / image.size.height, 1)
            let newSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            UIGraphicsBeginImageContextWithOptions(newSize, false, 1)
            image.draw(in: CGRect(origin: .zero, size: newSize))
            let resized = UIGraphicsGetImageFromCurrentImageContext() ?? image
            UIGraphicsEndImageContext()
            guard let jpeg = resized.jpegData(compressionQuality: 0.85) else { return }

            // E2E encrypt the avatar before upload
            let uploadData: Data
            let contentType: String
            if let vaultData = SecureStorage.shared.getData(forKey: "rocchat_vault_key"), vaultData.count == 32 {
                let vk = SymmetricKey(data: vaultData)
                let info = Data("rocchat:avatar:encrypt".utf8)
                let avatarKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: vk, salt: Data(), info: info, outputByteCount: 32)
                let nonce = AES.GCM.Nonce()
                let sealed = try AES.GCM.seal(jpeg, using: avatarKey, nonce: nonce)
                uploadData = Data(nonce) + sealed.ciphertext + sealed.tag
                contentType = "application/octet-stream"
            } else {
                uploadData = jpeg
                contentType = "image/jpeg"
            }

            let resp = try await APIClient.shared.uploadBinary("/me/avatar", data: uploadData, headers: [
                "Content-Type": contentType,
            ])
            if let json = try JSONSerialization.jsonObject(with: resp) as? [String: Any],
               let url = json["avatar_url"] as? String {
                await MainActor.run { avatarUrl = url }
            }
        } catch {}
    }

    private func generateQRCode(from string: String) -> UIImage? {
        guard let data = string.data(using: .ascii),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scale = CGAffineTransform(scaleX: 10, y: 10)
        let scaled = output.transformed(by: scale)
        return UIImage(ciImage: scaled)
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

    // MARK: - Decoy Conversations Helpers
    private func loadDecoys() {
        if let data = UserDefaults.standard.data(forKey: "rocchat_decoy_convs"),
           let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            decoyConversations = arr
        }
    }
    private func saveDecoys() {
        if let encoded = try? JSONSerialization.data(withJSONObject: decoyConversations) {
            UserDefaults.standard.set(encoded, forKey: "rocchat_decoy_convs")
        }
    }
    private func addDecoy() {
        let name = decoyNameInput.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        let msgs = decoyMessageInput.components(separatedBy: "\n").filter { !$0.isEmpty }.map { line -> [String: String] in
            let parts = line.split(separator: "|", maxSplits: 1)
            return ["sender": parts.count > 1 ? String(parts[0]) : "Them", "text": parts.count > 1 ? String(parts[1]) : String(line)]
        }
        let id = "decoy_\(UUID().uuidString.prefix(8).lowercased())"
        let decoy: [String: Any] = ["id": id, "name": name, "messages": msgs]
        decoyConversations.append(decoy)
        saveDecoys()
        decoyNameInput = ""
        decoyMessageInput = ""
    }
    private func removeDecoy(at idx: Int) {
        guard idx < decoyConversations.count else { return }
        decoyConversations.remove(at: idx)
        saveDecoys()
    }

    // MARK: - Custom Emoji Helpers
    private func loadCustomEmojis() {
        if let data = UserDefaults.standard.data(forKey: "rocchat_custom_emoji"),
           let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] {
            customEmojis = arr
        }
    }
    private func saveCustomEmojis() {
        UserDefaults.standard.set(try? JSONSerialization.data(withJSONObject: customEmojis), forKey: "rocchat_custom_emoji")
    }
    private func addCustomEmoji(imageData: Data) {
        let sc = emojiShortcodeInput.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "_")
        guard !sc.isEmpty, imageData.count <= 1_000_000, customEmojis.count < 64 else { return }
        let b64 = imageData.base64EncodedString()
        let dataUrl = "data:image/png;base64,\(b64)"
        customEmojis.append(["shortcode": sc, "data_url": dataUrl])
        saveCustomEmojis()
        emojiShortcodeInput = ""
    }

    // MARK: - Donation Helpers
    private func loadDonorStatus() async {
        do {
            let data = try await APIClient.shared.getRaw("/features/donor")
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                donorTier = json["tier"] as? String ?? ""
                donorSince = json["donor_since"] as? String ?? ""
            }
        } catch {}
    }
    private func donorBadgeEmoji(_ tier: String) -> String {
        switch tier.lowercased() {
        case "coffee": return "☕"
        case "feather": return "🪶"
        case "wing": return "🦅"
        case "mountain": return "🏔️"
        case "patron": return "👑"
        default: return "💛"
        }
    }
    private func submitDonation(tier: String, amount: Int) async {
        do {
            let body: [String: Any] = ["type": "crypto", "amount": amount, "recurring": false]
            let data = try await APIClient.shared.postRaw("/billing/crypto/checkout", body: body)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let _ = json["intent_id"] as? String {
                // Set donor tier badge
                _ = try await APIClient.shared.postRaw("/features/donor", body: ["tier": tier])
                await loadDonorStatus()
            }
        } catch {}
    }

    // MARK: - Encrypted Backup Helpers
    private func exportBackup() async {
        backupStatus = "Exporting..."
        let passphrase = backupPassphrase
        guard passphrase.count >= 12 else { backupStatus = "Passphrase must be 12+ characters"; return }
        // Gather local data
        var backupData: [String: Any] = [:]
        let secureDataKeys = ["identity_key_public", "identity_key_private", "rocchat_identity_dh_pub", "rocchat_identity_dh_priv"]
        for key in secureDataKeys {
            if let data = secureData(forKey: key) {
                backupData[key] = data.base64EncodedString()
            }
        }
        if let recoveryPhrase = secureString(forKey: "recovery_phrase") {
            backupData["recovery_phrase"] = recoveryPhrase
        }

        let defaultsBackedKeys = ["rocchat_custom_emoji", "rocchat_decoy_convs", "default_disappear_timer"]
        for key in defaultsBackedKeys {
            if let val = UserDefaults.standard.object(forKey: key) {
                if let data = val as? Data {
                    backupData[key] = data.base64EncodedString()
                } else if let str = val as? String {
                    backupData[key] = str
                } else if let num = val as? Int {
                    backupData[key] = num
                }
            }
        }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: backupData) else {
            backupStatus = "Failed to serialize"; return
        }
        // Encrypt with AES-GCM using passphrase
        let salt = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let keyMaterial = SHA256.hash(data: passphrase.data(using: .utf8)! + salt)
        let symKey = SymmetricKey(data: Data(keyMaterial.prefix(32)))
        guard let sealed = try? AES.GCM.seal(jsonData, using: symKey) else {
            backupStatus = "Encryption failed"; return
        }
        var output = Data("ROCCHAT-BACKUP-2".utf8)
        output.append(salt)
        output.append(sealed.nonce.withUnsafeBytes { Data($0) })
        output.append(sealed.ciphertext)
        output.append(sealed.tag)
        // Save to files
        let filename = "rocchat-backup-\(Int(Date().timeIntervalSince1970)).enc"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? output.write(to: url)
        await MainActor.run {
            backupStatus = "✅ Backup saved to \(filename)"
            let ac = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let root = scene.windows.first?.rootViewController {
                root.present(ac, animated: true)
            }
        }
    }
    private func importBackup(from url: URL) async {
        backupStatus = "Importing..."
        let passphrase = backupPassphrase
        guard passphrase.count >= 12 else { backupStatus = "Passphrase must be 12+ characters"; return }
        guard url.startAccessingSecurityScopedResource() else { backupStatus = "Cannot access file"; return }
        defer { url.stopAccessingSecurityScopedResource() }
        guard let fileData = try? Data(contentsOf: url) else { backupStatus = "Cannot read file"; return }

        // File format: 16-byte salt + 12-byte IV + ciphertext + 16-byte tag
        guard fileData.count > 44 else { backupStatus = "Invalid backup file"; return }
        let salt = fileData[0..<16]
        let iv = fileData[16..<28]
        let ciphertextAndTag = fileData[28...]

        // Derive key from passphrase
        guard let passphraseData = passphrase.data(using: .utf8) else { backupStatus = "Invalid passphrase"; return }
        var derivedKey = Data(count: 32)
        let result = derivedKey.withUnsafeMutableBytes { dkBytes in
            salt.withUnsafeBytes { saltBytes in
                passphraseData.withUnsafeBytes { pwBytes in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pwBytes.baseAddress?.assumingMemoryBound(to: Int8.self),
                        pwBytes.count,
                        saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        saltBytes.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        100_000,
                        dkBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        32
                    )
                }
            }
        }
        guard result == kCCSuccess else { backupStatus = "Key derivation failed"; return }

        do {
            let key = SymmetricKey(data: derivedKey)
            let nonce = try AES.GCM.Nonce(data: iv)
            let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertextAndTag.dropLast(16), tag: ciphertextAndTag.suffix(16))
            let plainData = try AES.GCM.open(sealedBox, using: key)
            guard let json = try? JSONSerialization.jsonObject(with: plainData) as? [String: Any] else {
                backupStatus = "Wrong passphrase or corrupt backup"
                return
            }

            // Restore keys
            if let identityKey = (json["identity_key_private"] as? String) ?? (json["identity_key"] as? String),
               let data = Data(base64Encoded: identityKey) {
                storeSecureData(data, forKey: "identity_key_private")
            }
            if let identityPub = json["identity_key_public"] as? String, let data = Data(base64Encoded: identityPub) {
                storeSecureData(data, forKey: "identity_key_public")
            }
            if let identityDhPub = json["rocchat_identity_dh_pub"] as? String, let data = Data(base64Encoded: identityDhPub) {
                storeSecureData(data, forKey: "rocchat_identity_dh_pub")
            }
            if let identityDhPriv = json["rocchat_identity_dh_priv"] as? String, let data = Data(base64Encoded: identityDhPriv) {
                storeSecureData(data, forKey: "rocchat_identity_dh_priv")
            }
            if let recoveryPhrase = json["recovery_phrase"] as? String {
                storeSecureString(recoveryPhrase, forKey: "recovery_phrase")
            }
            // Restore sessions
            if let sessions = json["sessions"] as? [String: Any] {
                for (key, val) in sessions {
                    if let strVal = val as? String {
                        UserDefaults.standard.set(strVal, forKey: key)
                    }
                }
            }
            backupStatus = "✅ Backup restored successfully! Restart the app."
        } catch {
            backupStatus = "Wrong passphrase or corrupt backup"
        }
    }

    // MARK: - Saved Contacts Helpers
    private func loadSavedContacts() async {
        do {
            let data = try await APIClient.shared.getRaw("/features/contacts")
            if let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                savedContacts = arr
            }
        } catch {}
    }
    private func removeSavedContact(id: String) async {
        _ = try? await APIClient.shared.deleteRaw("/features/contacts/\(id)")
        await loadSavedContacts()
    }
    private func saveContactNickname(id: String, nickname: String) async {
        let body: [String: Any] = ["contact_id": id, "nickname": nickname]
        _ = try? await APIClient.shared.postRaw("/features/contacts", body: body)
        await loadSavedContacts()
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

// MARK: - Vault Item

struct VaultItemData {
    let vaultType: String
    let label: String
    let encryptedPayload: String
    let viewOnce: Bool
}

func parseVaultItem(_ text: String) -> VaultItemData? {
    guard text.contains("\"type\":\"vault_item\""),
          let data = text.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let vaultType = json["vaultType"] as? String,
          let label = json["label"] as? String,
          let payload = json["encryptedPayload"] as? String else { return nil }
    return VaultItemData(vaultType: vaultType, label: label, encryptedPayload: payload, viewOnce: json["viewOnce"] as? Bool ?? false)
}

struct VaultItemView: View {
    let vault: VaultItemData
    let messageId: String
    @State private var revealed = false

    private var icon: String {
        switch vault.vaultType {
        case "password": return "🔑"
        case "wifi": return "📶"
        case "card": return "💳"
        case "note": return "📝"
        default: return "🔐"
        }
    }

    private var decodedFields: [String: String] {
        guard let data = Data(base64Encoded: vault.encryptedPayload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return [:] }
        return json
    }

    private var viewedKey: String { "rocchat_vault_viewed_\(messageId)" }
    private var alreadyViewed: Bool { vault.viewOnce && UserDefaults.standard.bool(forKey: viewedKey) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(icon)
                Text(vault.label).fontWeight(.semibold).font(.subheadline)
                if vault.viewOnce {
                    Text("👁 View once").font(.caption2).foregroundColor(.orange)
                }
            }
            if alreadyViewed {
                Text("Already viewed").font(.caption).foregroundColor(.secondary)
            } else if revealed {
                ForEach(Array(decodedFields.sorted(by: { $0.key < $1.key })), id: \.key) { key, value in
                    HStack {
                        Text(key.capitalized).font(.caption).foregroundColor(.secondary).frame(width: 80, alignment: .leading)
                        if vault.vaultType == "card" && key == "number" {
                            Text("•••• \(String(value.suffix(4)))").font(.caption).monospaced()
                        } else {
                            Text(value).font(.caption).monospaced().textSelection(.enabled)
                        }
                    }
                }
                Button("Copy All") {
                    let text = decodedFields.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
                    UIPasteboard.general.string = text
                }
                .font(.caption).foregroundColor(.rocGold)
            } else {
                Button("Tap to reveal") {
                    revealed = true
                    if vault.viewOnce { UserDefaults.standard.set(true, forKey: viewedKey) }
                }
                .font(.caption).foregroundColor(.turquoise)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.rocGold.opacity(0.08)))
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

// MARK: - Safety Number Sheet
struct SafetyNumberSheet: View {
    let safetyNumber: String
    let otherName: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "shield.checkered")
                    .font(.system(size: 48))
                    .foregroundColor(.turquoise)

                Text("Verify Safety Number")
                    .font(.headline)

                Text("Compare this number with **\(otherName)** to verify end-to-end encryption.")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                let groups = safetyNumber.split(separator: " ").map(String.init)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
                    ForEach(groups, id: \.self) { group in
                        Text(group)
                            .font(.system(.title3, design: .monospaced))
                            .fontWeight(.medium)
                    }
                }
                .padding()

                Text("If both of you see the same number, your messages are secure.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)

                Button {
                    UIPasteboard.general.string = safetyNumber
                } label: {
                    Label("Copy Safety Number", systemImage: "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.turquoise)
                .padding(.horizontal)

                Spacer()
            }
            .padding(.top, 30)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Typing Dots Animation

struct TypingDotsView: View {
    @State private var phase = 0.0
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(Color.adaptiveTextSec)
                    .frame(width: 5, height: 5)
                    .offset(y: sin((phase + Double(i) * 0.6)) * 3)
            }
        }
        .onAppear {
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                phase = .pi * 2
            }
        }
    }
}

// MARK: - Link Preview Helper

struct LinkPreviewView: View {
    let urlString: String
    @State private var title: String?
    @State private var description: String?
    @State private var imageURL: String?

    var body: some View {
        if let title {
            VStack(alignment: .leading, spacing: 4) {
                if let imageURL, let url = URL(string: imageURL) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        Color.gray.opacity(0.2)
                    }
                    .frame(maxHeight: 120)
                    .clipped()
                    .cornerRadius(8)
                }
                Text(title).font(.caption.weight(.semibold)).lineLimit(2)
                if let description {
                    Text(description).font(.caption2).foregroundColor(.adaptiveTextSec).lineLimit(2)
                }
                Text(urlString).font(.caption2).foregroundColor(.turquoise).lineLimit(1)
            }
            .padding(8)
            .background(Color(.tertiarySystemBackground))
            .cornerRadius(10)
        } else {
            EmptyView()
                .task { await fetchPreview() }
        }
    }

    private func fetchPreview() async {
        let mode = UserDefaults.standard.string(forKey: "link_preview_mode") ?? "server"
        guard mode != "disabled" else { return }
        do {
            let encoded = urlString.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? urlString
            if mode == "client" {
                guard let url = URL(string: urlString) else { return }
                let (data, _) = try await URLSession.shared.data(from: url)
                let html = String(data: data, encoding: .utf8) ?? ""
                title = html.range(of: "(?<=<title>)[^<]+", options: .regularExpression).map { String(html[$0]) }
                description = html.range(of: "(?<=content=\")[^\"]+(?=\"[^>]*property=\"og:description)", options: .regularExpression).map { String(html[$0]) }
                    ?? html.range(of: "(?<=property=\"og:description\"[^>]*content=\")[^\"]+", options: .regularExpression).map { String(html[$0]) }
                imageURL = html.range(of: "(?<=content=\")[^\"]+(?=\"[^>]*property=\"og:image)", options: .regularExpression).map { String(html[$0]) }
                    ?? html.range(of: "(?<=property=\"og:image\"[^>]*content=\")[^\"]+", options: .regularExpression).map { String(html[$0]) }
            } else {
                let data = try await APIClient.shared.getRaw("/link-preview?url=\(encoded)")
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    title = json["title"] as? String
                    description = json["description"] as? String
                    imageURL = json["image"] as? String
                }
            }
        } catch {}
    }
}

// MARK: - Forward Message Sheet

struct ForwardMessageSheet: View {
    let message: ChatMessage?
    let onForward: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var conversations: [ChatConversation] = []
    private let userId = UserDefaults.standard.string(forKey: "user_id") ?? ""

    private var messageTypeIcon: String {
        switch message?.messageType {
        case "image": return "photo"
        case "video": return "video"
        case "audio", "voice": return "waveform"
        case "file": return "doc"
        default: return "text.bubble"
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let msg = message {
                    HStack(spacing: 10) {
                        Image(systemName: messageTypeIcon)
                            .font(.subheadline)
                            .foregroundColor(.rocGold)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Forwarding message")
                                .font(.caption)
                                .foregroundColor(.adaptiveTextSec)
                            Text(msg.ciphertext.isEmpty ? "Encrypted message" : msg.ciphertext)
                                .font(.subheadline)
                                .foregroundColor(.adaptiveText)
                                .lineLimit(2)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.rocGold.opacity(0.06))
                    Divider()
                }

                List(conversations) { conv in
                    Button(action: {
                        onForward(conv.id)
                        dismiss()
                    }) {
                        HStack(spacing: 12) {
                            AvatarView(name: conv.name ?? conv.members.first?.username ?? "?", avatarUrl: conv.avatarURL, size: 40)
                            VStack(alignment: .leading) {
                                Text(conv.name ?? conv.members.filter { $0.userId != userId }.map { $0.displayName.isEmpty ? $0.username : $0.displayName }.joined(separator: ", "))
                                    .font(.headline)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundColor(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .navigationTitle("Forward To")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                do {
                    let data = try await APIClient.shared.getRaw("/conversations")
                    if let json = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                        conversations = json.compactMap { dict -> ChatConversation? in
                            guard let id = dict["id"] as? String else { return nil }
                            let name = dict["name"] as? String
                            let avatar = dict["avatar_url"] as? String
                            let members = (dict["members"] as? [[String: Any]])?.compactMap { m -> (userId: String, username: String, displayName: String)? in
                                guard let uid = m["user_id"] as? String ?? m["userId"] as? String,
                                      let un = m["username"] as? String,
                                      let dn = m["display_name"] as? String ?? m["displayName"] as? String else { return nil }
                                return (uid, un, dn)
                            } ?? []
                            return ChatConversation(
                                id: id, type: (dict["type"] as? String) ?? "direct", name: name, avatarURL: avatar,
                                members: members.map { ChatConversation.ConversationMember(userId: $0.0, username: $0.1, displayName: $0.2, avatarUrl: nil) },
                                lastMessageAt: dict["last_message_at"] as? String, lastMessageType: dict["last_message_type"] as? String, muted: false, archived: false
                            )
                        }
                    }
                } catch {}
            }
        }
    }
}

// MARK: - Helpers

private func extractURL(from text: String) -> String? {
    let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    let matches = detector?.matches(in: text, range: NSRange(text.startIndex..., in: text)) ?? []
    return matches.first?.url?.absoluteString
}

// MARK: - URL MIME Type Extension

extension URL {
    var mimeType: String {
        let ext = pathExtension.lowercased()
        let map: [String: String] = [
            "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "gif": "image/gif", "pdf": "application/pdf", "doc": "application/msword",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "txt": "text/plain", "mp4": "video/mp4", "mov": "video/quicktime",
            "mp3": "audio/mpeg", "m4a": "audio/mp4", "zip": "application/zip",
        ]
        return map[ext] ?? "application/octet-stream"
    }
}

// MARK: - Sticker Picker View
struct StickerPickerView: View {
    let onSelect: (String) -> Void
    @State private var selectedTab = 0
    @State private var searchText = ""

    private static let categories: [(String, [String])] = [
        ("Smileys", ["😀","😂","🤣","😊","😍","🥰","😘","😜","🤪","😎","🥳","😇","🤩","🥺","😭","😤","🤯","🫡","🫶","❤️","🔥","✨","💯","👏","🙌","👊","✊","🤝","💪","🕊️"]),
        ("Roc Spirit", ["🪶","🦅","🏔️","⛰️","🌄","🌅","🌍","🕊️","✊","🔒","🛡️","💛","🖤","🤎","❤️‍🔥","🏴","🪧","📢","🎯","⚡","🌊","🌿","🌱","🫂","🤲","🙏","💎","👑","🦁","🇵🇸"]),
        ("Gestures", ["👍","👎","👋","🤙","✌️","🤞","🫰","🤟","🤘","👆","👇","👉","👈","🫵","🖐️","✋","🤚","👐","🤲","🙏","💅","🫶","🤝","👊","✊","🤛","🤜","🫳","🫴","💪"]),
        ("Objects", ["🔒","🔑","🗝️","🛡️","⚔️","🏴","📱","💻","🖥️","⌨️","🎵","🎶","📷","🎬","📖","✏️","📌","🔗","💰","🪙","🎁","🏆","🎖️","🧭","⏰","💡","🔋","📡","🌐","🗺️"]),
        ("Nature", ["🌍","🌎","🌏","🌙","⭐","🌟","☀️","🌤️","⛅","🌧️","⛈️","🌊","🏔️","🌋","🏜️","🌲","🌳","🌿","🍀","🌸","🌺","🌻","🌹","🦅","🦁","🐻","🐺","🦋","🐝","🕊️"]),
        ("Flags", ["🏴","🏳️","🏁","🚩","🏳️‍🌈","🏴‍☠️","🇵🇸","🇱🇧","🇾🇪","🇸🇾","🇮🇶","🇱🇾","🇸🇩","🇸🇴","🇪🇬","🇯🇴","🇩🇿","🇹🇳","🇲🇦","🇲🇷","🇹🇷","🇮🇷","🇲🇾","🇮🇩","🇧🇩","🇵🇰","🇿🇦","🇧🇷","🇨🇺","🇻🇪"]),
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $selectedTab) {
                    ForEach(0..<Self.categories.count, id: \.self) { i in
                        Text(Self.categories[i].0).tag(i)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 8)
                .padding(.top, 8)

                let emojis = Self.categories[selectedTab].1
                ScrollView {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 8) {
                        ForEach(emojis, id: \.self) { emoji in
                            Button(action: { onSelect(emoji) }) {
                                Text(emoji)
                                    .font(.system(size: 28))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(12)
                }
            }
            .navigationTitle("Emoji & Stickers")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

// MARK: - Roc Bird Status View
struct CanaryView: View {
    @State private var canaryText = ""
    @State private var loading = true

    var body: some View {
        ScrollView {
            if loading {
                ProgressView().padding()
            } else {
                Text(canaryText.isEmpty ? "No Roc Bird status statement available." : canaryText)
                    .padding()
                    .font(.body)
            }
        }
            .navigationTitle("Roc Bird Status")
        .task {
            do {
                let data = try await APIClient.shared.getRaw("/features/canary")
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let statement = json["statement"] as? String {
                    canaryText = statement
                } else if let text = String(data: data, encoding: .utf8) {
                    canaryText = text
                }
            } catch {}
            loading = false
        }
    }
}

// MARK: - Transparency View
struct TransparencyView: View {
    @State private var reports: [[String: Any]] = []
    @State private var loading = true

    var body: some View {
        List {
            if loading {
                ProgressView()
            } else if reports.isEmpty {
                Text("No transparency reports yet.").foregroundColor(.textSecondary)
            } else {
                ForEach(0..<reports.count, id: \.self) { i in
                    let report = reports[i]
                    VStack(alignment: .leading, spacing: 4) {
                        Text(report["title"] as? String ?? "Report")
                            .font(.headline)
                        Text(report["period"] as? String ?? "")
                            .font(.caption).foregroundColor(.textSecondary)
                        Text(report["summary"] as? String ?? "")
                            .font(.subheadline)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle("Transparency Reports")
        .task {
            do {
                let data = try await APIClient.shared.getRaw("/features/transparency")
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let arr = json["reports"] as? [[String: Any]] {
                    reports = arr
                }
            } catch {}
            loading = false
        }
    }
}

// MARK: - Supporters View
struct SupportersView: View {
    @State private var supporters: [[String: Any]] = []
    @State private var loading = true

    var body: some View {
        List {
            if loading {
                ProgressView()
            } else if supporters.isEmpty {
                Text("No supporters listed yet.").foregroundColor(.textSecondary)
            } else {
                ForEach(0..<supporters.count, id: \.self) { i in
                    let s = supporters[i]
                    HStack {
                        Text(s["display_name"] as? String ?? s["username"] as? String ?? "Anonymous")
                            .font(.body)
                        Spacer()
                        if let tier = s["tier"] as? String {
                            Text(tier).font(.caption).foregroundColor(.rocGold)
                        }
                    }
                }
            }
        }
        .navigationTitle("Supporters")
        .task {
            do {
                let data = try await APIClient.shared.getRaw("/features/supporters")
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let arr = json["supporters"] as? [[String: Any]] {
                    supporters = arr
                }
            } catch {}
            loading = false
        }
    }
}
