/**
 * RocChat iOS — Call Views
 *
 * Full-screen overlay for voice & video calls.
 */

import SwiftUI

// MARK: - Call Overlay

struct CallOverlay: View {
    @ObservedObject var callManager = CallManager.shared
    @State private var showDiagnostics = false
    @State private var showParticipantsSheet = false
    @State private var showHostSheet = false

    var body: some View {
        if callManager.callStatus != .idle {
            ZStack {
                LinearGradient(
                    colors: [Color.black.opacity(0.92), Color.midnightAzure.opacity(0.88)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()

                VStack(spacing: 24) {
                    Spacer()

                    // Remote video preview (1:1 JPEG-over-WS from web/native).
                    if callManager.callType == .video,
                       callManager.callStatus == .connected {
                        if let img = callManager.remoteVideoFrame {
                            Image(uiImage: img)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxWidth: 320, maxHeight: 240)
                                .background(Color.black)
                                .cornerRadius(12)
                        } else {
                            // No video received yet — show avatar placeholder
                            ZStack {
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(Color(white: 0.08))
                                    .frame(maxWidth: 320, maxHeight: 240)
                                VStack(spacing: 8) {
                                    ZStack {
                                        Circle()
                                            .fill(Color.rocGold.opacity(0.8))
                                            .frame(width: 72, height: 72)
                                        Text(initials(callManager.remoteName))
                                            .font(.system(size: 26, weight: .bold))
                                            .foregroundColor(.black)
                                    }
                                    Text("No video")
                                        .font(.caption)
                                        .foregroundColor(.white.opacity(0.5))
                                }
                            }
                        }
                    }

                    // Avatar
                    ZStack {
                        Circle()
                            .fill(Color.rocGold.opacity(0.15))
                            .frame(width: 100, height: 100)
                        Text(initials(callManager.remoteName))
                            .font(.system(size: 36, weight: .bold))
                            .foregroundColor(.rocGold)
                    }

                    // Name
                    Text(callManager.remoteName)
                        .font(.title2.bold())
                        .foregroundColor(.white)
                        .lineLimit(1)

                    // Status text
                    statusText
                        .font(.subheadline)
                        .foregroundColor(.white.opacity(0.7))

                    Spacer()

                    // Controls
                    callControls

                    // Encryption badge
                    HStack(spacing: 4) {
                        Image(systemName: "lock.fill").font(.caption2)
                        Text("End-to-end encrypted")
                            .font(.caption2.monospaced())
                    }
                    .foregroundColor(.turquoise)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.white.opacity(0.08))
                    .clipShape(Capsule())
                    .padding(.bottom, 20)
                }
                .padding()
            }
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var statusText: some View {
        switch callManager.callStatus {
        case .incoming:
            Text("Incoming \(callManager.callType.rawValue) call...")
        case .outgoing:
            Text("Calling...")
        case .connected:
            if callManager.isGroupCall {
                Text("\(formatDuration(callManager.callDuration)) · \(callManager.groupMediaMode.uppercased()) · \(callManager.groupPeers.count + 1) participants")
            } else {
                Text(formatDuration(callManager.callDuration))
            }
        default:
            Text("")
        }
    }

    @ViewBuilder
    private var callControls: some View {
        switch callManager.callStatus {
        case .incoming:
            incomingControls
        case .outgoing, .connected:
            activeControls
        default:
            EmptyView()
        }
    }

    private var incomingControls: some View {
        HStack(spacing: 48) {
            // Accept
            Button(action: { callManager.acceptCall() }) {
                ZStack {
                    Circle().fill(Color.green).frame(width: 64, height: 64)
                    Image(systemName: "phone.fill")
                        .font(.title2)
                        .foregroundColor(.white)
                }
            }

            // Decline
            Button(action: { callManager.declineCall() }) {
                ZStack {
                    Circle().fill(Color.red).frame(width: 64, height: 64)
                    Image(systemName: "phone.down.fill")
                        .font(.title2)
                        .foregroundColor(.white)
                }
            }
        }
    }

    private var activeControls: some View {
        VStack(spacing: 12) {
            if callManager.isGroupCall {
                HStack(spacing: 8) {
                    ForEach(Array(callManager.groupPeers.keys.prefix(4)), id: \.self) { userId in
                        Text(userId.prefix(6))
                            .font(.caption2)
                            .foregroundColor(.white.opacity(0.8))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.08))
                            .clipShape(Capsule())
                    }
                }
            }
            HStack(spacing: 28) {
            if callManager.isGroupCall {
                Button(action: { callManager.toggleHandRaise() }) {
                    ZStack {
                        Circle()
                            .fill(callManager.groupHandRaised ? Color.white.opacity(0.3) : Color.white.opacity(0.1))
                            .frame(width: 52, height: 52)
                        Image(systemName: callManager.groupHandRaised ? "hand.raised.fill" : "hand.raised")
                            .font(.title3)
                            .foregroundColor(.white)
                    }
                }
            }
            // Mute
            Button(action: { callManager.toggleMute() }) {
                ZStack {
                    Circle()
                        .fill(callManager.isMuted ? Color.white.opacity(0.3) : Color.white.opacity(0.1))
                        .frame(width: 52, height: 52)
                    Image(systemName: callManager.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.title3)
                        .foregroundColor(.white)
                }
            }

            // Camera (video calls only)
            if callManager.callType == .video {
                Button(action: { callManager.toggleCamera() }) {
                    ZStack {
                        Circle()
                            .fill(callManager.isCameraOff ? Color.white.opacity(0.3) : Color.white.opacity(0.1))
                            .frame(width: 52, height: 52)
                        Image(systemName: callManager.isCameraOff ? "video.slash.fill" : "video.fill")
                            .font(.title3)
                            .foregroundColor(.white)
                    }
                }
            }

            // Hangup
            Button(action: { callManager.endCall() }) {
                ZStack {
                    Circle().fill(Color.red).frame(width: 64, height: 64)
                    Image(systemName: "phone.down.fill")
                        .font(.title2)
                        .foregroundColor(.white)
                }
            }

            // Diagnostics
            if callManager.callStatus == .connected {
                Button(action: { showDiagnostics.toggle() }) {
                    ZStack {
                        Circle()
                            .fill(showDiagnostics ? Color.white.opacity(0.3) : Color.white.opacity(0.1))
                            .frame(width: 52, height: 52)
                        Image(systemName: "waveform.path.ecg")
                            .font(.title3)
                            .foregroundColor(.white)
                    }
                }
                .sheet(isPresented: $showDiagnostics) {
                    CallDiagnosticsView()
                }
            }
            }
            if callManager.isGroupCall &&
                (UserDefaults.standard.string(forKey: "user_id") ?? "") == callManager.groupHostUserId {
                HStack(spacing: 12) {
                    Button("Participants") { showParticipantsSheet = true }
                        .buttonStyle(.bordered)
                    Button("Mute all") { callManager.hostMuteAll() }
                        .buttonStyle(.borderedProminent)
                    Button(callManager.groupRoomLocked ? "Unlock room" : "Lock room") {
                        callManager.toggleGroupRoomLock()
                    }
                    .buttonStyle(.bordered)
                    Button("Moderation") { showHostSheet = true }
                        .buttonStyle(.bordered)
                }
            } else if callManager.isGroupCall {
                Button("Participants") { showParticipantsSheet = true }
                    .buttonStyle(.bordered)
            }
        }
        .sheet(isPresented: $showParticipantsSheet) {
            NavigationStack {
                List {
                    Text("You")
                    ForEach(Array(callManager.groupPeers.keys), id: \.self) { userId in
                        HStack {
                            Text(userId)
                            if userId == callManager.groupHostUserId { Text("Host").foregroundColor(.rocGold) }
                        }
                    }
                }
                .navigationTitle("Participants")
            }
        }
        .sheet(isPresented: $showHostSheet) {
            NavigationStack {
                VStack(spacing: 12) {
                    Text("Host Moderation").font(.headline)
                    Button("Mute all participants") { callManager.hostMuteAll() }
                        .buttonStyle(.borderedProminent)
                    Button(callManager.groupRoomLocked ? "Unlock room" : "Lock room") {
                        callManager.toggleGroupRoomLock()
                    }
                    .buttonStyle(.bordered)
                    Button("Admit lobby users") {
                        // Placeholder for upcoming lobby admit flow.
                    }
                    .buttonStyle(.bordered)
                    Spacer()
                }
                .padding()
                .navigationTitle("Host Tools")
            }
        }
    }

    private func initials(_ name: String) -> String {
        name.split(separator: " ").compactMap { $0.first.map(String.init) }.prefix(2).joined().uppercased()
    }

    private func formatDuration(_ seconds: Int) -> String {
        String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

// MARK: - Calls History View (for tab)

struct CallsHistoryView: View {
    @ObservedObject var callManager = CallManager.shared

    var body: some View {
        NavigationStack {
            Group {
                if callManager.callHistory.isEmpty {
                    emptyState
                } else {
                    historyList
                }
            }
            .navigationTitle("Calls")
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "phone.fill")
                .font(.system(size: 40))
                .foregroundColor(.rocGold.opacity(0.3))
            Text("No recent calls")
                .font(.headline)
                .foregroundColor(.textSecondary)
            Text("Voice and video calls are end-to-end encrypted with 3-layer protection.")
                .font(.subheadline)
                .foregroundColor(.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            HStack(spacing: 4) {
                Image(systemName: "lock.fill").font(.caption2)
                Text("E2E encrypted · AES-256-GCM")
                    .font(.caption2.monospaced())
            }
            .foregroundColor(.turquoise)
            Spacer()
        }
    }

    private var historyList: some View {
        List(callManager.callHistory) { record in
            HStack(spacing: 12) {
                // Avatar
                ZStack {
                    Circle()
                        .fill(Color.rocGold.opacity(0.12))
                        .frame(width: 40, height: 40)
                    Text(initials(record.remoteName))
                        .font(.caption.bold())
                        .foregroundColor(.rocGold)
                }

                // Info
                VStack(alignment: .leading, spacing: 2) {
                    Text(record.remoteName)
                        .font(.subheadline.bold())
                        .foregroundColor(.textPrimary)
                    HStack(spacing: 4) {
                        Image(systemName: record.direction == "incoming" ? "arrow.down.left" : "arrow.up.right")
                            .font(.caption2)
                            .foregroundColor(record.status == "missed" ? .red : .textSecondary)
                        Text("\(record.callType.rawValue) · \(record.status == "completed" ? formatDuration(record.duration) : record.status)")
                            .font(.caption)
                            .foregroundColor(record.status == "missed" ? .red : .textSecondary)
                    }
                }

                Spacer()

                // Call type icon
                Image(systemName: record.callType == .video ? "video.fill" : "phone.fill")
                    .font(.caption)
                    .foregroundColor(.rocGold)
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.plain)
    }

    private func initials(_ name: String) -> String {
        name.split(separator: " ").compactMap { $0.first.map(String.init) }.prefix(2).joined().uppercased()
    }

    private func formatDuration(_ seconds: Int) -> String {
        String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

// MARK: - Call Diagnostics Sheet

struct CallDiagnosticsView: View {
    @ObservedObject var callManager = CallManager.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Connection") {
                    diagRow(label: "Call Type", value: callManager.callType.rawValue.capitalized)
                    diagRow(label: "Duration", value: formatDuration(callManager.callDuration))
                    diagRow(label: "Estimated RTT", value: String(format: "%.0f ms", callManager.estimatedRttMs))
                }
                if callManager.callType == .video {
                    Section("Video") {
                        diagRow(label: "Target FPS", value: String(format: "%.0f fps", callManager.diagFps))
                        diagRow(label: "JPEG Quality", value: String(format: "%.0f%%", callManager.diagQuality * 100))
                    }
                }
                Section("Voice") {
                    diagRow(label: "Jitter (EMA)", value: String(format: "%.1f ms", callManager.diagAudioJitterMs))
                    diagRow(label: "Late frames", value: String(callManager.diagAudioLateFrames))
                }
                Section("Transport") {
                    diagRow(label: "Media relay", value: "WebSocket (RocChat relay)")
                    diagRow(label: "Encryption", value: "AES-256-GCM")
                }
            }
            .navigationTitle("Call Diagnostics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func diagRow(label: String, value: String) -> some View {
        HStack {
            Text(label).foregroundColor(.secondary)
            Spacer()
            Text(value).font(.footnote.monospaced())
        }
    }

    private func formatDuration(_ seconds: Int) -> String {
        String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}
