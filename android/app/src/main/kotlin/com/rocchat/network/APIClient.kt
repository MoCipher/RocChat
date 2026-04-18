package com.rocchat.network

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object APIClient {
    private const val BASE_URL = "https://chat.mocipher.com/api"

    var sessionToken: String? = null

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

        }
        return post("/auth/register", body)
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

    suspend fun createConversation(type: String, memberIds: List<String>, name: String? = null): String {
        val body = JSONObject().apply {
            put("type", type)
            put("member_ids", JSONArray(memberIds))
            if (name != null) put("name", name)
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

    suspend fun uploadAvatar(data: ByteArray): JSONObject = withContext(Dispatchers.IO) {
        val conn = (URL("$BASE_URL/me/avatar").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            setRequestProperty("Content-Type", "image/jpeg")
            doOutput = true
            connectTimeout = 30_000
            readTimeout = 30_000
        }
        try {
            conn.outputStream.use { it.write(data) }
            val code = conn.responseCode
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
            val code = conn.responseCode
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
        val conn = (URL("$BASE_URL$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            sessionToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            connectTimeout = 15_000
            readTimeout = 15_000
        }
        try {
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: "{}"
            if (code !in 200..299) throw IOException("HTTP $code: $body")
            JSONObject(body)
        } finally {
            conn.disconnect()
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
            val code = conn.responseCode
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
            val code = conn.responseCode
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
            val code = conn.responseCode
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
                val code = conn.responseCode
                val respBody = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: "{}"
                if (code !in 200..299) throw IOException("HTTP $code: $respBody")
                JSONObject(respBody)
            } finally {
                conn.disconnect()
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
            val code = conn.responseCode
            val respBody = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: "{}"
            if (code !in 200..299) throw IOException("HTTP $code: $respBody")
            val json = JSONObject(respBody)
            json.optString("blob_id", respBody.trim())
        } finally {
            conn.disconnect()
        }
    }
}
