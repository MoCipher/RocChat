package com.rocchat.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import com.rocchat.network.APIClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Push notification manager for RocChat via ntfy.sh.
 *
 * Uses Server-Sent Events (SSE) to subscribe to a per-user ntfy.sh topic.
 * No Google account or FCM required — ntfy.sh is free and open-source.
 */
object PushManager {
    private const val CHANNEL_ID = "rocchat_messages"
    private const val CHANNEL_NAME = "Messages"
    private var sseJob: Job? = null

    fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "New message notifications"
                enableVibration(true)
            }
            val mgr = context.getSystemService(NotificationManager::class.java)
            mgr.createNotificationChannel(channel)
        }
    }

    fun showMessageNotification(context: Context, senderName: String, notificationId: Int = System.currentTimeMillis().toInt()) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle("RocChat")
            .setContentText("New message from $senderName")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()

        val mgr = context.getSystemService(NotificationManager::class.java)
        mgr.notify(notificationId, notification)
    }

    /** Generate a unique ntfy topic for a user (hashed for privacy). */
    fun topicForUser(userId: String): String {
        val hash = MessageDigest.getInstance("SHA-256")
            .digest("rocchat-$userId".toByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(24)
        return "rocchat-$hash"
    }

    /** Register the ntfy topic with the backend and start listening. */
    fun registerAndSubscribe(context: Context, userId: String) {
        val topic = topicForUser(userId)

        // Register the topic with our backend
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val body = org.json.JSONObject().apply {
                    put("token", topic)
                    put("platform", "ntfy")
                }
                APIClient.postPublic("/push/register", body)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }

        // Start SSE listener
        subscribe(context, topic)
    }

    /** Subscribe to self-hosted ntfy instance via SSE for real-time push. */
    private fun subscribe(context: Context, topic: String) {
        sseJob?.cancel()
        sseJob = CoroutineScope(Dispatchers.IO).launch {
            while (isActive) {
                try {
                    // Self-hosted ntfy — no third-party dependency
                    val ntfyBase = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                        .getString("ntfy_url", "https://ntfy.roc.family") ?: "https://ntfy.roc.family"
                    val url = URL("$ntfyBase/$topic/sse")
                    val conn = url.openConnection() as HttpURLConnection
                    conn.setRequestProperty("Accept", "text/event-stream")
                    conn.connectTimeout = 15_000
                    conn.readTimeout = 0 // SSE — no read timeout

                    val reader = BufferedReader(InputStreamReader(conn.inputStream))
                    var line: String? = null
                    while (isActive && reader.readLine().also { line = it } != null) {
                        val l = line ?: continue
                        if (l.startsWith("data: ")) {
                            val data = l.removePrefix("data: ").trim()
                            if (data.isNotEmpty() && data != "keepalive") {
                                // Extract sender from "New message from <name>"
                                val sender = if (data.startsWith("New message from ")) {
                                    data.removePrefix("New message from ")
                                } else {
                                    "Someone"
                                }
                                showMessageNotification(context, sender)
                            }
                        }
                    }
                    reader.close()
                    conn.disconnect()
                } catch (_: Exception) {
                    // Reconnect after a delay on error
                }
                // Wait before reconnecting
                kotlinx.coroutines.delay(5_000)
            }
        }
    }

    /** Stop the SSE listener. */
    fun unsubscribe() {
        sseJob?.cancel()
        sseJob = null
    }
}
