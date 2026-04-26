import SwiftUI

// MARK: - Config

enum APIConfig {
    static let baseURL = "https://rocchat-api.spoass.workers.dev"
}

// MARK: - Channel Models

struct ChannelItem: Identifiable, Codable {
    let id: String
    let name: String
    let description: String?
    let subscriber_count: Int
    let tags: String?
    let avatar_url: String?
    let is_public: Bool?
}

struct CommunityItem: Identifiable, Codable {
    let id: String
    let name: String
    let description: String?
    let member_count: Int
    let avatar_url: String?
}

// MARK: - Channels View

struct ChannelsView: View {
    @State private var channels: [ChannelItem] = []
    @State private var communities: [CommunityItem] = []
    @State private var searchText = ""
    @State private var isLoading = true
    @State private var showCreateChannel = false

    var body: some View {
        NavigationStack {
            List {
                Section("Channels") {
                    if isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else if channels.isEmpty {
                        Text("No channels found")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(channels) { channel in
                            ChannelRow(channel: channel)
                        }
                    }
                }

                Section("Communities") {
                    if communities.isEmpty && !isLoading {
                        Text("No communities yet")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(communities) { community in
                            CommunityRow(community: community)
                        }
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search channels")
            .onSubmit(of: .search) { Task { await loadChannels() } }
            .navigationTitle("Channels")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showCreateChannel = true } label: {
                        Image(systemName: "plus.circle.fill")
                    }
                }
            }
            .sheet(isPresented: $showCreateChannel) {
                CreateChannelSheet { Task { await loadChannels() } }
            }
            .task { await loadAll() }
            .refreshable { await loadAll() }
        }
    }

    private func loadAll() async {
        isLoading = true
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await loadChannels() }
            group.addTask { await loadCommunities() }
        }
        isLoading = false
    }

    @MainActor
    private func loadChannels() async {
        var path = "/api/channels/discover"
        if !searchText.isEmpty {
            path += "?q=\(searchText.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? searchText)"
        }
        guard let data = await apiGet(path: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = json["channels"] as? [[String: Any]] else { return }

        channels = arr.compactMap { dict in
            guard let id = dict["id"] as? String, let name = dict["name"] as? String else { return nil }
            return ChannelItem(
                id: id, name: name,
                description: dict["description"] as? String,
                subscriber_count: dict["subscriber_count"] as? Int ?? 0,
                tags: dict["tags"] as? String,
                avatar_url: dict["avatar_url"] as? String,
                is_public: dict["is_public"] as? Bool
            )
        }
    }

    @MainActor
    private func loadCommunities() async {
        guard let data = await apiGet(path: "/api/communities/discover"),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = json["communities"] as? [[String: Any]] else { return }

        communities = arr.compactMap { dict in
            guard let id = dict["id"] as? String, let name = dict["name"] as? String else { return nil }
            return CommunityItem(
                id: id, name: name,
                description: dict["description"] as? String,
                member_count: dict["member_count"] as? Int ?? 0,
                avatar_url: dict["avatar_url"] as? String
            )
        }
    }

    private func apiGet(path: String) async -> Data? {
          guard let token = SecureStorage.shared.get(forKey: "session_token")
                ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)\(path)") else { return nil }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try? await APIClient.shared.session.data(for: req).0
    }
}

// MARK: - Channel Row

struct ChannelRow: View {
    let channel: ChannelItem

    var body: some View {
        NavigationLink(destination: ChannelDetailView(channelId: channel.id, channelName: channel.name)) {
            HStack(spacing: 12) {
                Image(systemName: "megaphone.fill")
                    .font(.title2)
                    .foregroundStyle(Color.rocGold)
                    .frame(width: 40, height: 40)
                    .background(Color.rocGold.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 2) {
                    Text(channel.name).font(.headline)
                    if let desc = channel.description {
                        Text(desc)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                Text("\(channel.subscriber_count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }
}

// MARK: - Channel Detail View

struct ChannelDetailView: View {
    let channelId: String
    let channelName: String

    @State private var channel: [String: Any]?
    @State private var isAdmin = false
    @State private var isSubscribed = false
    @State private var subscriberCount = 0
    @State private var pinnedPostId: String?
    @State private var showScheduleSheet = false
    @State private var showAnalytics = false
    @State private var showScheduledList = false
    @State private var showNewPost = false
    @State private var posts: [[String: Any]] = []

    var body: some View {
        List {
            Section {
                HStack {
                    Image(systemName: "megaphone.fill")
                        .font(.largeTitle)
                        .foregroundStyle(Color.rocGold)
                    VStack(alignment: .leading) {
                        Text(channelName).font(.title2.bold())
                        Text("\(subscriberCount) subscribers")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                if isSubscribed {
                    Button(role: .destructive) { Task { await unsubscribe() } } label: {
                        Label("Unsubscribe", systemImage: "xmark.circle")
                    }
                } else {
                    Button { Task { await subscribe() } } label: {
                        Label("Subscribe", systemImage: "plus.circle.fill")
                    }
                    .tint(.rocGold)
                }
            }

            if let pinId = pinnedPostId {
                Section("Pinned Post") {
                    HStack {
                        Image(systemName: "pin.fill").foregroundStyle(.orange)
                        Text("Post \(pinId.prefix(8))...").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if isAdmin {
                            Button("Unpin") { Task { await unpin() } }
                                .font(.caption).tint(.red)
                        }
                    }
                }
            }

            // Posts feed
            if !posts.isEmpty {
                Section("Posts") {
                    ForEach(Array(posts.enumerated()), id: \.offset) { _, post in
                        let ts = post["created_at"] as? String ?? ""
                        let body = decodeChannelPostBody(post)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(formatPostTime(ts))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(body)
                                .font(.body)
                                .lineLimit(20)
                        }
                        .padding(.vertical, 4)
                    }
                }
            } else if isSubscribed {
                Section { Text("No posts yet").font(.caption).foregroundStyle(.secondary) }
            }

            if isAdmin {
                Section("Admin") {
                    Button { showNewPost = true } label: {
                        Label("New Post", systemImage: "square.and.pencil")
                    }
                    Button { showScheduleSheet = true } label: {
                        Label("Schedule Post", systemImage: "clock.arrow.circlepath")
                    }
                    Button { showScheduledList = true } label: {
                        Label("Scheduled Posts", systemImage: "list.bullet.clipboard")
                    }
                    Button { showAnalytics = true } label: {
                        Label("Analytics", systemImage: "chart.bar.fill")
                    }
                }
            }
        }
        .navigationTitle(channelName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadChannel() }
        .sheet(isPresented: $showScheduleSheet) {
            ChannelPostSheet(channelId: channelId, isScheduled: true) { Task { await loadChannel() } }
        }
        .sheet(isPresented: $showNewPost) {
            ChannelPostSheet(channelId: channelId, isScheduled: false) { Task { await loadChannel() } }
        }
        .sheet(isPresented: $showAnalytics) {
            ChannelAnalyticsView(channelId: channelId)
        }
        .sheet(isPresented: $showScheduledList) {
            ChannelScheduledListView(channelId: channelId)
        }
    }

    @MainActor
    private func loadChannel() async {
        guard let data = await apiRequest(path: "/api/channels/\(channelId)", method: "GET"),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ch = json["channel"] as? [String: Any] else { return }
        channel = ch
        let role = ch["my_role"] as? String
        isAdmin = role == "owner" || role == "admin"
        isSubscribed = role != nil
        subscriberCount = ch["subscriber_count"] as? Int ?? 0
        pinnedPostId = ch["pinned_post_id"] as? String
        await loadPosts()
    }

    @MainActor
    private func loadPosts() async {
        guard let data = await apiRequest(path: "/api/messages/\(channelId)?limit=50", method: "GET"),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = json["messages"] as? [[String: Any]] else { return }

        // Decode each post body asynchronously. E2E posts need an async unwrap;
        // legacy posts decode synchronously inline. Build a `decoded_body` field
        // on each post dictionary so the SwiftUI render path can stay synchronous.
        var resolved: [[String: Any]] = []
        for var msg in arr {
            let body = await ChannelDetailView.resolvePostBody(channelId: channelId, post: msg)
            msg["__decoded_body"] = body
            resolved.append(msg)
        }
        posts = resolved

        // Mark as read for analytics (best-effort)
        for msg in arr {
            if let id = msg["id"] as? String {
                Task.detached { _ = await self.apiRequest(path: "/api/channels/\(self.channelId)/read/\(id)", method: "POST") }
            }
        }
    }

    /// Decode a channel post body. Uses the cached `__decoded_body` field
    /// produced by `loadPosts`; falls back to the legacy synchronous path
    /// for scheduled-post previews where async resolution isn't available.
    private func decodeChannelPostBody(_ post: [String: Any]) -> String {
        if let cached = post["__decoded_body"] as? String { return cached }
        return ChannelDetailView.decodeScheduledPreview(post)
    }

    /// Async resolver: tries E2E unwrap first, falls back to legacy base64.
    static func resolvePostBody(channelId: String, post: [String: Any]) async -> String {
        let ratchetHeader = post["ratchet_header"] as? String ?? ""
        if !ratchetHeader.isEmpty,
           let hData = ratchetHeader.data(using: .utf8),
           let hJson = try? JSONSerialization.jsonObject(with: hData) as? [String: Any],
           let cv = hJson["cv"] as? Int, cv == 1 {
            // E2E post — try native unwrap
            let ct = post["ciphertext"] as? String ?? ""
            let iv = post["iv"] as? String ?? ""
            if let plaintext = await ChannelCrypto.decryptPost(
                channelId: channelId, ciphertextB64: ct, ivB64: iv, ratchetHeader: ratchetHeader,
            ) {
                return plaintext
            }
            return "[Encrypted post — key not yet received]"
        }
        // Legacy base64 plaintext path
        return decodeScheduledPreview(post)
    }

    /// Synchronous helper for legacy base64 plaintext (scheduled-post previews).
    static func decodeScheduledPreview(_ post: [String: Any]) -> String {
        let ratchetHeader = post["ratchet_header"] as? String ?? ""
        if !ratchetHeader.isEmpty,
           let hData = ratchetHeader.data(using: .utf8),
           let hJson = try? JSONSerialization.jsonObject(with: hData) as? [String: Any],
           let cv = hJson["cv"] as? Int, cv == 1 {
            return "[Encrypted post — key not yet received]"
        }
        let ct = post["ciphertext"] as? String ?? ""
        if let data = Data(base64Encoded: ct), let s = String(data: data, encoding: .utf8) {
            if s.unicodeScalars.contains(where: { ($0.value < 0x20 && $0.value != 0x09 && $0.value != 0x0A && $0.value != 0x0D) || $0.value == 0xFFFD }) {
                return "[Encrypted post]"
            }
            return s
        }
        return "[Encrypted post]"
    }

    private func formatPostTime(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) {
            let rel = RelativeDateTimeFormatter()
            rel.unitsStyle = .short
            return rel.localizedString(for: d, relativeTo: Date())
        }
        return iso
    }

    private func subscribe() async {
        let _ = await apiRequest(path: "/api/channels/\(channelId)/subscribe", method: "POST")
        await loadChannel()
    }

    private func unsubscribe() async {
        let _ = await apiRequest(path: "/api/channels/\(channelId)/subscribe", method: "DELETE")
        await loadChannel()
    }

    private func unpin() async {
        let _ = await apiRequest(path: "/api/channels/\(channelId)/pin", method: "DELETE")
        await loadChannel()
    }

    private func apiRequest(path: String, method: String, body: Data? = nil) async -> Data? {
          guard let token = SecureStorage.shared.get(forKey: "session_token")
                ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)\(path)") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = body }
        return try? await APIClient.shared.session.data(for: req).0
    }
}

// MARK: - Channel Post Sheet

struct ChannelPostSheet: View {
    let channelId: String
    let isScheduled: Bool
    var onDone: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var content = ""
    @State private var scheduleDate = Date().addingTimeInterval(3600)
    @State private var isSending = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Message") {
                    TextEditor(text: $content)
                        .frame(minHeight: 120)
                }
                if isScheduled {
                    Section("Schedule") {
                        DatePicker("Send at", selection: $scheduleDate, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    }
                }
            }
            .navigationTitle(isScheduled ? "Schedule Post" : "New Post")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isScheduled ? "Schedule" : "Post") { Task { await send() } }
                        .disabled(content.isEmpty || isSending)
                }
            }
        }
    }

    private func send() async {
        isSending = true
        let ciphertext = Data(content.utf8).base64EncodedString()
        if isScheduled {
            let schedAt = Int(scheduleDate.timeIntervalSince1970)
            let body: [String: Any] = ["ciphertext": ciphertext, "iv": "", "scheduled_at": schedAt]
            let bodyData = try? JSONSerialization.data(withJSONObject: body)
            let _ = await apiRequest(path: "/api/channels/\(channelId)/schedule", method: "POST", body: bodyData)
        } else {
            let body: [String: Any] = ["ciphertext": ciphertext, "iv": "", "ratchet_header": "{}", "message_type": "text"]
            let bodyData = try? JSONSerialization.data(withJSONObject: body)
            let _ = await apiRequest(path: "/api/channels/\(channelId)/post", method: "POST", body: bodyData)
        }
        await MainActor.run { onDone(); dismiss() }
    }

    private func apiRequest(path: String, method: String, body: Data? = nil) async -> Data? {
        guard let token = UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)\(path)") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = body }
        return try? await APIClient.shared.session.data(for: req).0
    }
}

// MARK: - Channel Analytics View

struct ChannelAnalyticsView: View {
    let channelId: String
    @Environment(\.dismiss) private var dismiss
    @State private var subscriberCount = 0
    @State private var posts: [[String: Any]] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        VStack { Text("\(subscriberCount)").font(.title.bold()).foregroundStyle(Color.rocGold); Text("Subscribers").font(.caption) }
                        Spacer()
                        VStack { Text("\(posts.count)").font(.title.bold()).foregroundStyle(Color.rocGold); Text("Posts").font(.caption) }
                        Spacer()
                        let avg = posts.isEmpty ? 0 : posts.reduce(0) { $0 + ($1["read_count"] as? Int ?? 0) } / posts.count
                        VStack { Text("\(avg)").font(.title.bold()).foregroundStyle(Color.rocGold); Text("Avg Reads").font(.caption) }
                    }
                }
                Section("Post Performance") {
                    ForEach(Array(posts.enumerated()), id: \.offset) { _, post in
                        let reads = post["read_count"] as? Int ?? 0
                        let pct = subscriberCount > 0 ? Double(reads) / Double(subscriberCount) : 0
                        let ts = post["created_at"] as? Int ?? 0
                        HStack {
                            Text(Date(timeIntervalSince1970: TimeInterval(ts)), style: .date).font(.caption)
                            Spacer()
                            ProgressView(value: min(pct, 1.0)).tint(.rocGold).frame(width: 80)
                            Text("\(reads) (\(Int(pct * 100))%)").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Analytics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    @MainActor
    private func load() async {
          guard let token = SecureStorage.shared.get(forKey: "session_token")
                ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/channels/\(channelId)/analytics") else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await APIClient.shared.session.data(for: req),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        subscriberCount = json["subscriber_count"] as? Int ?? 0
        posts = json["posts"] as? [[String: Any]] ?? []
    }
}

// MARK: - Scheduled Posts List

struct ChannelScheduledListView: View {
    let channelId: String
    @Environment(\.dismiss) private var dismiss
    @State private var posts: [[String: Any]] = []

    var body: some View {
        NavigationStack {
            List {
                if posts.isEmpty {
                    Text("No scheduled posts").foregroundStyle(.secondary)
                } else {
                    ForEach(Array(posts.enumerated()), id: \.offset) { _, post in
                        let id = post["id"] as? String ?? ""
                        let ts = post["scheduled_at"] as? Int ?? 0
                        let preview = ChannelDetailView.decodeScheduledPreview(post)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(Date(timeIntervalSince1970: TimeInterval(ts)), style: .date).font(.caption)
                                    Text(Date(timeIntervalSince1970: TimeInterval(ts)), style: .time).font(.caption2).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button(role: .destructive) { Task { await cancel(id) } } label: {
                                    Image(systemName: "trash").font(.caption)
                                }
                            }
                            if !preview.isEmpty {
                                Text(preview).font(.caption).lineLimit(2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Scheduled")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    @MainActor
    private func load() async {
          guard let token = SecureStorage.shared.get(forKey: "session_token")
                ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/channels/\(channelId)/scheduled") else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await APIClient.shared.session.data(for: req),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        posts = json["posts"] as? [[String: Any]] ?? []
    }

    private func cancel(_ postId: String) async {
          guard let token = SecureStorage.shared.get(forKey: "session_token")
                ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/channels/\(channelId)/scheduled/\(postId)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let _ = try? await APIClient.shared.session.data(for: req)
        await load()
    }
}

// MARK: - Community Row (expandable with nested channels)

struct CommunityRow: View {
    let community: CommunityItem
    @State private var joined = false
    @State private var expanded = false
    @State private var channels: [ChannelItem] = []
    @State private var isLoadingChannels = false
    @State private var role: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    expanded.toggle()
                    if expanded && channels.isEmpty { Task { await loadCommunityDetail() } }
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "person.3.fill")
                        .font(.title3)
                        .foregroundStyle(.teal)
                        .frame(width: 40, height: 40)
                        .background(Color.teal.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(community.name).font(.headline).foregroundStyle(.primary)
                        if let desc = community.description {
                            Text(desc).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }

                    Spacer()

                    Text("\(community.member_count)")
                        .font(.caption).foregroundStyle(.secondary)

                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(spacing: 0) {
                    if isLoadingChannels {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    } else if channels.isEmpty {
                        Text("No channels in this community")
                            .font(.caption).foregroundStyle(.secondary)
                            .padding(.vertical, 8)
                    } else {
                        ForEach(channels) { ch in
                            NavigationLink(destination: ChannelDetailView(channelId: ch.id, channelName: ch.name)) {
                                HStack(spacing: 8) {
                                    Text("#").font(.headline).foregroundStyle(Color.rocGold.opacity(0.6))
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(ch.name).font(.subheadline)
                                        if let desc = ch.description {
                                            Text(desc).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    Text("\(ch.subscriber_count) subs")
                                        .font(.caption2).foregroundStyle(.tertiary)
                                }
                                .padding(.vertical, 4)
                                .padding(.leading, 52)
                            }
                        }
                    }

                    if role == nil && !isLoadingChannels {
                        Button {
                            Task { await join() }
                        } label: {
                            Label(joined ? "Joined" : "Join Community", systemImage: joined ? "checkmark.circle.fill" : "plus.circle")
                                .font(.caption)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(joined ? .green : .teal)
                        .controlSize(.small)
                        .disabled(joined)
                        .padding(.top, 6).padding(.leading, 52)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    @MainActor
    private func loadCommunityDetail() async {
        isLoadingChannels = true
        defer { isLoadingChannels = false }
          guard let token = SecureStorage.shared.get(forKey: "session_token")
                ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/communities/\(community.id)") else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await APIClient.shared.session.data(for: req),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        role = json["role"] as? String
        joined = role != nil
        if let arr = json["channels"] as? [[String: Any]] {
            channels = arr.compactMap { dict in
                guard let id = dict["id"] as? String, let name = dict["name"] as? String else { return nil }
                return ChannelItem(
                    id: id, name: name,
                    description: dict["description"] as? String,
                    subscriber_count: dict["subscriber_count"] as? Int ?? 0,
                    tags: dict["tags"] as? String,
                    avatar_url: dict["avatar_url"] as? String,
                    is_public: dict["is_public"] as? Bool
                )
            }
        }
    }

    private func join() async {
          guard let token = SecureStorage.shared.get(forKey: "session_token")
                ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/communities/\(community.id)/join") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let (_, resp) = try? await APIClient.shared.session.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            await MainActor.run { joined = true; role = "member" }
        }
    }
}

// MARK: - Create Channel Sheet

struct CreateChannelSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var tags = ""
    @State private var isPublic = true
    @State private var isCreating = false
    var onCreated: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                TextField("Channel Name", text: $name)
                TextField("Description", text: $description)
                TextField("Tags (comma separated)", text: $tags)
                Toggle("Public", isOn: $isPublic)
            }
            .navigationTitle("New Channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(name.count < 2 || isCreating)
                }
            }
        }
    }

    private func create() async {
        isCreating = true
          guard let token = SecureStorage.shared.get(forKey: "session_token")
                ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/channels") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["name": name, "description": description, "tags": tags, "is_public": isPublic]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let (_, resp) = try? await APIClient.shared.session.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            await MainActor.run {
                onCreated()
                dismiss()
            }
        }
        isCreating = false
    }
}
