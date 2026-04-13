/**
 * RocChat iOS — Call Views
 *
 * Full-screen overlay for voice & video calls.
 */

import SwiftUI

// MARK: - Call Overlay

struct CallOverlay: View {
    @ObservedObject var callManager = CallManager.shared

    var body: some View {
        if callManager.callStatus != .idle {
            ZStack {
                Color.black.opacity(0.85).ignoresSafeArea()

                VStack(spacing: 24) {
                    Spacer()

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
                        Text("DTLS-SRTP encrypted")
                            .font(.custom("JetBrains Mono", size: 10))
                    }
                    .foregroundColor(.turquoise)
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
            Text(formatDuration(callManager.callDuration))
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
        HStack(spacing: 28) {
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
                Text("DTLS-SRTP + E2E signaling + verification")
                    .font(.custom("JetBrains Mono", size: 10))
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
