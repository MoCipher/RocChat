package com.rocchat.calls

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.*
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.ImageReader
import android.media.MediaRecorder
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Base64
import android.view.Surface
import android.view.SurfaceHolder
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.rocchat.network.NativeWebSocket
import com.rocchat.crypto.SessionManager
import kotlinx.coroutines.*
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*
import kotlin.math.abs

/**
 * RocChat Android — Call Manager
 *
 * Manages WebRTC signaling, media, and call lifecycle.
 * E2E encrypted signaling via Double Ratchet.
 * Uses native Android frameworks only — no third-party dependencies.
 */

data class CallRecord(
    val id: String,
    val remoteName: String,
    val remoteUserId: String,
    val callType: String, // "voice" or "video"
    val direction: String, // "incoming" or "outgoing"
    val status: String, // "completed" or "missed"
    val duration: Int,
    val timestamp: String
)

object CallManager {
    var callStatus by mutableStateOf("idle") // idle, outgoing, incoming, connected
    var callType by mutableStateOf("voice")
    var remoteName by mutableStateOf("")
    var remoteUserId by mutableStateOf("")
    var isMuted by mutableStateOf(false)
    var isCameraOff by mutableStateOf(false)
    var callDuration by mutableIntStateOf(0)
    val callHistory = mutableStateListOf<CallRecord>()

    /// Latest decoded JPEG frame from the remote peer, rendered by Compose UI.
    var remoteVideoBitmap by mutableStateOf<Bitmap?>(null)

    // Group call state
    var isGroupCall by mutableStateOf(false)
    var groupPeers = mutableMapOf<String, GroupPeer>()
    var groupParticipants by mutableStateOf(listOf<String>())
    var groupHostUserId by mutableStateOf("")
    var groupRoomLocked by mutableStateOf(false)
    var groupMediaMode by mutableStateOf("mesh")
    private val maxMeshPeers = 5 // 6 total including self

    private var callId: String? = null
    private var conversationId: String? = null
    private var ws: NativeWebSocket? = null
    private var startTime: Long? = null
    private var durationJob: Job? = null
    private var pendingSdp: String? = null
    private var timeoutJob: Job? = null
    private var appContext: Context? = null

    // RocP2P — direct UDP + AES-GCM. Falls back to WS relay if ICE fails.
    private var p2p: P2PTransport? = null
    @Volatile private var p2pConnected: Boolean = false

    // Voice-over-WebSocket audio engine — 16 kHz mono PCM16, base64 over WS
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var audioJob: Job? = null
    private var audioSeq: Long = 0L
    private var lastInboundAudioAtMs: Long? = null
    private val sampleRate = 16000
    private val chunkFrames = 320 // 20 ms @ 16 kHz

    // Camera2 video capture for video calls
    private var cameraDevice: CameraDevice? = null
    private var cameraCaptureSession: CameraCaptureSession? = null
    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null
    private var previewSurface: Surface? = null
    private var imageReader: ImageReader? = null
    private var videoJob: Job? = null
    private var videoSeq: Long = 0L
    private var lastVideoSendMs: Long = 0L
    private var videoTargetFps: Long = 8
    private var videoJpegQuality: Int = 55
        set(value) { field = value; diagQuality = value }

    // Diagnostics (publicly observable for CallDiagnosticsSheet)
    var diagRttMs by mutableStateOf(150.0)
    var diagFps by mutableStateOf(8L)
    var diagQuality by mutableStateOf(55)
    var diagAudioJitterMs by mutableStateOf(0.0)
    var diagAudioLateFrames by mutableIntStateOf(0)

    // RTT / adaptive quality
    private var pingTs: Long? = null
    private var estimatedRttMs: Double = 150.0
    private var pingJob: Job? = null

    fun startCall(
        conversationId: String, remoteUserId: String, remoteName: String,
        callType: String, ws: NativeWebSocket?, context: Context? = null
    ) {
        if (callStatus != "idle") return
        if (context != null) appContext = context.applicationContext
        val signalWs = ws ?: InboxWebSocket.task
        this.callId = UUID.randomUUID().toString()
        this.conversationId = conversationId
        this.remoteUserId = remoteUserId
        this.remoteName = remoteName
        this.callType = callType
        this.callStatus = "outgoing"
        this.ws = signalWs

        startP2P(isInitiator = true)
        sendEncryptedSignal("call_offer", mapOf(
            "callId" to (callId ?: ""),
            "callType" to callType,
            "targetUserId" to remoteUserId,
            "timestamp" to System.currentTimeMillis().toString()
        ))

        timeoutJob = CoroutineScope(Dispatchers.Main).launch {
            delay(30_000)
            if (callStatus == "outgoing") endCall("timeout")
        }
    }

    fun handleIncomingOffer(payload: JSONObject, conversationId: String, ws: NativeWebSocket?, context: Context? = null) {
        if (context != null) appContext = context.applicationContext
        val signalWs = ws ?: InboxWebSocket.task
        if (callStatus != "idle" || signalWs == null) {
            val callId = payload.optString("callId")
            val from = payload.optString("fromUserId")
            if (callId.isNotEmpty() && from.isNotEmpty()) {
                sendSignal("call_end", mapOf("callId" to callId, "reason" to "busy", "targetUserId" to from))
            }
            return
        }
        val decrypted = decryptSignaling(payload, conversationId)
        this.callId = decrypted.optString("callId").ifEmpty { payload.optString("callId") }
        this.conversationId = conversationId
        this.remoteUserId = decrypted.optString("fromUserId").ifEmpty { payload.optString("fromUserId") }
        this.remoteName = this.remoteUserId.take(8)
        this.callType = decrypted.optString("callType", "voice")
        this.callStatus = "incoming"
        this.ws = signalWs
        this.pendingSdp = decrypted.optString("sdp").ifEmpty { payload.optString("sdp") }

        timeoutJob = CoroutineScope(Dispatchers.Main).launch {
            delay(30_000)
            if (callStatus == "incoming") endCall("timeout")
        }
    }

    fun acceptCall() {
        if (callStatus != "incoming") return
        callStatus = "connected"
        startTime = System.currentTimeMillis()
        startDurationTimer()
        timeoutJob?.cancel()

        startP2P(isInitiator = false)
        sendEncryptedSignal("call_answer", mapOf(
            "callId" to (callId ?: ""),
            "targetUserId" to remoteUserId
        ))
        startAudioStreaming()
        if (callType == "video") {
            val ctx = appContext ?: return
            startVideoCapture(ctx)
            pingJob = CoroutineScope(Dispatchers.Main).launch {
                while (true) { kotlinx.coroutines.delay(5_000); sendVideoPing() }
            }
        }
    }

    fun declineCall() = endCall("declined")

    fun handleCallAnswer(payload: JSONObject) {
        val decrypted = decryptSignaling(payload)
        if (callId != decrypted.optString("callId").ifEmpty { payload.optString("callId") }) return
        callStatus = "connected"
        startTime = System.currentTimeMillis()
        startDurationTimer()
        timeoutJob?.cancel()
        startAudioStreaming()
        if (callType == "video") {
            val ctx = appContext ?: return
            startVideoCapture(ctx)
            pingJob = CoroutineScope(Dispatchers.Main).launch {
                while (true) { kotlinx.coroutines.delay(5_000); sendVideoPing() }
            }
        }
    }

    fun handleIceCandidate(payload: JSONObject) {
        val decrypted = decryptSignaling(payload)
        if (callId != decrypted.optString("callId").ifEmpty { payload.optString("callId") }) return
        // Add ICE candidate to peer connection
    }

    fun handleCallEnd(payload: JSONObject) {
        val decrypted = decryptSignaling(payload)
        if (callId != decrypted.optString("callId").ifEmpty { payload.optString("callId") }) return
        endCall(decrypted.optString("reason", "hangup"), notify = false)
    }

    fun toggleMute() { isMuted = !isMuted }
    fun toggleCamera() {
        isCameraOff = !isCameraOff
        if (isCameraOff) {
            stopVideoCapture()
        } else if (callStatus == "connected" && callType == "video") {
            val ctx = appContext ?: return
            startVideoCapture(ctx)
        }
    }

    /**
     * Attach a SurfaceHolder from the composable SurfaceView for local camera preview.
     * Must be called on a surface that's been created.
     */
    fun attachLocalVideoSurface(ctx: Context, holder: SurfaceHolder) {
        previewSurface = holder.surface
        appContext = ctx
        if (callStatus == "connected" && callType == "video" && !isCameraOff) {
            startVideoCapture(ctx)
        }
    }

    @Suppress("MissingPermission")
    private fun startVideoCapture(ctx: Context) {
        if (cameraDevice != null) return // already capturing
        val surface = previewSurface ?: return

        cameraThread = HandlerThread("RocCameraThread").apply { start() }
        cameraHandler = Handler(cameraThread!!.looper)

        // ImageReader captures NV21-compatible frames that we JPEG-encode
        // and ship as `call_video` so web and iOS can decode them. Matches
        // the shared wire format: [0x01 | jpeg bytes] base64 over WS.
        imageReader = ImageReader.newInstance(640, 480, ImageFormat.YUV_420_888, 2)
        imageReader?.setOnImageAvailableListener({ reader ->
            val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val now = System.currentTimeMillis()
                if (now - lastVideoSendMs < (1000L / videoTargetFps)) {
                    return@setOnImageAvailableListener
                }
                if (isCameraOff) return@setOnImageAvailableListener
                lastVideoSendMs = now
                val jpeg = yuv420ToJpeg(image, quality = videoJpegQuality) ?: return@setOnImageAvailableListener
                sendVideoFrame(jpeg)
            } catch (_: Exception) {
                // ignore malformed frames
            } finally {
                image.close()
            }
        }, cameraHandler)

        val camManager = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val frontCam = camManager.cameraIdList.firstOrNull { id ->
            camManager.getCameraCharacteristics(id)
                .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
        } ?: camManager.cameraIdList.firstOrNull() ?: return

        try {
            camManager.openCamera(frontCam, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    cameraDevice = camera
                    val targets = listOf(surface, imageReader!!.surface)
                    camera.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(session: CameraCaptureSession) {
                            cameraCaptureSession = session
                            val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                                addTarget(surface)
                                addTarget(imageReader!!.surface)
                            }
                            session.setRepeatingRequest(req.build(), null, cameraHandler)
                        }
                        override fun onConfigureFailed(session: CameraCaptureSession) {
                            stopVideoCapture()
                        }
                    }, cameraHandler)
                }
                override fun onDisconnected(camera: CameraDevice) { stopVideoCapture() }
                override fun onError(camera: CameraDevice, error: Int) { stopVideoCapture() }
            }, cameraHandler)
        } catch (_: SecurityException) { /* no camera permission */ }
    }

    private fun stopVideoCapture() {
        cameraCaptureSession?.close(); cameraCaptureSession = null
        cameraDevice?.close(); cameraDevice = null
        imageReader?.close(); imageReader = null
        cameraThread?.quitSafely(); cameraThread = null
        cameraHandler = null
        videoSeq = 0L
        lastVideoSendMs = 0L
    }

    /**
     * YUV_420_888 → JPEG. Scales down to 320×240 equivalent by reducing the
     * JPEG source rect — cheap and good enough for 8 fps preview.
     */
    private fun yuv420ToJpeg(image: android.media.Image, quality: Int): ByteArray? {
        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]
        val yBuf = yPlane.buffer
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer
        val ySize = yBuf.remaining()
        val uSize = uBuf.remaining()
        val vSize = vBuf.remaining()
        // Build an NV21-shaped byte array. The U/V planes from YUV_420_888 may
        // be interleaved with a pixelStride of 2; copy raw bytes and let YuvImage
        // handle it — works well enough for low-fps preview.
        val nv21 = ByteArray(ySize + uSize + vSize)
        yBuf.get(nv21, 0, ySize)
        vBuf.get(nv21, ySize, vSize)
        uBuf.get(nv21, ySize + vSize, uSize)
        val yuv = YuvImage(nv21, ImageFormat.NV21, image.width, image.height, null)
        val out = java.io.ByteArrayOutputStream()
        val rect = Rect(0, 0, image.width, image.height)
        return if (yuv.compressToJpeg(rect, quality, out)) out.toByteArray() else null
    }

    private fun sendVideoFrame(jpeg: ByteArray) {
        val cid = callId ?: return
        if (remoteUserId.isEmpty()) return
        videoSeq += 1
        val tagged = ByteArray(jpeg.size + 1)
        tagged[0] = 0x01
        System.arraycopy(jpeg, 0, tagged, 1, jpeg.size)
        val b64 = Base64.encodeToString(tagged, Base64.NO_WRAP)
        val payload = JSONObject()
            .put("callId", cid)
            .put("targetUserId", remoteUserId)
            .put("seq", videoSeq)
            .put("frame", b64)
        val msg = JSONObject().put("type", "call_video").put("payload", payload)
        if (!InboxWebSocket.send(msg)) {
            ws?.send(msg.toString())
        }
    }

    private fun sendVideoPing() {
        val cid = callId ?: return
        val ts = System.currentTimeMillis()
        pingTs = ts
        val payload = JSONObject().put("callId", cid).put("targetUserId", remoteUserId).put("seq", 0).put("frame", "roc-ping:$ts")
        val msg = JSONObject().put("type", "call_video").put("payload", payload)
        if (!InboxWebSocket.send(msg)) {
            ws?.send(msg.toString())
        }
    }

    private fun adaptVideoQuality() {
        when {
            estimatedRttMs < 80  -> { videoTargetFps = 12; videoJpegQuality = 65 }
            estimatedRttMs < 200 -> { videoTargetFps = 8;  videoJpegQuality = 55 }
            else                 -> { videoTargetFps = 4;  videoJpegQuality = 30 }
        }
        diagRttMs = estimatedRttMs
        diagFps = videoTargetFps
        // diagQuality is updated via the videoJpegQuality setter
    }

    /**
     * Inbound `call_video` frame from web or iOS. Tag 0x01 (JPEG) is the
     * only supported format — decode and publish for Compose to render.
     */
    fun handleCallVideo(payload: JSONObject) {
        if (callStatus != "connected") return
        val incomingId = payload.optString("callId")
        if (incomingId != callId) return
        val b64 = payload.optString("frame")
        if (b64.isEmpty()) return
        // Ping/pong handling
        if (b64.startsWith("roc-ping:")) {
            val ts = b64.removePrefix("roc-ping:")
            val cid = callId ?: return
            val pong = JSONObject().put("callId", cid).put("targetUserId", remoteUserId).put("seq", 0).put("frame", "roc-pong:$ts")
            ws?.send(JSONObject().put("type", "call_video").put("payload", pong).toString())
            return
        }
        if (b64.startsWith("roc-pong:")) {
            val sent = pingTs
            if (sent != null) {
                estimatedRttMs = (System.currentTimeMillis() - sent).toDouble()
                pingTs = null
                adaptVideoQuality()
            }
            return
        }
        try {
            val raw = Base64.decode(b64, Base64.NO_WRAP)
            if (raw.isEmpty() || raw[0] != 0x01.toByte()) return
            val bmp = BitmapFactory.decodeByteArray(raw, 1, raw.size - 1) ?: return
            remoteVideoBitmap = bmp
        } catch (_: Exception) { /* drop bad frame */ }
    }

    fun endCall(reason: String = "hangup", notify: Boolean = true) {
        if (notify && callId != null) {
            sendEncryptedSignal("call_end", mapOf(
                "callId" to (callId ?: ""),
                "reason" to reason,
                "targetUserId" to remoteUserId,
                "duration" to callDuration.toString()
            ))
        }

        if (callId != null) {
            val record = CallRecord(
                id = callId!!,
                remoteName = remoteName,
                remoteUserId = remoteUserId,
                callType = callType,
                direction = if (callStatus == "incoming") "incoming" else "outgoing",
                status = if (startTime != null) "completed" else "missed",
                duration = callDuration,
                timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                    .apply { timeZone = TimeZone.getTimeZone("UTC") }
                    .format(Date())
            )
            callHistory.add(0, record)
            if (callHistory.size > 100) callHistory.removeRange(100, callHistory.size)
        }

        durationJob?.cancel()
        timeoutJob?.cancel()
        pingJob?.cancel(); pingJob = null
        pingTs = null
        stopAudioStreaming()
        stopVideoCapture()
        stopP2P()
        callId = null
        conversationId = null
        remoteUserId = ""
        remoteName = ""
        callStatus = "idle"
        startTime = null
        callDuration = 0
        isMuted = false
        isCameraOff = false
        previewSurface = null
        pendingSdp = null
        remoteVideoBitmap = null
    }

    private fun sendSignal(type: String, extra: Map<String, String>) {
        val payload = JSONObject()
        extra.forEach { (k, v) -> payload.put(k, v) }
        val msg = JSONObject().put("type", type).put("payload", payload)
        ws?.send(msg.toString())
    }

    private fun sendEncryptedSignal(type: String, extra: Map<String, String>) {
        val convId = conversationId
        val ctx = appContext
        if (convId == null || remoteUserId.isEmpty() || ctx == null) {
            sendSignal(type, extra)
            return
        }
        val callIdVal = extra["callId"] ?: ""
        val targetUserId = extra["targetUserId"] ?: ""
        val sensitiveData = extra.filterKeys { it != "callId" && it != "targetUserId" }

        CoroutineScope(Dispatchers.Main).launch {
            try {
                val plaintext = JSONObject(sensitiveData as Map<*, *>).toString()
                val envelope = withContext(Dispatchers.IO) {
                    SessionManager.encryptMessage(ctx, convId, remoteUserId, plaintext)
                }
                val encryptedSignaling = JSONObject()
                    .put("ciphertext", envelope.ciphertext)
                    .put("iv", envelope.iv)
                    .put("ratchet_header", envelope.ratchetHeader)
                // conversationId rides in cleartext so the recipient can find
                // the pairwise ratchet session even when this message arrives
                // over the user-inbox WS (not conversation-scoped).
                val payload = JSONObject()
                    .put("callId", callIdVal)
                    .put("targetUserId", targetUserId)
                    .put("conversationId", convId)
                    .put("encryptedSignaling", encryptedSignaling)
                val msg = JSONObject().put("type", type).put("payload", payload)
                // Prefer the inbox WS — call reaches the callee no matter what
                // conversation they currently have open.
                if (!InboxWebSocket.send(msg)) {
                    ws?.send(msg.toString())
                }
            } catch (e: Exception) {
                android.util.Log.e("CallManager", "Encrypted signaling failed, dropping signal", e)
                return@launch
            }
        }
    }

    private fun decryptSignaling(payload: JSONObject, overrideConvId: String? = null): JSONObject {
        val encSig = payload.optJSONObject("encryptedSignaling") ?: return payload
        val ct = encSig.optString("ciphertext")
        val iv = encSig.optString("iv")
        val rh = encSig.optString("ratchet_header")
        // Resolve conversationId in priority order: explicit override (from
        // ChatRoom path), cleartext field on payload (inbox-WS path), then
        // current call state.
        val cleartextConv = payload.optString("conversationId").takeIf { it.isNotEmpty() }
        val convId = overrideConvId ?: cleartextConv ?: conversationId ?: return payload
        val ctx = appContext ?: return payload
        if (ct.isEmpty() || iv.isEmpty() || rh.isEmpty()) return payload
        return try {
            val decrypted = SessionManager.decryptMessage(ctx, convId, ct, iv, rh)
            val result = JSONObject(decrypted)
            result.put("callId", payload.optString("callId"))
            result.put("targetUserId", payload.optString("targetUserId"))
            result.put("fromUserId", payload.optString("fromUserId"))
            result.put("conversationId", convId)
            result
        } catch (_: Exception) {
            payload
        }
    }

    fun setContext(context: Context) {
        appContext = context.applicationContext
    }

    private fun startDurationTimer() {
        durationJob?.cancel()
        durationJob = CoroutineScope(Dispatchers.Main).launch {
            while (isActive) {
                delay(1000)
                val start = startTime ?: continue
                callDuration = ((System.currentTimeMillis() - start) / 1000).toInt()
            }
        }
    }

    // MARK: - Voice-over-WebSocket Audio Engine

    @Suppress("MissingPermission")
    private fun startAudioStreaming() {
        if (audioJob != null) return
        diagAudioJitterMs = 0.0
        diagAudioLateFrames = 0
        lastInboundAudioAtMs = null
        val minRecordBuf = AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(chunkFrames * 2 * 4)
        val minPlayBuf = AudioTrack.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(chunkFrames * 2 * 4)

        try {
            val rec = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                minRecordBuf
            )
            val trackAttrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            val trackFormat = AudioFormat.Builder()
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .build()
            val trk = AudioTrack(
                trackAttrs, trackFormat, minPlayBuf,
                AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE
            )
            rec.startRecording()
            trk.play()
            audioRecord = rec
            audioTrack = trk

            audioJob = CoroutineScope(Dispatchers.IO).launch {
                val buf = ShortArray(chunkFrames)
                while (isActive) {
                    val read = rec.read(buf, 0, chunkFrames)
                    if (read <= 0) continue
                    if (isMuted) continue
                    val bytes = ByteArray(read * 2)
                    for (i in 0 until read) {
                        val s = buf[i].toInt()
                        bytes[i * 2] = (s and 0xFF).toByte()
                        bytes[i * 2 + 1] = ((s ushr 8) and 0xFF).toByte()
                    }
                    sendAudioFrame(bytes)
                }
            }
        } catch (_: SecurityException) {
            // Missing RECORD_AUDIO permission — silently skip
        } catch (_: Exception) {
            stopAudioStreaming()
        }
    }

    private fun stopAudioStreaming() {
        audioJob?.cancel()
        audioJob = null
        try { audioRecord?.stop() } catch (_: Exception) {}
        try { audioRecord?.release() } catch (_: Exception) {}
        audioRecord = null
        try { audioTrack?.stop() } catch (_: Exception) {}
        try { audioTrack?.release() } catch (_: Exception) {}
        audioTrack = null
        audioSeq = 0L
        lastInboundAudioAtMs = null
    }

    private fun sendAudioFrame(bytes: ByteArray) {
        val cid = callId ?: return
        if (remoteUserId.isEmpty()) return
        // μ-law encode + 1-byte codec tag: [0x01 | mulaw-bytes]. 2× compression.
        val encoded = MuLaw.encode(bytes)
        val payload = ByteArray(encoded.size + 1)
        payload[0] = 0x01
        System.arraycopy(encoded, 0, payload, 1, encoded.size)
        // Prefer direct P2P path once connected — WS relay is fallback only.
        if (p2pConnected) {
            p2p?.sendAudio(payload)
            return
        }
        audioSeq += 1
        val b64 = Base64.encodeToString(payload, Base64.NO_WRAP)
        val json = JSONObject()
            .put("callId", cid)
            .put("targetUserId", remoteUserId)
            .put("seq", audioSeq)
            .put("frame", b64)
        val msg = JSONObject().put("type", "call_audio").put("payload", json)
        if (!InboxWebSocket.send(msg)) {
            ws?.send(msg.toString())
        }
    }

    /** Decode μ-law (0x01) or PCM16 (0x00 / legacy) payload back into raw PCM16 bytes. */
    private fun decodeInboundAudio(payload: ByteArray): ByteArray {
        if (payload.isEmpty()) return payload
        return when (payload[0]) {
            0x01.toByte() -> MuLaw.decode(payload.copyOfRange(1, payload.size))
            0x00.toByte() -> payload.copyOfRange(1, payload.size)
            else -> payload // legacy raw PCM16
        }
    }

    private fun trackInboundAudioTiming(expectedFrameMs: Double = 20.0) {
        val now = SystemClock.elapsedRealtime()
        val last = lastInboundAudioAtMs
        if (last != null) {
            val delta = (now - last).toDouble()
            val sample = abs(delta - expectedFrameMs)
            diagAudioJitterMs = diagAudioJitterMs * 0.85 + sample * 0.15
            if (delta > 60.0) diagAudioLateFrames += 1
        }
        lastInboundAudioAtMs = now
    }

    fun handleCallAudio(payload: JSONObject) {
        if (callStatus != "connected") return
        val incomingId = payload.optString("callId")
        if (incomingId != callId) return
        val b64 = payload.optString("frame")
        if (b64.isEmpty()) return
        val track = audioTrack ?: return
        try {
            trackInboundAudioTiming()
            val raw = Base64.decode(b64, Base64.NO_WRAP)
            val bytes = decodeInboundAudio(raw)
            val shorts = ShortArray(bytes.size / 2)
            for (i in shorts.indices) {
                val lo = bytes[i * 2].toInt() and 0xFF
                val hi = bytes[i * 2 + 1].toInt()
                shorts[i] = ((hi shl 8) or lo).toShort()
            }
            track.write(shorts, 0, shorts.size)
        } catch (_: Exception) {}
    }

    // MARK: - RocP2P

    private fun startP2P(isInitiator: Boolean) {
        val convId = conversationId ?: return
        val ctx = appContext ?: return
        val secret = SessionManager.p2pMediaSecret(ctx, convId) ?: return
        stopP2P()
        val transport = P2PTransport(p2pDelegate)
        p2p = transport
        p2pConnected = false
        transport.start(secret, isInitiator)
    }

    private fun stopP2P() {
        p2p?.stop()
        p2p = null
        p2pConnected = false
    }

    fun handleP2PCandidate(payload: JSONObject) {
        val decrypted = decryptSignaling(payload)
        val incomingCall = decrypted.optString("callId").ifEmpty { payload.optString("callId") }
        if (incomingCall != callId) return
        val type = decrypted.optString("candidateType").ifEmpty { return }
        val host = decrypted.optString("host").ifEmpty { return }
        val port = decrypted.optString("port").toIntOrNull() ?: return
        val priority = decrypted.optString("priority").toIntOrNull() ?: 0
        p2p?.addRemoteCandidate(P2PCandidate(type, host, port, priority))
    }

    private fun playIncomingPcm(pcm: ByteArray) {
        val track = audioTrack ?: return
        try {
            trackInboundAudioTiming()
            val bytes = decodeInboundAudio(pcm)
            val shorts = ShortArray(bytes.size / 2)
            for (i in shorts.indices) {
                val lo = bytes[i * 2].toInt() and 0xFF
                val hi = bytes[i * 2 + 1].toInt()
                shorts[i] = ((hi shl 8) or lo).toShort()
            }
            track.write(shorts, 0, shorts.size)
        } catch (_: Exception) {}
    }

    private val p2pDelegate = object : P2PTransportDelegate {
        override fun p2pDidGatherCandidate(candidate: P2PCandidate) {
            val cid = callId ?: return
            if (isGroupCall) {
                sendGroupSignal("group_call_ice", mapOf(
                    "callId" to cid,
                    "candidateType" to candidate.type,
                    "host" to candidate.host,
                    "port" to candidate.port.toString(),
                    "priority" to candidate.priority.toString(),
                ))
            } else {
                sendEncryptedSignal("call_p2p_candidate", mapOf(
                    "callId" to cid,
                    "targetUserId" to remoteUserId,
                    "candidateType" to candidate.type,
                    "host" to candidate.host,
                    "port" to candidate.port.toString(),
                    "priority" to candidate.priority.toString(),
                ))
            }
        }

        override fun p2pDidConnect() {
            if (isGroupCall) {
                groupPeers.forEach { (userId, peer) ->
                    if (!peer.connected) {
                        groupPeers[userId] = peer.copy(connected = true)
                    }
                }
            } else {
                p2pConnected = true
            }
        }

        override fun p2pDidFail(reason: String) {
            p2pConnected = false
        }

        override fun p2pDidReceiveAudio(pcm: ByteArray) {
            if (callStatus != "connected") return
            playIncomingPcm(pcm)
        }
    }

    // MARK: - Group Calls (Mesh)

    fun startGroupCall(conversationId: String, callType: String, ws: NativeWebSocket?, members: List<String>) {
        if (callStatus != "idle") return
        val signalWs = ws ?: InboxWebSocket.task ?: return
        this.callId = UUID.randomUUID().toString()
        this.conversationId = conversationId
        this.callType = callType
        this.callStatus = "connected"
        this.ws = signalWs
        this.isGroupCall = true
        this.groupPeers.clear()
        this.groupParticipants = emptyList()
        this.groupHostUserId = appContext?.getSharedPreferences("rocchat", Context.MODE_PRIVATE)?.getString("user_id", "") ?: ""
        this.groupRoomLocked = false
        this.groupMediaMode = if (members.size > 2) "sfu" else "mesh"
        this.startTime = System.currentTimeMillis()

        startDurationTimer()
        startAudioStreaming()

        sendGroupSignal("group_call_start", mapOf(
            "callId" to (callId ?: ""),
            "callType" to callType,
            "conversationId" to conversationId,
            "mode" to groupMediaMode
        ))
    }

    fun handleGroupCallStart(payload: JSONObject, conversationId: String, ws: NativeWebSocket?) {
        val signalWs = ws ?: InboxWebSocket.task
        if (callStatus != "idle" || signalWs == null) return
        val decrypted = decryptSignaling(payload, conversationId)
        val fromUserId = payload.optString("fromUserId")

        this.callId = decrypted.optString("callId").ifEmpty { payload.optString("callId") }
        this.conversationId = conversationId
        this.callType = decrypted.optString("callType", "voice")
        this.callStatus = "connected"
        this.ws = signalWs
        this.isGroupCall = true
        this.groupPeers.clear()
        this.groupParticipants = emptyList()
        this.groupHostUserId = fromUserId
        this.groupRoomLocked = false
        this.groupMediaMode = decrypted.optString("mode", "mesh")
        this.startTime = System.currentTimeMillis()

        startDurationTimer()
        startAudioStreaming()

        sendGroupSignal("group_call_join", mapOf(
            "callId" to (callId ?: ""),
            "conversationId" to conversationId
        ))

        addGroupPeer(fromUserId)
    }

    fun handleGroupCallJoin(payload: JSONObject) {
        if (!isGroupCall || callStatus != "connected") return
        val userId = payload.optString("fromUserId")
        if (userId.isEmpty() || groupPeers.containsKey(userId)) return
        if (groupPeers.size >= maxMeshPeers) return
        groupParticipants = groupParticipants + userId
        addGroupPeer(userId)
    }

    fun handleGroupCallLeave(payload: JSONObject) {
        val userId = payload.optString("fromUserId")
        val peer = groupPeers.remove(userId) ?: return
        peer.transport?.stop()
        groupParticipants = groupParticipants.filterNot { it == userId }
        if (groupPeers.isEmpty()) endGroupCall(notify = false)
    }

    fun handleGroupCallIce(payload: JSONObject) {
        if (!isGroupCall) return
        val fromId = payload.optString("fromUserId")
        val peer = groupPeers[fromId] ?: return
        val decrypted = decryptSignaling(payload)
        val type = decrypted.optString("candidateType").ifEmpty { return }
        val host = decrypted.optString("host").ifEmpty { return }
        val port = decrypted.optString("port").toIntOrNull() ?: return
        val priority = decrypted.optString("priority").toIntOrNull() ?: 0
        peer.transport?.addRemoteCandidate(P2PCandidate(type, host, port, priority))
    }

    fun endGroupCall(notify: Boolean = true) {
        if (notify) {
            val cid = callId
            if (cid != null) sendGroupSignal("group_call_leave", mapOf("callId" to cid))
        }
        groupPeers.values.forEach { it.transport?.stop() }
        groupPeers.clear()
        isGroupCall = false
        groupParticipants = emptyList()
        groupHostUserId = ""
        groupRoomLocked = false
        groupMediaMode = "mesh"
        endCall("hangup", notify = false)
    }

    fun hostMuteAll() {
        val ctx = appContext ?: return
        val myId = ctx.getSharedPreferences("rocchat", Context.MODE_PRIVATE).getString("user_id", "") ?: ""
        if (groupHostUserId.isEmpty() || myId != groupHostUserId) return
        sendGroupSignal("meeting_host_mute_all", mapOf("callId" to (callId ?: "")))
    }

    fun toggleGroupRoomLock() {
        val ctx = appContext ?: return
        val myId = ctx.getSharedPreferences("rocchat", Context.MODE_PRIVATE).getString("user_id", "") ?: ""
        if (groupHostUserId.isEmpty() || myId != groupHostUserId) return
        groupRoomLocked = !groupRoomLocked
        sendGroupSignal(if (groupRoomLocked) "meeting_host_lock_room" else "meeting_host_unlock_room", mapOf("callId" to (callId ?: "")))
    }

    private fun addGroupPeer(userId: String) {
        val convId = conversationId ?: return
        val ctx = appContext ?: return
        val secret = SessionManager.p2pMediaSecret(ctx, convId) ?: return
        val transport = P2PTransport(p2pDelegate)
        transport.groupPeerUserId = userId
        val myId = ctx.getSharedPreferences("rocchat", Context.MODE_PRIVATE).getString("user_id", "") ?: ""
        val isInitiator = myId < userId
        groupPeers[userId] = GroupPeer(userId, transport, false)
        transport.start(secret, isInitiator)
    }

    private fun sendGroupSignal(type: String, extra: Map<String, String>) {
        val convId = conversationId
        val payload = JSONObject()
        extra.forEach { (k, v) -> payload.put(k, v) }
        if (convId != null) payload.put("conversationId", convId)
        val msg = JSONObject().put("type", type).put("payload", payload)
        ws?.send(msg.toString())
    }
}

data class GroupPeer(
    val userId: String,
    val transport: P2PTransport?,
    val connected: Boolean
)
