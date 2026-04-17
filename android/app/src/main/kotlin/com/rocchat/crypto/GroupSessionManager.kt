package com.rocchat.crypto

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// MARK: - Models

data class SenderKeyState(
    var chainKey: ByteArray,
    var iteration: Int,
    val senderIdHash: ByteArray
) {
    fun toJSON(): JSONObject = JSONObject().apply {
        put("chainKey", Base64.encodeToString(chainKey, Base64.NO_WRAP))
        put("iteration", iteration)
        put("senderIdHash", Base64.encodeToString(senderIdHash, Base64.NO_WRAP))
    }
    companion object {
        fun fromJSON(json: JSONObject) = SenderKeyState(
            chainKey = Base64.decode(json.getString("chainKey"), Base64.NO_WRAP),
            iteration = json.getInt("iteration"),
            senderIdHash = Base64.decode(json.getString("senderIdHash"), Base64.NO_WRAP)
        )
    }
}

data class SenderKeyDistribution(
    val senderId: String,
    val groupId: String,
    val chainKey: String,
    val iteration: Int
) {
    fun toJSON(): JSONObject = JSONObject().apply {
        put("senderId", senderId)
        put("groupId", groupId)
        put("chainKey", chainKey)
        put("iteration", iteration)
    }
    companion object {
        fun fromJSON(json: JSONObject) = SenderKeyDistribution(
            senderId = json.getString("senderId"),
            groupId = json.getString("groupId"),
            chainKey = json.getString("chainKey"),
            iteration = json.getInt("iteration")
        )
    }
}

data class GroupEncryptResult(val ciphertext: String, val ratchetHeader: String)

// MARK: - Group Session Manager

class GroupSessionManager private constructor(private val context: Context) {
    companion object {
        @Volatile private var instance: GroupSessionManager? = null
        fun getInstance(context: Context): GroupSessionManager =
            instance ?: synchronized(this) {
                instance ?: GroupSessionManager(context.applicationContext).also { instance = it }
            }

        fun isGroupEncrypted(ratchetHeader: String): Boolean {
            return try {
                JSONObject(ratchetHeader).optBoolean("groupEncrypted", false)
            } catch (_: Exception) { false }
        }
    }

    private val prefs = context.getSharedPreferences("rocchat_group_keys", Context.MODE_PRIVATE)
    private val ownKeys = mutableMapOf<String, SenderKeyState>()
    private val peerKeys = mutableMapOf<String, SenderKeyState>()
    private val distributedTo = mutableMapOf<String, MutableSet<String>>()

    // MARK: - Key Generation

    fun generateSenderKey(): SenderKeyState {
        val random = ByteArray(32)
        SecureRandom().nextBytes(random)
        val hash = MessageDigest.getInstance("SHA-256").digest(random)
        return SenderKeyState(chainKey = random, iteration = 0, senderIdHash = hash)
    }

    // MARK: - Own Key Management

    fun getOrCreateOwnKey(groupId: String): SenderKeyState {
        ownKeys[groupId]?.let { return it }
        loadKey("own_$groupId")?.let {
            ownKeys[groupId] = it
            return it
        }
        val key = generateSenderKey()
        ownKeys[groupId] = key
        saveKey("own_$groupId", key)
        return key
    }

    // MARK: - Peer Key Management

    fun getPeerKey(groupId: String, senderId: String): SenderKeyState? {
        val id = "$groupId:$senderId"
        peerKeys[id]?.let { return it }
        loadKey("peer_$id")?.let {
            peerKeys[id] = it
            return it
        }
        return null
    }

    fun savePeerKey(groupId: String, senderId: String, key: SenderKeyState) {
        val id = "$groupId:$senderId"
        peerKeys[id] = key
        saveKey("peer_$id", key)
    }

    // MARK: - Distribution

    fun createDistribution(senderId: String, groupId: String): SenderKeyDistribution {
        val key = getOrCreateOwnKey(groupId)
        return SenderKeyDistribution(
            senderId = senderId,
            groupId = groupId,
            chainKey = Base64.encodeToString(key.chainKey, Base64.NO_WRAP),
            iteration = key.iteration
        )
    }

    fun importDistribution(dist: SenderKeyDistribution) {
        val chainKey = Base64.decode(dist.chainKey, Base64.NO_WRAP)
        val hash = MessageDigest.getInstance("SHA-256").digest(chainKey)
        val key = SenderKeyState(chainKey = chainKey, iteration = dist.iteration, senderIdHash = hash)
        savePeerKey(dist.groupId, dist.senderId, key)
    }

    suspend fun ensureDistributed(
        groupId: String,
        members: List<String>,
        myUserId: String,
    ): SenderKeyState {
        val senderKey = getOrCreateOwnKey(groupId)
        val distributed = distributedTo.getOrPut(groupId) { mutableSetOf() }
        val others = members.filter { it != myUserId }
        val needs = others.filter { it !in distributed }

        for (memberId in needs) {
            try {
                val dist = createDistribution(myUserId, groupId)
                val distStr = dist.toJSON().toString()

                val envelope = SessionManager.encryptMessage(
                    context, "$groupId:$memberId", memberId, distStr
                )

                val body = JSONObject().apply {
                    put("conversation_id", groupId)
                    put("ciphertext", envelope.ciphertext)
                    put("iv", envelope.iv)
                    put("ratchet_header", envelope.ratchetHeader)
                    put("message_type", "sender_key_distribution")
                }
                com.rocchat.network.APIClient.post("/messages/send", body)
                distributed.add(memberId)
            } catch (_: Exception) {
                // Best effort
            }
        }
        return senderKey
    }

    // MARK: - Chain Advance

    private fun advanceChain(key: SenderKeyState): ByteArray {
        val info = "RocChat_SenderKey_v1".toByteArray()
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.chainKey, "HmacSHA256"))
        mac.update(info)
        val derived = mac.doFinal()

        // Use HKDF-expand for 64 bytes
        val expand1 = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(derived, "HmacSHA256"))
            update(info)
            update(byteArrayOf(1))
        }.doFinal()

        val expand2 = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(derived, "HmacSHA256"))
            update(expand1)
            update(info)
            update(byteArrayOf(2))
        }.doFinal()

        key.chainKey = expand1.copyOf()
        key.iteration++
        return expand2 // message key
    }

    // MARK: - Encrypt

    fun encrypt(groupId: String, plaintext: ByteArray, myUserId: String): GroupEncryptResult {
        val key = getOrCreateOwnKey(groupId)
        val messageKey = advanceChain(key)
        ownKeys[groupId] = key
        saveKey("own_$groupId", key)

        // AES-256-GCM
        val iv = ByteArray(12)
        SecureRandom().nextBytes(iv)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(messageKey, "AES"), GCMParameterSpec(128, iv))
        val ct = cipher.doFinal(plaintext)

        val header = JSONObject().apply {
            put("senderId", myUserId)
            put("iteration", key.iteration)
            put("groupEncrypted", true)
            put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
        }

        return GroupEncryptResult(
            ciphertext = Base64.encodeToString(ct, Base64.NO_WRAP),
            ratchetHeader = header.toString()
        )
    }

    // MARK: - Decrypt

    fun decrypt(groupId: String, senderId: String, ciphertextB64: String, ratchetHeader: String): ByteArray {
        val header = JSONObject(ratchetHeader)
        val iteration = header.getInt("iteration")
        val ivB64 = header.getString("iv")
        val iv = Base64.decode(ivB64, Base64.NO_WRAP)
        val ctData = Base64.decode(ciphertextB64, Base64.NO_WRAP)

        val peerKey = getPeerKey(groupId, senderId) ?: throw IllegalStateException("No sender key for $senderId in group $groupId")

        // Advance to match iteration
        while (peerKey.iteration < iteration) {
            advanceChain(peerKey)
        }

        val messageKey = advanceChain(peerKey)
        savePeerKey(groupId, senderId, peerKey)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(messageKey, "AES"), GCMParameterSpec(128, iv))
        return cipher.doFinal(ctData)
    }

    // MARK: - Handle incoming distribution

    fun handleSenderKeyDistribution(
        groupId: String,
        senderId: String,
        ciphertext: String,
        iv: String,
        ratchetHeader: String,
    ) {
        val decrypted = SessionManager.decryptMessage(context, "$groupId:$senderId", ciphertext, iv, ratchetHeader)
        val dist = SenderKeyDistribution.fromJSON(JSONObject(decrypted))
        importDistribution(dist)
    }

    // MARK: - Key Rotation

    fun rotateSenderKey(groupId: String) {
        val newKey = generateSenderKey()
        ownKeys[groupId] = newKey
        saveKey("own_$groupId", newKey)
        distributedTo.remove(groupId)
    }

    // MARK: - Persistence

    private fun saveKey(key: String, state: SenderKeyState) {
        prefs.edit().putString(key, state.toJSON().toString()).apply()
    }

    private fun loadKey(key: String): SenderKeyState? {
        val json = prefs.getString(key, null) ?: return null
        return try { SenderKeyState.fromJSON(JSONObject(json)) } catch (_: Exception) { null }
    }
}
