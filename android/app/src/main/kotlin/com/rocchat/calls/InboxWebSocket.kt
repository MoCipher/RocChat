package com.rocchat.calls

import android.content.Context
import com.rocchat.crypto.SecureStorage
import com.rocchat.network.APIClient
import com.rocchat.network.NativeWebSocket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.min
import kotlin.math.pow

/**
 * RocChat Android — User Inbox WebSocket.
 *
 * A long-lived WebSocket to `/api/ws/user/{userId}` that stays open while the
 * user is logged in. Carries call signaling (`call_offer`, `call_answer`,
 * `call_ice`, `call_end`, `call_audio`, `call_video`, `call_p2p_candidate`)
 * so calls reach the callee even when they have no conversation open.
 */
object InboxWebSocket {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    @Volatile var task: NativeWebSocket? = null
        private set
    private var manuallyClosed = false
    private var reconnectAttempt = 0
    private var reconnectJob: Job? = null
    private val listeners = mutableListOf<(String, JSONObject) -> Unit>()
    private var lastUserId: String? = null
    private var lastToken: String? = null
    private var lastContext: Context? = null

    /** One-shot default routing for call frames — avoids duplicate handlers when auth recomposes. */
    private var defaultCallRoutingAttached = false
    private val defaultCallRoutingListener: (String, JSONObject) -> Unit = { type, payload ->
        when (type) {
            "call_offer" -> CallManager.handleIncomingOffer(
                payload,
                payload.optString("conversationId"),
                task,
                lastContext,
            )
            "call_answer" -> CallManager.handleCallAnswer(payload)
            "call_ice" -> CallManager.handleIceCandidate(payload)
            "call_end" -> CallManager.handleCallEnd(payload)
            "call_audio" -> CallManager.handleCallAudio(payload)
            "call_video" -> CallManager.handleCallVideo(payload)
            "call_p2p_candidate" -> CallManager.handleP2PCandidate(payload)
        }
    }

    fun addListener(listener: (String, JSONObject) -> Unit) {
        synchronized(listeners) { listeners.add(listener) }
    }

    fun removeListener(listener: (String, JSONObject) -> Unit) {
        synchronized(listeners) { listeners.remove(listener) }
    }

    /** Registers inbox call signaling once per login; idempotent. */
    fun ensureDefaultCallRouting(context: Context) {
        synchronized(listeners) {
            if (!defaultCallRoutingAttached) {
                listeners.add(defaultCallRoutingListener)
                defaultCallRoutingAttached = true
            }
        }
        connect(context)
    }

    /** Open the inbox WebSocket. Idempotent. */
    fun connect(context: Context) {
        val current = task
        if (current != null) return

        val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
        val userId = prefs.getString("user_id", "") ?: ""
        val token = SecureStorage.get(context, "session_token", "rocchat")
            ?: prefs.getString("session_token", "") ?: ""
        if (userId.isEmpty() || token.isEmpty()) return

        manuallyClosed = false
        lastUserId = userId
        lastToken = token
        lastContext = context.applicationContext
        APIClient.sessionToken = token

        val listener = object : NativeWebSocket.Listener {
            override fun onOpen(ws: NativeWebSocket) {
                reconnectAttempt = 0
            }
            override fun onMessage(ws: NativeWebSocket, text: String) {
                try {
                    val data = JSONObject(text)
                    val type = data.optString("type")
                    val payload = data.optJSONObject("payload") ?: return
                    val snapshot: List<(String, JSONObject) -> Unit> = synchronized(listeners) { listeners.toList() }
                    snapshot.forEach { it(type, payload) }
                } catch (_: Exception) { /* malformed frame */ }
            }
            override fun onClosed(ws: NativeWebSocket, code: Int, reason: String) {
                task = null
                if (!manuallyClosed) scheduleReconnect(context)
            }
            override fun onFailure(ws: NativeWebSocket, error: Throwable) {
                task = null
                if (!manuallyClosed) scheduleReconnect(context)
            }
        }
        scope.launch {
            try {
                val ticket = APIClient.getWebSocketTicket()
                val url = "wss://rocchat-api.spoass.workers.dev/api/ws/user/$userId" +
                    "?userId=$userId&deviceId=android&ticket=$ticket"
                task = NativeWebSocket.connect(url, listener)
            } catch (_: Exception) {
                scheduleReconnect(context)
            }
        }
    }

    private fun scheduleReconnect(context: Context) {
        reconnectJob?.cancel()
        reconnectAttempt += 1
        val delayMs = min(30_000L, (1000.0 * 2.0.pow(min(reconnectAttempt, 5))).toLong())
        reconnectJob = scope.launch {
            delay(delayMs)
            if (!manuallyClosed) connect(context)
        }
    }

    /** Send a JSON message; returns true if the WS was available. */
    fun send(message: JSONObject): Boolean {
        val ws = task ?: return false
        return try {
            ws.send(message.toString())
            true
        } catch (_: Exception) {
            false
        }
    }

    fun disconnect() {
        manuallyClosed = true
        reconnectJob?.cancel()
        try { task?.close(1000, "logout") } catch (_: Exception) {}
        task = null
        reconnectAttempt = 0
        synchronized(listeners) {
            if (defaultCallRoutingAttached) {
                listeners.remove(defaultCallRoutingListener)
                defaultCallRoutingAttached = false
            }
        }
    }
}
