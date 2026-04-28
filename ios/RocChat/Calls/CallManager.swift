/**
 * RocChat iOS — Call Manager
 *
 * WebRTC voice & video calls with:
 * - Peer connection management (STUN/TURN)
 * - Signaling via WebSocket (Durable Object relay)
 * - E2E encrypted signaling (Double Ratchet)
 * - Media capture (mic + camera via AVFoundation)
 * - Call state machine (idle → outgoing/incoming → connected → ended)
 *
 * Uses native Apple frameworks only — no third-party dependencies.
 */

import Foundation
@preconcurrency import AVFoundation
import CryptoKit
import Combine
import UIKit

// MARK: - Call State

enum CallStatus: String {
    case idle, outgoing, incoming, connected, ended
}

enum CallType: String, Codable {
    case voice, video
}

struct CallRecord: Codable, Identifiable {
    let id: String
    let remoteName: String
    let remoteUserId: String
    let callType: CallType
    let direction: String // "incoming" or "outgoing"
    let status: String   // "completed" or "missed"
    let duration: Int
    let timestamp: Date
}

// MARK: - Group Peer

struct GroupPeer {
    let userId: String
    var transport: P2PTransport?
    var connected: Bool
}

// MARK: - CallManager

@MainActor
class CallManager: ObservableObject {
    static let shared = CallManager()

    @Published var callStatus: CallStatus = .idle
    @Published var callType: CallType = .voice
    @Published var remoteName: String = ""
    @Published var remoteUserId: String = ""
    @Published var isMuted: Bool = false
    @Published var isCameraOff: Bool = false
    @Published var callDuration: Int = 0
    @Published var callHistory: [CallRecord] = []

    /// Diagnostics metrics (updated by adaptVideoQuality)
    @Published var diagFps: Double = 8
    @Published var diagQuality: CGFloat = 0.55
    @Published var diagAudioJitterMs: Double = 0
    @Published var diagAudioLateFrames: Int = 0

    /// Latest decoded JPEG frame from the remote peer (for SwiftUI rendering).
    @Published var remoteVideoFrame: UIImage? = nil

    // Group call state
    @Published var isGroupCall: Bool = false
    @Published var groupPeers: [String: GroupPeer] = [:] // userId → peer
    @Published var groupParticipants: [String] = []
    @Published var groupHostUserId: String = ""
    @Published var groupRoomLocked: Bool = false
    @Published var groupMediaMode: String = "mesh"
    @Published var groupHandRaised: Bool = false
    private let maxMeshPeers = 5 // 6 total including self

    private var callId: String?
    private var conversationId: String?
    private var ws: URLSessionWebSocketTask?
    private var startTime: Date?
    private var durationTimer: Timer?
    private var pendingSdp: String?

    // RocP2P — direct UDP + AES-GCM. Falls back to WS relay after 3 s.
    private var p2p: P2PTransport?
    private var p2pConnected: Bool = false
    private var p2pFallbackTimer: Timer?
    private var isCallInitiator: Bool = false

    // WebRTC (using AVFoundation for audio as baseline)
    private var audioPlayer: AVAudioPlayer?

    // Voice-over-WebSocket audio engine (no third-party — pure AVFoundation)
    // 16 kHz mono PCM Int16 frames, base64-encoded, E2E-encrypted via Double Ratchet
    private var audioEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var audioSeq: UInt64 = 0
    private var lastInboundAudioAtMs: Double? = nil
    private let audioSampleRate: Double = 16000
    private let audioFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    // Video-over-WebSocket: AVCaptureSession → JPEG @ adaptive fps, 320×240,
    // base64'd into call_video frames. Matches web's VideoWS wire format.
    private var videoCapture: AVCaptureSession?
    private var videoOutput: AVCaptureVideoDataOutput?
    private let videoQueue = DispatchQueue(label: "rocchat.video.capture", qos: .userInteractive)
    private var videoSeq: UInt64 = 0
    private var lastVideoSendAt: TimeInterval = 0
    private var videoTargetFps: Double = 8
    private var videoJpegQuality: CGFloat = 0.55

    // RTT measurement for adaptive quality
    private var pingTs: TimeInterval? = nil
    @Published var estimatedRttMs: Double = 150
    private var pingTimer: Timer? = nil

    // Independent STUN servers — no Google, no surveillance
    private let iceServers = [
        "stun:stun.stunprotocol.org:3478",
        "stun:stun.nextcloud.com:3478"
    ]

    private init() {
        loadHistory()
    }

    // MARK: - Outgoing Call

    func startCall(conversationId: String, remoteUserId: String, remoteName: String,
                   callType: CallType, ws: URLSessionWebSocketTask?) {
        guard callStatus == .idle else { return }

        self.callId = UUID().uuidString
        self.conversationId = conversationId
        self.remoteUserId = remoteUserId
        self.remoteName = remoteName
        self.callType = callType
        self.callStatus = .outgoing
        self.ws = ws
        self.isCallInitiator = true

        configureAudioSession()
        startP2P(isInitiator: true)
        sendEncryptedSignal(type: "call_offer", extra: [
            "callId": callId ?? "",
            "callType": callType.rawValue,
            "targetUserId": remoteUserId,
            "timestamp": "\(Int(Date().timeIntervalSince1970 * 1000))"
        ])

        // Auto-timeout after 30 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            if self?.callStatus == .outgoing {
                self?.endCall(reason: "timeout")
            }
        }
    }

    // MARK: - Incoming Call

    func handleIncomingOffer(payload: [String: Any], conversationId: String, ws: URLSessionWebSocketTask?) {
        let signalWs = ws ?? InboxWebSocket.shared.task
        guard callStatus == .idle, let signalWs = signalWs else {
            // Busy — reject
            if let callId = payload["callId"] as? String, let from = payload["fromUserId"] as? String {
                sendSignal(type: "call_end", extra: ["callId": callId, "reason": "busy", "targetUserId": from])
            }
            return
        }

        let decrypted = decryptSignaling(payload, conversationId: conversationId)

        self.callId = decrypted["callId"] as? String
        self.conversationId = conversationId
        self.remoteUserId = (decrypted["fromUserId"] as? String) ?? (payload["fromUserId"] as? String) ?? ""
        self.remoteName = String(self.remoteUserId.prefix(8))
        self.callType = CallType(rawValue: (decrypted["callType"] as? String) ?? "voice") ?? .voice
        self.callStatus = .incoming
        self.ws = signalWs
        self.pendingSdp = decrypted["sdp"] as? String

        configureAudioSession()

        // Auto-timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            if self?.callStatus == .incoming {
                self?.endCall(reason: "timeout")
            }
        }
    }

    func acceptCall() {
        guard callStatus == .incoming else { return }
        callStatus = .connected
        startTime = Date()
        startDurationTimer()

        startP2P(isInitiator: false)
        sendEncryptedSignal(type: "call_answer", extra: [
            "callId": callId ?? "",
            "targetUserId": remoteUserId
        ])
        startAudioStreaming()
        if callType == .video {
            startVideoStreaming()
            pingTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.sendVideoPing() }
            }
        }
    }

    func declineCall() {
        endCall(reason: "declined")
    }

    // MARK: - Call Answer / ICE Handling

    func handleCallAnswer(payload: [String: Any]) {
        let decrypted = decryptSignaling(payload)
        guard callId == decrypted["callId"] as? String else { return }
        callStatus = .connected
        startTime = Date()
        startDurationTimer()
        startAudioStreaming()
        if callType == .video {
            startVideoStreaming()
            pingTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.sendVideoPing() }
            }
        }
    }

    func handleIceCandidate(payload: [String: Any]) {
        let decrypted = decryptSignaling(payload)
        guard callId == decrypted["callId"] as? String else { return }
        // Would add ICE candidate to RTCPeerConnection
    }

    func handleCallEnd(payload: [String: Any]) {
        let decrypted = decryptSignaling(payload)
        guard callId == decrypted["callId"] as? String else { return }
        endCall(reason: (decrypted["reason"] as? String) ?? "hangup", notify: false)
    }

    // MARK: - Controls

    func toggleMute() {
        isMuted.toggle()
        // With WebRTC: toggle audio track enabled
    }

    func toggleCamera() {
        isCameraOff.toggle()
        if isCameraOff {
            stopVideoStreaming()
        } else if callStatus == .connected && callType == .video {
            startVideoStreaming()
        }
    }

    func endCall(reason: String = "hangup", notify: Bool = true) {
        if notify, let callId = callId {
            sendEncryptedSignal(type: "call_end", extra: [
                "callId": callId,
                "reason": reason,
                "targetUserId": remoteUserId,
                "duration": "\(callDuration)"
            ])
        }

        // Record call
        if let callId = callId {
            let record = CallRecord(
                id: callId,
                remoteName: remoteName,
                remoteUserId: remoteUserId,
                callType: callType,
                direction: callStatus == .incoming ? "incoming" : "outgoing",
                status: startTime != nil ? "completed" : "missed",
                duration: callDuration,
                timestamp: Date()
            )
            callHistory.insert(record, at: 0)
            if callHistory.count > 100 { callHistory = Array(callHistory.prefix(100)) }
            saveHistory()
        }

        // Clean up
        durationTimer?.invalidate()
        durationTimer = nil
        pingTimer?.invalidate()
        pingTimer = nil
        pingTs = nil
        stopAudioStreaming()
        stopVideoStreaming()
        stopP2P()
        callId = nil
        conversationId = nil
        remoteUserId = ""
        remoteName = ""
        callStatus = .idle
        startTime = nil
        callDuration = 0
        isMuted = false
        isCameraOff = false
        pendingSdp = nil
        remoteVideoFrame = nil

        deactivateAudioSession()
    }

    // MARK: - Private

    private func sendSignal(type: String, extra: [String: String]) {
        let payload = extra
        let message: [String: Any] = ["type": type, "payload": payload]
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let str = String(data: data, encoding: .utf8) else { return }
        ws?.send(.string(str)) { _ in }
    }

    private func sendEncryptedSignal(type: String, extra: [String: String]) {
        guard let convId = conversationId, !remoteUserId.isEmpty else {
            sendSignal(type: type, extra: extra)
            return
        }
        let callId = extra["callId"] ?? ""
        let targetUserId = extra["targetUserId"] ?? ""
        var sensitiveData = extra
        sensitiveData.removeValue(forKey: "targetUserId")
        sensitiveData.removeValue(forKey: "callId")

        Task {
            do {
                let plaintext = String(data: try JSONSerialization.data(withJSONObject: sensitiveData), encoding: .utf8)!
                let envelope = try await SessionManager.shared.encryptMessage(
                    conversationId: convId, recipientUserId: remoteUserId, plaintext: plaintext
                )
                let encryptedSignaling: [String: Any] = [
                    "ciphertext": envelope.ciphertext,
                    "iv": envelope.iv,
                    "ratchet_header": envelope.ratchetHeader
                ]
                // conversationId rides in cleartext so the recipient can find
                // the pairwise ratchet session even when the message arrives
                // over the user-inbox WS (not conversation-scoped).
                let payload: [String: Any] = [
                    "callId": callId,
                    "targetUserId": targetUserId,
                    "conversationId": convId,
                    "encryptedSignaling": encryptedSignaling
                ]
                let message: [String: Any] = ["type": type, "payload": payload]
                // Prefer the inbox WS so the call reaches the callee even if
                // they don't have this conversation open.
                if InboxWebSocket.shared.send(message) { return }
                guard let data = try? JSONSerialization.data(withJSONObject: message),
                      let str = String(data: data, encoding: .utf8) else { return }
                ws?.send(.string(str)) { _ in }
            } catch {
                print("[CallManager] encrypted signaling failed, dropping signal: \(error)")
                return
            }
        }
    }

    private func decryptSignaling(_ payload: [String: Any], conversationId overrideConvId: String? = nil) -> [String: Any] {
        guard let encSig = payload["encryptedSignaling"] as? [String: Any],
              let ct = encSig["ciphertext"] as? String,
              let iv = encSig["iv"] as? String,
              let rh = encSig["ratchet_header"] as? String else {
            return payload // plaintext fallback
        }
        // Resolve conversationId in priority order: explicit override
        // (ChatRoom path), cleartext field on payload (inbox-WS path),
        // current call state.
        let cleartextConv = (payload["conversationId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        guard let convId = overrideConvId ?? cleartextConv ?? conversationId else {
            return payload
        }
        do {
            let decrypted = try SessionManager.shared.decryptMessage(
                conversationId: convId, ciphertext: ct, iv: iv, ratchetHeaderStr: rh
            )
            if let data = decrypted.data(using: .utf8),
               var result = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                result["callId"] = payload["callId"]
                result["targetUserId"] = payload["targetUserId"]
                result["fromUserId"] = payload["fromUserId"]
                result["conversationId"] = convId
                return result
            }
        } catch { /* fallback */ }
        return payload
    }

    private func configureAudioSession() {
        // Lazily access AVAudioSession to avoid startup-time I/O during singleton init.
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? audioSession.setActive(true)
    }

    private func deactivateAudioSession() {
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startDurationTimer() {
        durationTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self = self, let start = self.startTime else { return }
                self.callDuration = Int(Date().timeIntervalSince(start))
            }
        }
    }

    private func loadHistory() {
        guard let data = UserDefaults.standard.data(forKey: "rocchat_call_history"),
              let history = try? JSONDecoder().decode([CallRecord].self, from: data) else { return }
        callHistory = history
    }

    private func saveHistory() {
        guard let data = try? JSONEncoder().encode(callHistory) else { return }
        UserDefaults.standard.set(data, forKey: "rocchat_call_history")
    }

    // MARK: - Voice-over-WebSocket Audio Engine

    private func startAudioStreaming() {
        // Voice-only for now; video is UI-only until native media stack ships
        guard callType == .voice || callType == .video else { return }
        guard audioEngine == nil else { return }

        diagAudioJitterMs = 0
        diagAudioLateFrames = 0
        lastInboundAudioAtMs = nil

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)

        // Playback path: player -> mainMixer
        engine.connect(player, to: engine.mainMixerNode, format: audioFormat)

        // Capture path: inputNode tap
        let inputNode = engine.inputNode
        let hwFormat = inputNode.outputFormat(forBus: 0)
        let targetFormat = audioFormat
        let converter = AVAudioConverter(from: hwFormat, to: targetFormat)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { [weak self] buffer, _ in
            guard let self = self, !self.isMuted else { return }
            guard let converter = converter else { return }
            let outCapacity = AVAudioFrameCount(targetFormat.sampleRate * Double(buffer.frameLength) / hwFormat.sampleRate) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outCapacity) else { return }
            var error: NSError?
            var supplied = false
            let status = converter.convert(to: out, error: &error) { _, outStatus in
                if supplied {
                    outStatus.pointee = .noDataNow
                    return nil
                }
                supplied = true
                outStatus.pointee = .haveData
                return buffer
            }
            if status == .error || error != nil { return }
            guard let channelData = out.int16ChannelData?[0] else { return }
            let byteCount = Int(out.frameLength) * MemoryLayout<Int16>.size
            let data = Data(bytes: channelData, count: byteCount)
            self.sendAudioFrame(data: data)
        }

        do {
            try engine.start()
            player.play()
            self.audioEngine = engine
            self.playerNode = player
        } catch {
            self.audioEngine = nil
            self.playerNode = nil
        }
    }

    private func stopAudioStreaming() {
        // Tear down in strict reverse order: stop player → remove tap → detach
        // nodes → stop engine → deactivate session. Skipping any of these has
        // caused the engine to keep the mic LED on / the session to linger.
        playerNode?.stop()
        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            if let player = playerNode { engine.detach(player) }
            engine.stop()
            engine.reset()
        }
        audioEngine = nil
        playerNode = nil
        audioSeq = 0
        lastInboundAudioAtMs = nil
        // Best-effort: release the shared audio session so Bluetooth / Now
        // Playing / Silent switch return to their prior state.
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func sendAudioFrame(data: Data) {
        guard let callId = callId, !remoteUserId.isEmpty else { return }
        // μ-law encode + 1-byte codec tag: [0x01 | mulaw-bytes]. 2× compression.
        var payload = Data([0x01])
        payload.append(MuLaw.encode(pcm16: data))
        // Prefer the direct P2P path once it's connected — WS relay is fallback only.
        if p2pConnected, let p2p = p2p {
            p2p.sendAudio(payload)
            return
        }
        audioSeq &+= 1
        let b64 = payload.base64EncodedString()
        let msg: [String: Any] = [
            "type": "call_audio",
            "payload": [
                "callId": callId,
                "targetUserId": remoteUserId,
                "seq": audioSeq,
                "frame": b64
            ]
        ]
        // Prefer the inbox WS — when both peers are on it, frames arrive
        // regardless of which conversation either side has open.
        if InboxWebSocket.shared.send(msg) { return }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: jsonData, encoding: .utf8) else { return }
        ws?.send(.string(str)) { _ in }
    }

    /// Decode an inbound audio payload that may be μ-law (0x01) or PCM16 (0x00 / legacy).
    private func decodeInboundAudio(_ payload: Data) -> Data {
        guard let first = payload.first else { return payload }
        if first == 0x01 {
            return MuLaw.decode(mulaw: payload.dropFirst())
        }
        if first == 0x00 {
            return payload.dropFirst()
        }
        return payload // legacy: raw PCM16, no tag
    }

    private func trackInboundAudioTiming(expectedFrameMs: Double = 20) {
        let nowMs = CACurrentMediaTime() * 1000
        if let last = lastInboundAudioAtMs {
            let delta = nowMs - last
            let jitterSample = abs(delta - expectedFrameMs)
            diagAudioJitterMs = diagAudioJitterMs * 0.85 + jitterSample * 0.15
            if delta > 60 { diagAudioLateFrames += 1 }
        }
        lastInboundAudioAtMs = nowMs
    }

    func handleCallAudio(payload: [String: Any]) {
        guard callStatus == .connected,
              let frameB64 = payload["frame"] as? String,
              let incomingCallId = payload["callId"] as? String,
              incomingCallId == callId,
              let raw = Data(base64Encoded: frameB64),
              let player = playerNode else { return }
          trackInboundAudioTiming()
        let data = decodeInboundAudio(raw)
        let frameCount = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: frameCount),
              let channel = buffer.int16ChannelData?[0] else { return }
        buffer.frameLength = frameCount
        data.withUnsafeBytes { raw in
            if let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self) {
                channel.update(from: src, count: Int(frameCount))
            }
        }
        player.scheduleBuffer(buffer, completionHandler: nil)
    }

    // MARK: - Video Streaming (1:1, JPEG-over-WS)

    /// Start front-camera capture, throttled to ~8 fps. Each frame is
    /// scaled to 320×240, JPEG-encoded at quality 0.55, tagged with 0x01,
    /// base64'd, and shipped as `call_video` over the existing WS. This
    /// matches the web VideoWS wire format so calls interop cross-platform.
    private func startVideoStreaming() {
        guard videoCapture == nil else { return }
        let session = AVCaptureSession()
        session.sessionPreset = .vga640x480
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self.videoDelegate, queue: videoQueue)
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        if let conn = output.connection(with: .video) {
            if #available(iOS 17.0, *) {
                conn.videoRotationAngle = 90
            } else {
                conn.videoOrientation = .portrait
            }
            if device.position == .front { conn.isVideoMirrored = true }
        }
        videoCapture = session
        videoOutput = output
        session.startRunning()
    }

    private func stopVideoStreaming() {
        if let session = videoCapture {
            session.stopRunning()
        }
        videoCapture = nil
        videoOutput = nil
        videoSeq = 0
        lastVideoSendAt = 0
    }

    /// Lazily-created delegate that forwards AVFoundation callbacks back
    /// into the actor-isolated CallManager. NSObject-conforming because
    /// AVCaptureVideoDataOutputSampleBufferDelegate is an ObjC protocol.
    private lazy var videoDelegate: VideoCaptureDelegate = VideoCaptureDelegate { [weak self] sampleBuffer in
        self?.handleCapturedFrame(sampleBuffer)
    }

    private nonisolated func handleCapturedFrame(_ sampleBuffer: CMSampleBuffer) {
        // FPS throttle — we're aiming for ~8 fps on the wire.
        let now = CACurrentMediaTime()
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            if self.isCameraOff { return }
            if now - self.lastVideoSendAt < 1.0 / self.videoTargetFps { return }
            self.lastVideoSendAt = now
            guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            guard let jpeg = Self.jpegFromPixelBuffer(pb, maxWidth: 320, maxHeight: 240, quality: self.videoJpegQuality) else { return }
            self.sendVideoFrame(jpeg: jpeg)
        }
    }

    private nonisolated static func jpegFromPixelBuffer(_ pb: CVPixelBuffer, maxWidth: Int, maxHeight: Int, quality: CGFloat) -> Data? {
        let ci = CIImage(cvPixelBuffer: pb)
        let w = CGFloat(CVPixelBufferGetWidth(pb))
        let h = CGFloat(CVPixelBufferGetHeight(pb))
        let scale = min(CGFloat(maxWidth) / w, CGFloat(maxHeight) / h, 1.0)
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext(options: nil)
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        let ui = UIImage(cgImage: cg)
        return ui.jpegData(compressionQuality: quality)
    }

    private func sendVideoFrame(jpeg: Data) {
        guard let callId = callId, !remoteUserId.isEmpty else { return }
        videoSeq &+= 1
        var tagged = Data([0x01])
        tagged.append(jpeg)
        let payload: [String: Any] = [
            "callId": callId,
            "targetUserId": remoteUserId,
            "seq": videoSeq,
            "frame": tagged.base64EncodedString()
        ]
        let msg: [String: Any] = ["type": "call_video", "payload": payload]
        // Prefer the inbox WS so the call works across conversations.
        if InboxWebSocket.shared.send(msg) { return }
        guard let ws = ws,
              let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }
        ws.send(.string(str)) { _ in }
    }

    func sendVideoPing() {
        guard let callId = callId else { return }
        let ts = CACurrentMediaTime()
        pingTs = ts
        let tsStr = String(format: "%.3f", ts)
        let payload: [String: Any] = ["callId": callId, "targetUserId": remoteUserId, "seq": 0, "frame": "roc-ping:\(tsStr)"]
        let msg: [String: Any] = ["type": "call_video", "payload": payload]
        if InboxWebSocket.shared.send(msg) { return }
        guard let ws = ws,
              let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }
        ws.send(.string(str)) { _ in }
    }

    private func adaptVideoQuality() {
        if estimatedRttMs < 80 {
            videoTargetFps = 12; videoJpegQuality = 0.65
        } else if estimatedRttMs < 200 {
            videoTargetFps = 8; videoJpegQuality = 0.55
        } else {
            videoTargetFps = 4; videoJpegQuality = 0.30
        }
        diagFps = videoTargetFps
        diagQuality = videoJpegQuality
    }

    /// Inbound `call_video` frame from web or another native peer. Tag 0x01
    /// is the only format currently emitted; we decode the JPEG and publish
    /// it for the SwiftUI layer to render.
    func handleCallVideo(payload: [String: Any]) {
        guard callStatus == .connected,
              let frameB64 = payload["frame"] as? String,
              let incomingCallId = payload["callId"] as? String,
              incomingCallId == callId else { return }
        // Handle ping/pong for RTT measurement
        if frameB64.hasPrefix("roc-ping:") {
            let tsStr = String(frameB64.dropFirst(9))
            guard let callId = callId, let ws = ws else { return }
            let pong: [String: Any] = ["callId": callId, "targetUserId": remoteUserId, "seq": 0, "frame": "roc-pong:\(tsStr)"]
            if let data = try? JSONSerialization.data(withJSONObject: ["type": "call_video", "payload": pong]),
               let str = String(data: data, encoding: .utf8) { ws.send(.string(str)) { _ in } }
            return
        }
        if frameB64.hasPrefix("roc-pong:"), let sentAt = pingTs {
            estimatedRttMs = (CACurrentMediaTime() - sentAt) * 1000
            pingTs = nil
            adaptVideoQuality()
            return
        }
        guard var raw = Data(base64Encoded: frameB64), !raw.isEmpty else { return }
        let tag = raw.removeFirst()
        guard tag == 0x01 else { return }
        if let img = UIImage(data: raw) {
            self.remoteVideoFrame = img
        }
    }

    // MARK: - Group Calls (Mesh)

    func startGroupCall(conversationId: String, callType: CallType, ws: URLSessionWebSocketTask, members: [String]) {
        guard callStatus == .idle else { return }

        self.callId = UUID().uuidString
        self.conversationId = conversationId
        self.callType = callType
        self.callStatus = .connected
        self.ws = ws
        self.isGroupCall = true
        self.groupPeers = [:]
        self.groupParticipants = []
        self.groupHostUserId = UserDefaults.standard.string(forKey: "user_id") ?? ""
        self.groupRoomLocked = false
        self.groupMediaMode = members.count > 2 ? "sfu" : "mesh"
        self.groupHandRaised = false
        self.startTime = Date()

        configureAudioSession()
        startAudioStreaming()
        startDurationTimer()

        // Broadcast group_call_start
        sendGroupSignal(type: "group_call_start", extra: [
            "callId": callId ?? "",
            "callType": callType.rawValue,
            "conversationId": conversationId,
            "mode": groupMediaMode
        ])
    }

    func handleGroupCallStart(payload: [String: Any], conversationId: String, ws: URLSessionWebSocketTask?) {
        guard callStatus == .idle, let ws = ws else { return }
        let decrypted = decryptSignaling(payload, conversationId: conversationId)
        let fromUserId = (payload["fromUserId"] as? String) ?? ""

        self.callId = (decrypted["callId"] as? String) ?? (payload["callId"] as? String)
        self.conversationId = conversationId
        self.callType = CallType(rawValue: (decrypted["callType"] as? String) ?? "voice") ?? .voice
        self.callStatus = .connected
        self.ws = ws
        self.isGroupCall = true
        self.groupPeers = [:]
        self.groupParticipants = []
        self.groupHostUserId = fromUserId
        self.groupRoomLocked = false
        self.groupMediaMode = (decrypted["mode"] as? String) ?? "mesh"
        self.groupHandRaised = false
        self.startTime = Date()

        configureAudioSession()
        startAudioStreaming()
        startDurationTimer()

        // Send join signal
        sendGroupSignal(type: "group_call_join", extra: [
            "callId": callId ?? "",
            "conversationId": conversationId
        ])

        // Create P2P connection to initiator
        addGroupPeer(userId: fromUserId, isInitiator: shouldBeInitiator(remoteUserId: fromUserId))
    }

    func handleGroupCallJoin(payload: [String: Any]) {
        guard isGroupCall, callStatus == .connected else { return }
        let userId = (payload["fromUserId"] as? String) ?? ""
        guard !userId.isEmpty, groupPeers[userId] == nil else { return }
        guard groupPeers.count < maxMeshPeers else { return }
        groupParticipants.append(userId)
        addGroupPeer(userId: userId, isInitiator: shouldBeInitiator(remoteUserId: userId))
    }

    func handleGroupCallLeave(payload: [String: Any]) {
        let userId = (payload["fromUserId"] as? String) ?? ""
        guard let peer = groupPeers[userId] else { return }
        peer.transport?.stop()
        groupPeers.removeValue(forKey: userId)
        groupParticipants.removeAll { $0 == userId }
        if groupPeers.isEmpty {
            endGroupCall(notify: false)
        }
    }

    func handleGroupCallOffer(payload: [String: Any]) {
        guard isGroupCall, let convId = conversationId else { return }
        _ = decryptSignaling(payload, conversationId: convId)
        let fromId = (payload["fromUserId"] as? String) ?? ""
        // Group calls use P2P transport, not WebRTC SDP — but we handle the signaling
        if groupPeers[fromId] == nil {
            addGroupPeer(userId: fromId, isInitiator: false)
        }
    }

    func handleGroupCallAnswer(payload: [String: Any]) {
        // P2P connections handle this at the transport level
    }

    func handleGroupCallIce(payload: [String: Any]) {
        guard isGroupCall else { return }
        let fromId = (payload["fromUserId"] as? String) ?? ""
        guard let peer = groupPeers[fromId] else { return }
        let decrypted = decryptSignaling(payload)
        guard let type = decrypted["candidateType"] as? String,
              let host = decrypted["host"] as? String,
              let port = decrypted["port"] as? Int else { return }
        let kind: P2PCandidate.CandidateType = (type == "host") ? .host : .srflx
        let cand = P2PCandidate(type: kind, host: host, port: UInt16(clamping: port), priority: UInt32(clamping: (decrypted["priority"] as? Int) ?? 0))
        peer.transport?.addRemoteCandidate(cand)
    }

    func endGroupCall(notify: Bool = true) {
        if notify, let callId = callId {
            sendGroupSignal(type: "group_call_leave", extra: ["callId": callId])
        }
        for (_, peer) in groupPeers {
            peer.transport?.stop()
        }
        groupPeers = [:]
        isGroupCall = false
        groupParticipants = []
        groupHostUserId = ""
        groupRoomLocked = false
        groupMediaMode = "mesh"
        groupHandRaised = false
        endCall(reason: "hangup", notify: false)
    }

    func hostMuteAll() {
        guard !groupHostUserId.isEmpty else { return }
        let myId = UserDefaults.standard.string(forKey: "user_id") ?? ""
        guard myId == groupHostUserId else { return }
        sendGroupSignal(type: "meeting_host_mute_all", extra: ["callId": callId ?? ""])
    }

    func toggleGroupRoomLock() {
        guard !groupHostUserId.isEmpty else { return }
        let myId = UserDefaults.standard.string(forKey: "user_id") ?? ""
        guard myId == groupHostUserId else { return }
        groupRoomLocked.toggle()
        sendGroupSignal(type: groupRoomLocked ? "meeting_host_lock_room" : "meeting_host_unlock_room", extra: ["callId": callId ?? ""])
    }

    func toggleHandRaise() {
        groupHandRaised.toggle()
        sendGroupSignal(type: groupHandRaised ? "meeting_raise_hand" : "meeting_lower_hand", extra: ["callId": callId ?? ""])
    }

    private func addGroupPeer(userId: String, isInitiator: Bool) {
        guard let convId = conversationId,
              let secret = SessionManager.shared.p2pMediaSecret(conversationId: convId) else { return }

        let transport = P2PTransport()
        let peer = GroupPeer(userId: userId, transport: transport, connected: false)
        groupPeers[userId] = peer

        // Use a group-specific delegate wrapper
        transport.groupPeerUserId = userId
        transport.delegate = self
        transport.start(sharedSecret: secret, isInitiator: isInitiator)
    }

    private func shouldBeInitiator(remoteUserId: String) -> Bool {
        let myId = UserDefaults.standard.string(forKey: "user_id") ?? ""
        return myId < remoteUserId
    }

    private func sendGroupSignal(type: String, extra: [String: String]) {
        guard let convId = conversationId else {
            sendSignal(type: type, extra: extra)
            return
        }
        // For group calls, broadcast signals (no specific targetUserId)
        var payload = extra
        payload["conversationId"] = convId
        let message: [String: Any] = ["type": type, "payload": payload]
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let str = String(data: data, encoding: .utf8) else { return }
        ws?.send(.string(str)) { _ in }
    }

    // MARK: - RocP2P

    private func startP2P(isInitiator: Bool) {
        guard let convId = conversationId,
              let secret = SessionManager.shared.p2pMediaSecret(conversationId: convId) else {
            // No ratchet yet — stay on WS relay
            return
        }
        let transport = P2PTransport()
        transport.delegate = self
        self.p2p = transport
        self.p2pConnected = false
        transport.start(sharedSecret: secret, isInitiator: isInitiator)

        // 3-second window to establish direct path; otherwise stay on WS relay.
        p2pFallbackTimer?.invalidate()
        p2pFallbackTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self = self, !self.p2pConnected else { return }
                // Keep transport alive — late-connecting candidates may still promote us.
                // No-op here; sendAudioFrame already uses WS when !p2pConnected.
            }
        }
    }

    private func stopP2P() {
        p2pFallbackTimer?.invalidate()
        p2pFallbackTimer = nil
        p2p?.stop()
        p2p = nil
        p2pConnected = false
    }

    func handleP2PCandidate(payload: [String: Any]) {
        let decrypted = decryptSignaling(payload)
        guard callId == decrypted["callId"] as? String,
              let type = decrypted["candidateType"] as? String,
              let host = decrypted["host"] as? String,
              let port = decrypted["port"] as? Int else { return }
        let priority = (decrypted["priority"] as? Int) ?? 0
        let kind: P2PCandidate.CandidateType = (type == "host") ? .host : .srflx
        let cand = P2PCandidate(type: kind, host: host, port: UInt16(clamping: port), priority: UInt32(clamping: priority))
        p2p?.addRemoteCandidate(cand)
    }
}

// MARK: - P2PTransportDelegate

extension CallManager: P2PTransportDelegate {
    nonisolated func p2pDidGatherCandidate(_ candidate: P2PCandidate) {
        Task { @MainActor [weak self] in
            guard let self = self, let cid = self.callId else { return }
            if self.isGroupCall {
                // For group calls, send ICE candidates via group_call_ice
                self.sendGroupSignal(type: "group_call_ice", extra: [
                    "callId": cid,
                    "candidateType": candidate.type == .host ? "host" : "srflx",
                    "host": candidate.host,
                    "port": "\(candidate.port)",
                    "priority": "\(candidate.priority)"
                ])
            } else {
                self.sendEncryptedSignal(type: "call_p2p_candidate", extra: [
                    "callId": cid,
                    "targetUserId": self.remoteUserId,
                    "candidateType": candidate.type == .host ? "host" : "srflx",
                    "host": candidate.host,
                    "port": "\(candidate.port)",
                    "priority": "\(candidate.priority)"
                ])
            }
        }
    }

    nonisolated func p2pDidConnect() {
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            if self.isGroupCall {
                // Mark the specific group peer as connected
                // (Transport has groupPeerUserId set — but delegate doesn't carry it)
                // Mark all non-connected peers — the most recent start will be the one connecting
                for (userId, var peer) in self.groupPeers {
                    if !peer.connected {
                        peer.connected = true
                        self.groupPeers[userId] = peer
                    }
                }
            } else {
                self.p2pConnected = true
            }
        }
    }

    nonisolated func p2pDidFail(reason: String) {
        // Stay on WS relay; do not end the call.
        Task { @MainActor [weak self] in
            self?.p2pConnected = false
        }
    }

    nonisolated func p2pDidReceiveAudio(_ pcm: Data) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.callStatus == .connected,
                  let player = self.playerNode else { return }
            self.trackInboundAudioTiming()
            let data = self.decodeInboundAudio(pcm)
            let frameCount = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
            guard frameCount > 0,
                  let buffer = AVAudioPCMBuffer(pcmFormat: self.audioFormat, frameCapacity: frameCount),
                  let channel = buffer.int16ChannelData?[0] else { return }
            buffer.frameLength = frameCount
            data.withUnsafeBytes { raw in
                if let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self) {
                    channel.update(from: src, count: Int(frameCount))
                }
            }
            player.scheduleBuffer(buffer, completionHandler: nil)
        }
    }
}

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate bridge

/// Bridges AVFoundation's ObjC-protocol delegate into a simple Swift
/// closure so `CallManager` can stay actor-isolated and not worry about
/// inheriting from NSObject.
final class VideoCaptureDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let onFrame: (CMSampleBuffer) -> Void
    init(onFrame: @escaping (CMSampleBuffer) -> Void) { self.onFrame = onFrame }

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        onFrame(sampleBuffer)
    }
}
