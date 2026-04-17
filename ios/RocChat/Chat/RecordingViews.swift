//
//  RecordingViews.swift
//  RocChat
//
//  Animated recording UI + preview for voice and video messages.
//  Pure Roc Family minimalist design — no third-party dependencies.
//

import SwiftUI
import AVFoundation
import AVKit
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Recording Bar (during record)

struct RecordingBar: View {
    let elapsed: Int
    let levels: [CGFloat]
    let onCancel: () -> Void
    let onSend: () -> Void

    @State private var pulse = false

    private var timeText: String {
        String(format: "%d:%02d", elapsed / 60, elapsed % 60)
    }

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onCancel) {
                ZStack {
                    Circle().fill(Color.red.opacity(0.15)).frame(width: 40, height: 40)
                    Image(systemName: "trash.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.red)
                }
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                Circle()
                    .fill(Color.red)
                    .frame(width: 10, height: 10)
                    .scaleEffect(pulse ? 1.35 : 1.0)
                    .opacity(pulse ? 0.55 : 1.0)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                            pulse.toggle()
                        }
                    }

                Text(timeText)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundColor(.rocGold)
                    .frame(width: 46, alignment: .leading)

                Waveform(levels: levels)
                    .frame(maxWidth: .infinity, minHeight: 32, maxHeight: 32)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )

            Button(action: onSend) {
                ZStack {
                    Circle().fill(Color.rocGold).frame(width: 44, height: 44)
                        .shadow(color: Color.rocGold.opacity(0.35), radius: 6, y: 2)
                    Image(systemName: "arrow.up")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundColor(.white)
                }
            }
            .buttonStyle(.plain)
        }
    }
}

private struct Waveform: View {
    let levels: [CGFloat]

    var body: some View {
        GeometryReader { geo in
            let count = max(1, levels.count)
            let barWidth: CGFloat = 3
            let spacing: CGFloat = (geo.size.width - CGFloat(count) * barWidth) / CGFloat(max(1, count - 1))
            HStack(alignment: .center, spacing: max(2, spacing)) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, lvl in
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Color.rocGold)
                        .frame(width: barWidth, height: max(3, lvl * geo.size.height))
                        .animation(.easeOut(duration: 0.12), value: lvl)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }
}

// MARK: - Audio Preview Bar (after record, before send)

struct AudioPreviewBar: View {
    let url: URL
    let duration: Int
    let onDiscard: () -> Void
    let onSend: () -> Void

    @State private var player: AVAudioPlayer?
    @State private var isPlaying = false
    @State private var progress: CGFloat = 0
    @State private var timer: Timer?

    private var timeText: String {
        String(format: "%d:%02d", duration / 60, duration % 60)
    }

    var body: some View {
        HStack(spacing: 10) {
            Button(action: {
                stop()
                onDiscard()
            }) {
                ZStack {
                    Circle().fill(Color.red.opacity(0.15)).frame(width: 40, height: 40)
                    Image(systemName: "trash.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.red)
                }
            }
            .buttonStyle(.plain)

            HStack(spacing: 10) {
                Button(action: togglePlay) {
                    Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.rocGold)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.rocGold.opacity(0.15))
                            .frame(height: 4)
                        Capsule().fill(Color.rocGold)
                            .frame(width: geo.size.width * progress, height: 4)
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                .frame(height: 28)

                Text(timeText)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )

            Button(action: {
                stop()
                onSend()
            }) {
                ZStack {
                    Circle().fill(Color.rocGold).frame(width: 44, height: 44)
                        .shadow(color: Color.rocGold.opacity(0.35), radius: 6, y: 2)
                    Image(systemName: "arrow.up")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundColor(.white)
                }
            }
            .buttonStyle(.plain)
        }
        .onDisappear { stop() }
    }

    private func togglePlay() {
        if isPlaying {
            player?.pause()
            isPlaying = false
            return
        }
        if player == nil {
            let p = try? AVAudioPlayer(contentsOf: url)
            p?.prepareToPlay()
            player = p
        }
        player?.play()
        isPlaying = true
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
            guard let p = player else { return }
            progress = p.duration > 0 ? CGFloat(p.currentTime / p.duration) : 0
            if !p.isPlaying && p.currentTime >= p.duration - 0.05 {
                isPlaying = false
                progress = 0
                p.currentTime = 0
                timer?.invalidate()
                timer = nil
            }
        }
    }

    private func stop() {
        timer?.invalidate(); timer = nil
        player?.stop(); player = nil
        isPlaying = false
    }
}

// MARK: - Video Message Recorder (sheet)

struct VideoMessageRecorder: View {
    /// onComplete(url, durationSeconds). url==nil means cancelled.
    let onComplete: (URL?, Int) -> Void

    @StateObject private var controller = VideoRecorderController()
    @State private var recording = false
    @State private var elapsed: Int = 0
    @State private var timer: Timer?
    @State private var pendingURL: URL?
    @State private var pendingDuration: Int = 0
    @State private var showPreview = false

    private var timeText: String {
        String(format: "%d:%02d", elapsed / 60, elapsed % 60)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if showPreview, let u = pendingURL {
                VideoPlayer(player: AVPlayer(url: u))
                    .ignoresSafeArea()
            } else {
                CameraPreviewView(session: controller.session)
                    .ignoresSafeArea()
            }

            VStack {
                HStack {
                    Button {
                        cleanup()
                        onComplete(nil, 0)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(Color.black.opacity(0.5)))
                    }
                    Spacer()
                    if recording {
                        HStack(spacing: 6) {
                            Circle().fill(Color.red).frame(width: 10, height: 10)
                            Text(timeText)
                                .font(.system(size: 14, weight: .semibold, design: .monospaced))
                                .foregroundColor(.white)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(Color.black.opacity(0.5)))
                    }
                    Spacer()
                    Button {
                        controller.toggleCamera()
                    } label: {
                        Image(systemName: "camera.rotate.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(Color.black.opacity(0.5)))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)

                Spacer()

                if showPreview {
                    HStack(spacing: 24) {
                        Button {
                            if let u = pendingURL { try? FileManager.default.removeItem(at: u) }
                            pendingURL = nil
                            showPreview = false
                        } label: {
                            VStack(spacing: 4) {
                                Image(systemName: "arrow.counterclockwise")
                                    .font(.system(size: 20, weight: .semibold))
                                Text("Retake").font(.caption)
                            }
                            .foregroundColor(.white)
                            .frame(width: 72, height: 72)
                            .background(Circle().fill(Color.black.opacity(0.5)))
                        }
                        Button {
                            let u = pendingURL; let d = pendingDuration
                            pendingURL = nil
                            onComplete(u, d)
                        } label: {
                            ZStack {
                                Circle().fill(Color.rocGold).frame(width: 80, height: 80)
                                    .shadow(color: Color.rocGold.opacity(0.35), radius: 8, y: 2)
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 26, weight: .bold))
                                    .foregroundColor(.white)
                            }
                        }
                    }
                    .padding(.bottom, 42)
                } else {
                    Button(action: toggleRecord) {
                        ZStack {
                            Circle().fill(recording ? Color.red : Color.white.opacity(0.25))
                                .frame(width: recording ? 72 : 80, height: recording ? 72 : 80)
                            Circle().stroke(Color.white, lineWidth: 4)
                                .frame(width: 88, height: 88)
                            if recording {
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Color.white)
                                    .frame(width: 26, height: 26)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 42)
                }
            }
        }
        .onAppear { controller.start() }
        .onDisappear { cleanup() }
    }

    private func toggleRecord() {
        if recording {
            controller.stop { url, duration in
                recording = false
                timer?.invalidate(); timer = nil
                guard let url = url else { return }
                pendingURL = url
                pendingDuration = max(1, duration)
                showPreview = true
            }
        } else {
            controller.record()
            recording = true
            elapsed = 0
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                elapsed += 1
                if elapsed >= 120 { toggleRecord() } // 2 min cap
            }
        }
    }

    private func cleanup() {
        timer?.invalidate(); timer = nil
        if recording { controller.stop { _, _ in } }
        controller.stop(nil)
    }
}

// MARK: - Camera preview + controller

final class VideoRecorderController: NSObject, ObservableObject, AVCaptureFileOutputRecordingDelegate {
    let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private var currentPosition: AVCaptureDevice.Position = .front
    private var startedAt: Date?
    private var completion: ((URL?, Int) -> Void)?

    func start() {
        if session.isRunning { return }
        session.sessionPreset = .high
        session.beginConfiguration()
        // Remove old
        for input in session.inputs { session.removeInput(input) }
        for out in session.outputs { session.removeOutput(out) }
        // Camera
        if let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: currentPosition),
           let camInput = try? AVCaptureDeviceInput(device: cam),
           session.canAddInput(camInput) {
            session.addInput(camInput)
        }
        // Mic
        if let mic = AVCaptureDevice.default(for: .audio),
           let micInput = try? AVCaptureDeviceInput(device: mic),
           session.canAddInput(micInput) {
            session.addInput(micInput)
        }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    func toggleCamera() {
        currentPosition = currentPosition == .front ? .back : .front
        start()
    }

    func record() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("video_note_\(UUID().uuidString).mp4")
        startedAt = Date()
        output.startRecording(to: url, recordingDelegate: self)
    }

    func stop(_ completion: ((URL?, Int) -> Void)?) {
        self.completion = completion
        if output.isRecording {
            output.stopRecording()
        } else {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.session.stopRunning()
            }
            completion?(nil, 0)
        }
    }

    // Delegate
    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL,
                    from connections: [AVCaptureConnection], error: Error?) {
        let duration = Int(Date().timeIntervalSince(startedAt ?? Date()))
        let cb = completion
        completion = nil
        DispatchQueue.main.async {
            if error != nil {
                cb?(nil, 0)
            } else {
                cb?(outputFileURL, duration)
            }
        }
    }
}

struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewUIView {
        let v = PreviewUIView()
        v.videoPreviewLayer.session = session
        v.videoPreviewLayer.videoGravity = .resizeAspectFill
        return v
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {}

    final class PreviewUIView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var videoPreviewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
