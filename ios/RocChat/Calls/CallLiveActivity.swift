import ActivityKit
import SwiftUI

// MARK: - Live Activity Attributes

@available(iOS 16.2, *)
struct CallActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var callerName: String
        var isVideoCall: Bool
        var durationSeconds: Int
    }
    var callId: String
}

// MARK: - Live Activity Manager

@available(iOS 16.2, *)
final class CallLiveActivityManager: ObservableObject {
    static let shared = CallLiveActivityManager()
    private var activity: Activity<CallActivityAttributes>?

    func startCallActivity(callId: String, callerName: String, isVideo: Bool) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = CallActivityAttributes(callId: callId)
        let state = CallActivityAttributes.ContentState(
            callerName: callerName,
            isVideoCall: isVideo,
            durationSeconds: 0
        )
        do {
            activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: .distantFuture),
                pushType: nil
            )
        } catch { /* Live Activity unavailable */ }
    }

    func updateCallDuration(_ seconds: Int) {
        guard let activity else { return }
        let updatedState = CallActivityAttributes.ContentState(
            callerName: activity.content.state.callerName,
            isVideoCall: activity.content.state.isVideoCall,
            durationSeconds: seconds
        )
        Task { await activity.update(.init(state: updatedState, staleDate: .distantFuture)) }
    }

    func endCallActivity() {
        Task {
            await activity?.end(.init(state: activity!.content.state, staleDate: Date()), dismissalPolicy: .immediate)
            activity = nil
        }
    }
}

// MARK: - Live Activity Widget View (for WidgetKit extension)
// To show in Dynamic Island, add a WidgetBundle extension target and reference
// CallActivityWidget from there. The view below is the compact / expanded layout.

@available(iOS 16.2, *)
struct CallActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CallActivityAttributes.self) { context in
            // Lock-screen / banner view
            HStack {
                Image(systemName: context.state.isVideoCall ? "video.fill" : "phone.fill")
                    .foregroundStyle(.green)
                Text(context.state.callerName)
                    .font(.headline)
                Spacer()
                Text(formatDuration(context.state.durationSeconds))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: context.state.isVideoCall ? "video.fill" : "phone.fill")
                        .foregroundStyle(.green)
                        .font(.title2)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.callerName)
                        .font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(formatDuration(context.state.durationSeconds))
                        .font(.subheadline.monospacedDigit())
                }
            } compactLeading: {
                Image(systemName: context.state.isVideoCall ? "video.fill" : "phone.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            } compactTrailing: {
                Text(formatDuration(context.state.durationSeconds))
                    .font(.caption.monospacedDigit())
            } minimal: {
                Image(systemName: "phone.fill")
                    .foregroundStyle(.green)
                    .font(.caption2)
            }
        }
    }

    private func formatDuration(_ seconds: Int) -> String {
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%d:%02d", m, s)
    }
}
