package com.rocchat.calls

import android.content.Context
import android.media.AudioManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.rocchat.network.NativeWebSocket
import kotlinx.coroutines.*
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

/**
 * RocChat Android — Call Manager
 *
 * Manages WebRTC signaling, media, and call lifecycle.
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

    private var callId: String? = null
    private var conversationId: String? = null
    private var ws: NativeWebSocket? = null
    private var startTime: Long? = null
    private var durationJob: Job? = null
    private var pendingSdp: String? = null
    private var timeoutJob: Job? = null

    fun startCall(
        conversationId: String, remoteUserId: String, remoteName: String,
        callType: String, ws: NativeWebSocket
    ) {
        if (callStatus != "idle") return
        this.callId = UUID.randomUUID().toString()
        this.conversationId = conversationId
        this.remoteUserId = remoteUserId
        this.remoteName = remoteName
        this.callType = callType
        this.callStatus = "outgoing"
        this.ws = ws

        sendSignal("call_offer", mapOf(
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

    fun handleIncomingOffer(payload: JSONObject, conversationId: String, ws: NativeWebSocket?) {
        if (callStatus != "idle" || ws == null) {
            val callId = payload.optString("callId")
            val from = payload.optString("fromUserId")
            if (callId.isNotEmpty() && from.isNotEmpty()) {
                sendSignal("call_end", mapOf("callId" to callId, "reason" to "busy", "targetUserId" to from))
            }
            return
        }
        this.callId = payload.optString("callId")
        this.conversationId = conversationId
        this.remoteUserId = payload.optString("fromUserId")
        this.remoteName = this.remoteUserId.take(8)
        this.callType = payload.optString("callType", "voice")
        this.callStatus = "incoming"
        this.ws = ws
        this.pendingSdp = payload.optString("sdp")

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

        sendSignal("call_answer", mapOf(
            "callId" to (callId ?: ""),
            "targetUserId" to remoteUserId
        ))
    }

    fun declineCall() = endCall("declined")

    fun handleCallAnswer(payload: JSONObject) {
        if (callId != payload.optString("callId")) return
        callStatus = "connected"
        startTime = System.currentTimeMillis()
        startDurationTimer()
        timeoutJob?.cancel()
    }

    fun handleIceCandidate(payload: JSONObject) {
        if (callId != payload.optString("callId")) return
        // Add ICE candidate to peer connection
    }

    fun handleCallEnd(payload: JSONObject) {
        if (callId != payload.optString("callId")) return
        endCall(payload.optString("reason", "hangup"), notify = false)
    }

    fun toggleMute() { isMuted = !isMuted }
    fun toggleCamera() { isCameraOff = !isCameraOff }

    fun endCall(reason: String = "hangup", notify: Boolean = true) {
        if (notify && callId != null) {
            sendSignal("call_end", mapOf(
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
        callId = null
        conversationId = null
        remoteUserId = ""
        remoteName = ""
        callStatus = "idle"
        startTime = null
        callDuration = 0
        isMuted = false
        isCameraOff = false
        pendingSdp = null
    }

    private fun sendSignal(type: String, extra: Map<String, String>) {
        val payload = JSONObject()
        extra.forEach { (k, v) -> payload.put(k, v) }
        val msg = JSONObject().put("type", type).put("payload", payload)
        ws?.send(msg.toString())
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
}
