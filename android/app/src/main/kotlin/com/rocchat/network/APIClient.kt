package com.rocchat.network

import android.content.Context
import com.rocchat.crypto.SecureStorage
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object APIClient {
    private const val BASE_URL = "https://chat.mocipher.com/api"

    var sessionToken: String? = null
    var refreshToken: String? = null
    private var appContext: Context? = null

    private val pinnedLeafFingerprints = mapOf(
        "chat.mocipher.com" to "9fe88e6203b5c859d5d5afad6b2efe52b3f01bb06ea1b140c43b1b77ebd89dbb",
        "rocchat-api.spoass.workers.dev" to "fced5d78a8da9d40a74f053b91aed908a2a0ef097a8878b002409be9b35eead1",
    )

    fun initialize(context: Context) {
        appContext = context.applicationContext
        val ctx = appContext ?: return
        refreshToken = SecureStorage.get(ctx, "refresh_token", "rocchat")
        if (refreshToken == null) {
            val legacy = ctx.getSharedPreferences("rocchat", Context.MODE_PRIVATE).getString("refresh_token", null)
            if (!legacy.isNullOrEmpty()) {
                refreshToken = legacy
                SecureStorage.set(ctx, "refresh_token", legacy)
                ctx.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit().remove("refresh_token").apply()
            }
        }
    }

    fun clearPersistedAuth() {
        val ctx = appContext ?: return
        SecureStorage.remove(ctx, "session_token")
        SecureStorage.remove(ctx, "refresh_token")
        ctx.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit()
            .remove("session_token")
            .remove("refresh_token")
            .apply()
    }

    private fun persistRefreshToken(token: String?) {
        val ctx = appContext ?: return
        if (token.isNullOrEmpty()) {
            SecureStorage.remove(ctx, "refresh_token")
            ctx.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit().remove("refresh_token").apply()
            return
        }
        SecureStorage.set(ctx, "refresh_token", token)
        ctx.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit().remove("refresh_token").apply()
    }

    private fun responseCodeWithPinning(conn: HttpURLConnection): Int {
        val code = conn.responseCode
        if (conn is HttpsURLConnection) {
            val host = conn.url.host.lowercase()
            val expected = pinnedLeafFingerprints[host]
            if (expected != null) {
                val leaf = conn.serverCertificates.firstOrNull() as? X509Certificate
                    ?: throw IOException("Pinned TLS certificate missing")
                val actual = MessageDigest.getInstance("SHA-256")
                    .digest(leaf.encoded)
                    .joinToString("") { "%02x".format(it) }
                if (!actual.equals(expected, ignoreCase = true)) {
                    throw IOException("Pinned TLS certificate mismatch")
                }
            }
        }
        return code
    }

    // ── Auth ──

    data class LoginResult(
        val sessionToken: String,
        val userId: String,
        val encryptedKeys: String?,
        val identityKey: String?,
    )

    suspend fun login(username: String, authHash: String): LoginResult {
        val body = JSONObject().apply {
            put("username", username)
            put("auth_hash", authHash)
        }
        val json = post("/auth/login", body)
        refreshToken = json.optString("refresh_token", null)
        persistRefreshToken(refreshToken)
        return LoginResult(
            sessionToken = json.getString("session_token"),
            userId = json.getString("user_id"),
            encryptedKeys = json.optString("encrypted_keys", null),
            identityKey = json.optString("identity_key", null),
        )
    }

    suspend fun register(
        username: String,
        displayName: String,
        authHash: String,
        salt: String,
        identityKey: String,
        identityDHKey: String = "",
        identityPrivateEncrypted: String,
        signedPreKeyPublic: String,
        signedPreKeyPrivateEncrypted: String,
        signedPreKeySignature: String,
        oneTimePreKeys: List<String>,
    ): JSONObject {
        // Solve proof-of-work before registration
        val pow = solvePoW()

        val body = JSONObject().apply {
            put("username", username)
            put("display_name", displayName)
            put("auth_hash", authHash)
            put("salt", salt)
            put("identity_key", identityKey)
            if (identityDHKey.isNotEmpty()) put("identity_dh_key", identityDHKey)
            put("identity_private_encrypted", identityPrivateEncrypted)
            put("signed_pre_key_public", signedPreKeyPublic)
            put("signed_pre_key_private_encrypted", signedPreKeyPrivateEncrypted)
            put("signed_pre_key_signature", signedPreKeySignature)
            put("one_time_pre_keys", JSONArray(oneTimePreKeys))
            pow["token"]?.let { put("pow_token", it) }
            pow["nonce"]?.let { put("pow_nonce", it) }
        }
        val json = post("/auth/register", body)
        refreshToken = json.optString("refresh_token", null)
        persistRefreshToken(refreshToken)
        return json
    }

    // ── Conversations ──

    data class ConversationMember(
        val userId: String,
        val username: String,
        val displayName: String,
        val avatarUrl: String?,
    )

    data class Conversation(
        val id: String,
        val type: String,
        val name: String?,
        val members: List<ConversationMember>,
        val lastMessageAt: String?,
        val lastMessageType: String?,
        val muted: Boolean,
        val archived: Boolean,
    )

    suspend fun getConversations(): List<Conversation> {
        val json = get("/messages/conversations")
        val arr = json.optJSONArray("conversations") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val c = arr.getJSONObject(i)
            val archived = c.optBoolean("archived", false)
            if (archived) return@mapNotNull null
            val membersArr = c.optJSONArray("members") ?: JSONArray()
            Conversation(
                id = c.getString("id"),
                type = c.optString("type", "direct"),
                name = c.optString("name", null),
                members = (0 until membersArr.length()).map { j ->
                    val m = membersArr.getJSONObject(j)
                    ConversationMember(
                        userId = m.getString("user_id"),
                        username = m.optString("username", ""),
                        displayName = m.optString("display_name", ""),
                        avatarUrl = m.optString("avatar_url", null),
                    )
                },
                lastMessageAt = c.optString("last_message_at", null),
                lastMessageType = c.optString("last_message_type", null).ifEmpty { null },
                muted = c.optBoolean("muted", false),
                archived = archived,
            )
        }
    }

    data class ChatMessage(
        val id: String,
        val conversationId: String,
        val senderId: String,
        val ciphertext: String,
        val iv: String,
        val ratchetHeader: String,
        val messageType: String,
        val createdAt: String,
        val expiresAt: Long? = null,
        var status: String = "sent",
        val reactions: String? = null,
    )

    suspend fun getMessages(conversationId: String): List<ChatMessage> {
        val json = get("/messages/$conversationId")
        val arr = json.optJSONArray("messages") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val m = arr.getJSONObject(i)
            ChatMessage(
                id = m.getString("id"),
                conversationId = m.optString("conversation_id", conversationId),
                senderId = m.getString("sender_id"),
                ciphertext = m.optString("ciphertext", ""),
                iv = m.optString("iv", ""),
                ratchetHeader = m.optString("ratchet_header", ""),
                messageType = m.optString("message_type", "text"),
                createdAt = m.optString("created_at", ""),
                expiresAt = if (m.has("expires_at") && !m.isNull("expires_at")) m.getLong("expires_at") else null,
                status = m.optString("status", "sent"),
            )
        }
    }

    suspend fun sendMessage(
        conversationId: String,
        ciphertext: String,
        iv: String,
        ratchetHeader: String,
        messageType: String = "text",
        expiresIn: Int = 0,
        replyTo: String? = null,
    ): JSONObject {
        val body = JSONObject().apply {
            put("conversation_id", conversationId)
            put("ciphertext", ciphertext)
            put("iv", iv)
            put("ratchet_header", ratchetHeader)
            put("message_type", messageType)
            if (expiresIn > 0) put("expires_in", expiresIn)
            if (!replyTo.isNullOrEmpty()) put("reply_to", replyTo)
        }
        return post("/messages/send", body)
    }

    suspend fun createConversation(type: String, memberIds: List<String>, encryptedMeta: String? = null): String {
        val body = JSONObject().apply {
            put("type", type)
            put("member_ids", JSONArray(memberIds))
            if (encryptedMeta != null) put("encrypted_meta", encryptedMeta)
        }
        val json = post("/messages/conversations", body)
        return json.getString("conversation_id")
    }

    suspend fun deleteConversation(conversationId: String): JSONObject = delete("/messages/conversations/$conversationId")

    suspend fun muteConversation(conversationId: String): Boolean {
        val json = post("/messages/conversations/$conversationId/mute", JSONObject())
        return json.optBoolean("muted", false)
    }

    suspend fun archiveConversation(conversationId: String): Boolean {
        val json = post("/messages/conversations/$conversationId/archive", JSONObject())
        return json.optBoolean("archived", false)
    }

    // ── Contacts ──

    data class UserSearchResult(
        val userId: String,
        val username: String,
        val displayName: String,
    )

    suspend fun searchUsers(query: String): List<UserSearchResult> {
        val json = get("/contacts/search?q=$query")
        val arr = json.optJSONArray("results") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val u = arr.getJSONObject(i)
            UserSearchResult(
                userId = u.getString("userId"),
                username = u.getString("username"),
                displayName = u.getString("displayName"),
            )
        }
    }

    // ── QR Auth ──

    suspend fun authorizeQrToken(token: String): JSONObject {
        val body = JSONObject().apply { put("qr_token", token) }
        return post("/auth/qr/authorize", body)
    }

    // ── Profile ──

    suspend fun getMe(): JSONObject = get("/me")

    suspend fun updateSettings(settings: Map<String, Any>): JSONObject {
        return post("/me/settings", JSONObject(settings), method = "PATCH")
    }

    // ── HTTP Helpers ──

    suspend fun uploadAvatar(data: ByteArray, contentType: String = "image/jpeg"): JSONObject = withContext(Dispatchers.IO) {
        val conn = (URL("$BASE_URL/me/avatar").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            setRequestProperty("Content-Type", contentType)
            doOutput = true
            connectTimeout = 30_000
            readTimeout = 30_000
        }
        try {
            conn.outputStream.use { it.write(data) }
            val code = responseCodeWithPinning(conn)
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: "{}"
            if (code !in 200..299) throw IOException("HTTP $code: $body")
            JSONObject(body)
        } finally {
            conn.disconnect()
        }
    }

    suspend fun uploadMedia(conversationId: String, data: ByteArray, filename: String, mimeType: String): String = withContext(Dispatchers.IO) {
        val conn = (URL("$BASE_URL/media/upload").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            setRequestProperty("Content-Type", "application/octet-stream")
            setRequestProperty("x-conversation-id", conversationId)
            setRequestProperty("x-encrypted-filename", filename)
            setRequestProperty("x-encrypted-mimetype", mimeType)
            doOutput = true
            connectTimeout = 30_000
            readTimeout = 30_000
        }
        try {
            conn.outputStream.use { it.write(data) }
            val code = responseCodeWithPinning(conn)
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: "{}"
            if (code !in 200..299) throw IOException("HTTP $code: $body")
            JSONObject(body).getString("mediaId")
        } finally {
            conn.disconnect()
        }
    }

    suspend fun postPublic(path: String, body: JSONObject): JSONObject = post(path, body)

    suspend fun get(path: String): JSONObject = withContext(Dispatchers.IO) {
        executeWithRetry {
            val conn = (URL("$BASE_URL$path").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
                connectTimeout = 15_000
                readTimeout = 15_000
            }
            try {
                val code = responseCodeWithPinning(conn)
                val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: "{}"
                if (code !in 200..299) throw IOException("HTTP $code: $body")
                JSONObject(body)
            } finally {
                conn.disconnect()
            }
        }
    }

    suspend fun getArray(path: String): JSONArray = withContext(Dispatchers.IO) {
        val conn = (URL("$BASE_URL$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            connectTimeout = 15_000
            readTimeout = 15_000
        }
        try {
            val code = responseCodeWithPinning(conn)
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: "[]"
            if (code !in 200..299) throw IOException("HTTP $code: $body")
            JSONArray(body)
        } finally {
            conn.disconnect()
        }
    }

    suspend fun getRawBytes(path: String): ByteArray = withContext(Dispatchers.IO) {
        val conn = (URL("$BASE_URL$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            connectTimeout = 15_000
            readTimeout = 30_000
        }
        try {
            val code = responseCodeWithPinning(conn)
            if (code !in 200..299) throw IOException("HTTP $code")
            conn.inputStream.readBytes()
        } finally {
            conn.disconnect()
        }
    }

    suspend fun delete(path: String): JSONObject = withContext(Dispatchers.IO) {
        val conn = (URL("$BASE_URL$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "DELETE"
            sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            connectTimeout = 15_000
            readTimeout = 15_000
        }
        try {
            val code = responseCodeWithPinning(conn)
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: "{}"
            if (code !in 200..299) throw IOException("HTTP $code: $body")
            JSONObject(body)
        } finally {
            conn.disconnect()
        }
    }

    suspend fun post(path: String, body: JSONObject, method: String = "POST"): JSONObject =
        withContext(Dispatchers.IO) {
            executeWithRetry {
                val conn = (URL("$BASE_URL$path").openConnection() as HttpURLConnection).apply {
                    requestMethod = if (method == "PATCH") "POST" else method
                    if (method == "PATCH") setRequestProperty("X-HTTP-Method-Override", "PATCH")
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
                    doOutput = true
                    connectTimeout = 15_000
                    readTimeout = 15_000
                }
                try {
                    conn.outputStream.bufferedWriter().use { it.write(body.toString()) }
                    val code = responseCodeWithPinning(conn)
                    val respBody = (if (code in 200..299) conn.inputStream else conn.errorStream)
                        ?.bufferedReader()?.use { it.readText() } ?: "{}"
                    if (code !in 200..299) throw IOException("HTTP $code: $respBody")
                    JSONObject(respBody)
                } finally {
                    conn.disconnect()
                }
            }
        }

    suspend fun uploadMedia(data: ByteArray): String = withContext(Dispatchers.IO) {
        val conn = (URL("$BASE_URL/media/upload").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/octet-stream")
            sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            doOutput = true
            connectTimeout = 30_000
            readTimeout = 30_000
        }
        try {
            conn.outputStream.use { it.write(data) }
            val code = responseCodeWithPinning(conn)
            val respBody = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: "{}"
            if (code !in 200..299) throw IOException("HTTP $code: $respBody")
            val json = JSONObject(respBody)
            json.optString("blob_id", respBody.trim())
        } finally {
            conn.disconnect()
        }
    }

    // ── Proof-of-Work Solver ──

    private suspend fun solvePoW(): Map<String, String> = withContext(Dispatchers.IO) {
        try {
            val conn = (URL("$BASE_URL/features/pow/challenge").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 15_000
            }
            val json = try {
                val code = responseCodeWithPinning(conn)
                val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: "{}"
                if (code !in 200..299) return@withContext emptyMap()
                JSONObject(body)
            } finally {
                conn.disconnect()
            }
            val token = json.optString("token", "") ?: ""
            val challenge = json.optString("challenge", "") ?: ""
            val difficulty = json.optInt("difficulty", 0)
            if (token.isEmpty() || challenge.isEmpty()) return@withContext emptyMap()
            if (difficulty == 0) return@withContext mapOf("token" to token, "nonce" to "0")

            val md = MessageDigest.getInstance("SHA-256")
            for (nonce in 0 until 10_000_000) {
                md.reset()
                val digest = md.digest("$challenge:$nonce".toByteArray(Charsets.UTF_8))
                if (leadingZeroBits(digest) >= difficulty) {
                    return@withContext mapOf("token" to token, "nonce" to nonce.toString())
                }
            }
            emptyMap()
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun leadingZeroBits(bytes: ByteArray): Int {
        var bits = 0
        for (b in bytes) {
            val unsigned = b.toInt() and 0xFF
            if (unsigned == 0) { bits += 8; continue }
            var mask = 0x80
            while (mask > 0 && (unsigned and mask) == 0) { bits++; mask = mask shr 1 }
            return bits
        }
        return bits
    }

    // ── Refresh Token Rotation ──

    private suspend fun refreshSession(): Boolean = withContext(Dispatchers.IO) {
        val rt = refreshToken ?: SecureStorage.get(appContext ?: return@withContext false, "refresh_token", "rocchat") ?: return@withContext false
        val conn = (URL("$BASE_URL/auth/refresh").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 15_000
        }
        try {
            conn.outputStream.bufferedWriter().use {
                it.write(JSONObject().apply { put("refresh_token", rt) }.toString())
            }
            val code = responseCodeWithPinning(conn)
            if (code !in 200..299) {
                clearPersistedAuth()
                return@withContext false
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            sessionToken = json.optString("session_token", null)
            refreshToken = json.optString("refresh_token", null)
            persistRefreshToken(refreshToken)
            sessionToken != null
        } catch (_: Exception) {
            false
        } finally {
            conn.disconnect()
        }
    }

    private suspend fun <T> executeWithRetry(block: () -> T): T {
        return try {
            block()
        } catch (e: IOException) {
            if (e.message?.startsWith("HTTP 401") == true && refreshSession()) {
                block()
            } else {
                throw e
            }
        }
    }
}
