import SwiftUI

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
        guard let token = UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)\(path)") else { return nil }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try? await URLSession.shared.data(for: req).0
    }
}

// MARK: - Channel Row

struct ChannelRow: View {
    let channel: ChannelItem
    @State private var subscribed = false

    var body: some View {
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

            if subscribed {
                Label("Subscribed", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                Button("Join") { Task { await subscribe() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.rocGold)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    private func subscribe() async {
        guard let token = UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/channels/\(channel.id)/subscribe") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            await MainActor.run { subscribed = true }
        }
    }
}

// MARK: - Community Row

struct CommunityRow: View {
    let community: CommunityItem
    @State private var joined = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.3.fill")
                .font(.title3)
                .foregroundStyle(.teal)
                .frame(width: 40, height: 40)
                .background(Color.teal.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(community.name).font(.headline)
                if let desc = community.description {
                    Text(desc).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }

            Spacer()

            if joined {
                Label("Joined", systemImage: "checkmark.circle.fill")
                    .font(.caption).foregroundStyle(.green)
            } else {
                Button("Join") { Task { await join() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.teal)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    private func join() async {
        guard let token = UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/communities/\(community.id)/join") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            await MainActor.run { joined = true }
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
        guard let token = UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/channels") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["name": name, "description": description, "tags": tags, "is_public": isPublic]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            await MainActor.run {
                onCreated()
                dismiss()
            }
        }
        isCreating = false
    }
}
