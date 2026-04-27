package com.rocchat.crypto

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import com.rocchat.network.APIClient
import java.security.SecureRandom

// MARK: - Models

data class X3DHHeader(
    val identityDHKey: String,
    val ephemeralKey: String,
    val oneTimePreKeyId: Int?
) {
    fun toJSON(): JSONObject = JSONObject().apply {
        put("identityDHKey", identityDHKey)
        put("ephemeralKey", ephemeralKey)
        if (oneTimePreKeyId != null) put("oneTimePreKeyId", oneTimePreKeyId)
    }

    companion object {
        fun fromJSON(json: JSONObject) = X3DHHeader(
            identityDHKey = json.getString("identityDHKey"),
            ephemeralKey = json.getString("ephemeralKey"),
            oneTimePreKeyId = if (json.has("oneTimePreKeyId")) json.getInt("oneTimePreKeyId") else null
        )
    }
}

data class RatchetHeader(
    val dhPublicKey: String,
    val pn: Int,
    val n: Int,
    val tag: String? = null,
    val x3dh: X3DHHeader? = null
) {
    fun toJSON(): JSONObject = JSONObject().apply {
        put("dhPublicKey", dhPublicKey)
        put("pn", pn)
        put("n", n)
        if (tag != null) put("tag", tag)
        if (x3dh != null) put("x3dh", x3dh.toJSON())
    }

    companion object {
        fun fromJSON(json: JSONObject) = RatchetHeader(
            dhPublicKey = json.getString("dhPublicKey"),
            pn = json.getInt("pn"),
            n = json.getInt("n"),
            tag = json.optString("tag", null),
            x3dh = if (json.has("x3dh")) X3DHHeader.fromJSON(json.getJSONObject("x3dh")) else null
        )
    }
}

data class EncryptedEnvelope(
    val ciphertext: String,
    val iv: String,
    val ratchetHeader: String
)

data class RatchetState(
    var dhSendingPublic: ByteArray?,
    var dhSendingPrivate: ByteArray?,
    var dhReceivingKey: ByteArray?,
    var rootKey: ByteArray,
    var sendingChainKey: ByteArray?,
    var receivingChainKey: ByteArray?,
    var sendingMessageNumber: Int,
    var receivingMessageNumber: Int,
    var previousSendingChainLength: Int,
    var skippedKeys: MutableList<SkippedKey>
) {
    fun toJSON(): JSONObject = JSONObject().apply {
        put("dhsPub", dhSendingPublic?.b64())
        put("dhsPriv", dhSendingPrivate?.b64())
        put("dhr", dhReceivingKey?.b64())
        put("rk", rootKey.b64())
        put("cks", sendingChainKey?.b64())
        put("ckr", receivingChainKey?.b64())
        put("ns", sendingMessageNumber)
        put("nr", receivingMessageNumber)
        put("pn", previousSendingChainLength)
        put("skipped", JSONArray().apply {
            skippedKeys.forEach { sk ->
                put(JSONObject().apply {
                    put("dk", sk.dhPublicKey)
                    put("n", sk.messageNumber)
                    put("mk", sk.messageKey.b64())
                })
            }
        })
    }

    companion object {
        fun fromJSON(json: JSONObject): RatchetState = RatchetState(
            dhSendingPublic = json.optString("dhsPub", null)?.fromB64(),
            dhSendingPrivate = json.optString("dhsPriv", null)?.fromB64(),
            dhReceivingKey = json.optString("dhr", null)?.fromB64(),
            rootKey = json.getString("rk").fromB64(),
            sendingChainKey = json.optString("cks", null)?.fromB64(),
            receivingChainKey = json.optString("ckr", null)?.fromB64(),
            sendingMessageNumber = json.getInt("ns"),
            receivingMessageNumber = json.getInt("nr"),
            previousSendingChainLength = json.getInt("pn"),
            skippedKeys = mutableListOf<SkippedKey>().apply {
                val arr = json.getJSONArray("skipped")
                for (i in 0 until arr.length()) {
                    val sk = arr.getJSONObject(i)
                    add(SkippedKey(sk.getString("dk"), sk.getInt("n"), sk.getString("mk").fromB64()))
                }
            }
        )
    }
}

data class SkippedKey(
    val dhPublicKey: String,
    val messageNumber: Int,
    val messageKey: ByteArray
)

// MARK: - Extensions

private fun ByteArray.b64(): String = Base64.encodeToString(this, Base64.NO_WRAP)
private fun String.fromB64(): ByteArray = Base64.decode(this, Base64.NO_WRAP)

// MARK: - Crypto Primitives

private object CryptoPrimitives {
    private val CHAIN_KEY_SEED = "RocChat_ChainKey".toByteArray()
    private val MESSAGE_KEY_SEED = "RocChat_MessageKey".toByteArray()
    private val RATCHET_INFO = "RocChat_Ratchet_v1".toByteArray()
    private val X3DH_INFO = "RocChat_X3DH_v1".toByteArray()
    private val X3DH_SALT = ByteArray(32)
    const val MAX_SKIP = 256

    // X25519 key pair: returns (publicKey, privateKey) as raw 32-byte arrays
    fun generateX25519(): Pair<ByteArray, ByteArray> {
        val kpg = KeyPairGenerator.getInstance("XDH")
        val kp = kpg.generateKeyPair()
        val pub = kp.public.encoded.takeLast(32).toByteArray()
        val priv = kp.private.encoded // PKCS8 encoded — needed for KeyAgreement
        return Pair(pub, priv)
    }

    fun x25519DH(privateKeyPkcs8: ByteArray, publicKeyRaw: ByteArray): ByteArray {
        val privSpec = PKCS8EncodedKeySpec(privateKeyPkcs8)
        val kf = KeyFactory.getInstance("XDH")
        val privKey = kf.generatePrivate(privSpec)

        // Wrap raw 32-byte public key in X509 encoding
        val x509Prefix = byteArrayOf(
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00
        )
        val pubKeyEncoded = x509Prefix + publicKeyRaw
        val pubSpec = X509EncodedKeySpec(pubKeyEncoded)
        val pubKey = kf.generatePublic(pubSpec)

        val ka = KeyAgreement.getInstance("XDH")
        ka.init(privKey)
        ka.doPhase(pubKey, true)
        return ka.generateSecret()
    }

    fun hmacSHA256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    // HKDF-SHA256 (extract-then-expand)
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        // Extract
        val prk = hmacSHA256(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        // Expand
        var t = ByteArray(0)
        val result = ByteArray(length)
        var offset = 0
        var counter: Byte = 1
        while (offset < length) {
            val input = t + info + byteArrayOf(counter)
            t = hmacSHA256(prk, input)
            val toCopy = minOf(t.size, length - offset)
            System.arraycopy(t, 0, result, offset, toCopy)
            offset += toCopy
            counter++
        }
        return result
    }

    fun aesGcmEncrypt(key: ByteArray, plaintext: ByteArray, aad: ByteArray): Triple<ByteArray, ByteArray, ByteArray> {
        val iv = ByteArray(12)
        SecureRandom().nextBytes(iv)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad)
        val ctWithTag = cipher.doFinal(plaintext)
        // Java AES-GCM appends 16-byte tag
        val ct = ctWithTag.copyOfRange(0, ctWithTag.size - 16)
        val tag = ctWithTag.copyOfRange(ctWithTag.size - 16, ctWithTag.size)
        return Triple(ct, iv, tag)
    }

    fun aesGcmDecrypt(key: ByteArray, ciphertext: ByteArray, iv: ByteArray, tag: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad)
        return cipher.doFinal(ciphertext + tag) // Java expects ct+tag combined
    }

    // KDF chains
    fun kdfRootKey(rootKey: ByteArray, dhOutput: ByteArray): Pair<ByteArray, ByteArray> {
        val derived = hkdf(dhOutput, rootKey, RATCHET_INFO, 64)
        return Pair(derived.copyOfRange(0, 32), derived.copyOfRange(32, 64))
    }

    fun kdfChainKey(chainKey: ByteArray): Pair<ByteArray, ByteArray> {
        val newCK = hmacSHA256(chainKey, CHAIN_KEY_SEED)
        val mk = hmacSHA256(chainKey, MESSAGE_KEY_SEED)
        return Pair(newCK, mk)
    }

    // X3DH shared secret derivation
    fun x3dhDeriveSecret(dhConcat: ByteArray): ByteArray {
        return hkdf(dhConcat, X3DH_SALT, X3DH_INFO, 32)
    }

    // Double Ratchet init
    fun initSender(sharedSecret: ByteArray, theirSignedPreKey: ByteArray): RatchetState {
        val (pub, priv) = generateX25519()
        val dhOut = x25519DH(priv, theirSignedPreKey)
        val (rk, ck) = kdfRootKey(sharedSecret, dhOut)
        return RatchetState(pub, priv, theirSignedPreKey, rk, ck, null, 0, 0, 0, mutableListOf())
    }

    fun initReceiver(sharedSecret: ByteArray, ourSPKPub: ByteArray, ourSPKPriv: ByteArray): RatchetState {
        return RatchetState(ourSPKPub, ourSPKPriv, null, sharedSecret, null, null, 0, 0, 0, mutableListOf())
    }

    // Encrypt
    fun ratchetEncrypt(state: RatchetState, plaintext: ByteArray): Pair<Triple<ByteArray, ByteArray, ByteArray>, RatchetHeader> {
        val ck = state.sendingChainKey ?: throw IllegalStateException("Not initialized")
        val dhPub = state.dhSendingPublic ?: throw IllegalStateException("Not initialized")
        val (newCK, mk) = kdfChainKey(ck)
        state.sendingChainKey = newCK

        val header = RatchetHeader(dhPub.b64(), state.previousSendingChainLength, state.sendingMessageNumber)
        val aad = dhPub + "${header.pn}:${header.n}".toByteArray()
        val (ct, iv, tag) = aesGcmEncrypt(mk, plaintext, aad)
        state.sendingMessageNumber++
        return Pair(Triple(ct, iv, tag), header)
    }

    // Decrypt
    fun ratchetDecrypt(state: RatchetState, ciphertext: ByteArray, iv: ByteArray, tag: ByteArray, header: RatchetHeader): ByteArray {
        val dhPubData = header.dhPublicKey.fromB64()

        // Check skipped keys
        val skipIdx = state.skippedKeys.indexOfFirst { it.dhPublicKey == header.dhPublicKey && it.messageNumber == header.n }
        if (skipIdx >= 0) {
            val mk = state.skippedKeys[skipIdx].messageKey
            state.skippedKeys.removeAt(skipIdx)
            val aad = dhPubData + "${header.pn}:${header.n}".toByteArray()
            return aesGcmDecrypt(mk, ciphertext, iv, tag, aad)
        }

        // DH ratchet step if new key
        val currentDHB64 = state.dhReceivingKey?.b64()
        if (header.dhPublicKey != currentDHB64) {
            if (state.receivingChainKey != null) {
                skipMessages(state, header.pn)
            }
            state.dhReceivingKey = dhPubData
            if (state.dhSendingPrivate != null && state.dhReceivingKey != null) {
                val dhOut = x25519DH(state.dhSendingPrivate!!, state.dhReceivingKey!!)
                val (rk, ck) = kdfRootKey(state.rootKey, dhOut)
                state.rootKey = rk
                state.receivingChainKey = ck
                state.receivingMessageNumber = 0
            }
            state.previousSendingChainLength = state.sendingMessageNumber
            state.sendingMessageNumber = 0
            val (newPub, newPriv) = generateX25519()
            state.dhSendingPublic = newPub
            state.dhSendingPrivate = newPriv
            val dhOut2 = x25519DH(newPriv, state.dhReceivingKey!!)
            val (rk2, ck2) = kdfRootKey(state.rootKey, dhOut2)
            state.rootKey = rk2
            state.sendingChainKey = ck2
        }

        skipMessages(state, header.n)

        val rck = state.receivingChainKey ?: throw IllegalStateException("No receiving chain key")
        val (newCK, mk) = kdfChainKey(rck)
        state.receivingChainKey = newCK
        state.receivingMessageNumber++

        val aad = dhPubData + "${header.pn}:${header.n}".toByteArray()
        return aesGcmDecrypt(mk, ciphertext, iv, tag, aad)
    }

    private fun skipMessages(state: RatchetState, until: Int) {
        val rck = state.receivingChainKey ?: return
        if (until - state.receivingMessageNumber > MAX_SKIP) throw IllegalStateException("Too many skipped")
        var ck = rck
        while (state.receivingMessageNumber < until) {
            val (newCK, mk) = kdfChainKey(ck)
            ck = newCK
            state.skippedKeys.add(SkippedKey(state.dhReceivingKey?.b64() ?: "", state.receivingMessageNumber, mk))
            state.receivingMessageNumber++
        }
        state.receivingChainKey = ck
    }
}

// MARK: - Session Manager

object SessionManager {
    private val cache = mutableMapOf<String, RatchetState>()
    private val pendingX3DH = mutableMapOf<String, X3DHHeader>()

    var identityDHPublic: ByteArray? = null
    var identityDHPrivate: ByteArray? = null   // PKCS8 encoded
    var signedPreKeyPublic: ByteArray? = null
    var signedPreKeyPrivate: ByteArray? = null  // PKCS8 encoded
    var oneTimePreKeys: List<Triple<Int, ByteArray, ByteArray>> = emptyList() // (id, priv, pub)

    private const val STATE_PREFS = "rocchat_ratchet_states"

    fun generateAndCacheIdentityDH(context: Context) {
        if (identityDHPublic != null) return
        val savedPub = SecureStorage.get(context, "identity_dh_pub", "rocchat_keys")
        val savedPriv = SecureStorage.get(context, "identity_dh_priv", "rocchat_keys")
        if (savedPub != null && savedPriv != null) {
            identityDHPublic = savedPub.fromB64()
            identityDHPrivate = savedPriv.fromB64()
            return
        }
        val (pub, priv) = CryptoPrimitives.generateX25519()
        identityDHPublic = pub
        identityDHPrivate = priv
        SecureStorage.set(context, "identity_dh_pub", pub.b64())
        SecureStorage.set(context, "identity_dh_priv", priv.b64())
    }

    fun cacheKeyMaterial(context: Context, spkPub: ByteArray, spkPriv: ByteArray, otpKeys: List<Triple<Int, ByteArray, ByteArray>>) {
        signedPreKeyPublic = spkPub
        signedPreKeyPrivate = spkPriv
        oneTimePreKeys = otpKeys
        SecureStorage.set(context, "spk_pub", spkPub.b64())
        SecureStorage.set(context, "spk_priv", spkPriv.b64())
    }

    fun loadCachedKeyMaterial(context: Context) {
        generateAndCacheIdentityDH(context)
        SecureStorage.get(context, "spk_pub", "rocchat_keys")?.let { signedPreKeyPublic = it.fromB64() }
        SecureStorage.get(context, "spk_priv", "rocchat_keys")?.let { signedPreKeyPrivate = it.fromB64() }
    }

    // State persistence
    private fun saveState(context: Context, conversationId: String, state: RatchetState) {
        SecureStorage.set(context, "ratchet_$conversationId", state.toJSON().toString())
    }

    private fun loadState(context: Context, conversationId: String): RatchetState? {
        val json = SecureStorage.get(context, "ratchet_$conversationId", STATE_PREFS) ?: return null
        return try { RatchetState.fromJSON(JSONObject(json)) } catch (_: Exception) { null }
    }

    // X3DH
    private suspend fun performX3DH(context: Context, conversationId: String, recipientUserId: String): RatchetState {
        val idDHPriv = identityDHPrivate ?: throw IllegalStateException("No identity DH key")
        val idDHPub = identityDHPublic ?: throw IllegalStateException("No identity DH key")

        val bundleJson = APIClient.get("/keys/bundle/$recipientUserId")

        val identityDHKeyB64 = bundleJson.optString("identityDHKey", bundleJson.optString("identityKey", ""))
        val theirIdentityDH = identityDHKeyB64.fromB64()

        val spk = bundleJson.getJSONObject("signedPreKey")
        val spkPub = spk.getString("publicKey").fromB64()

        val eph = CryptoPrimitives.generateX25519()

        val dh1 = CryptoPrimitives.x25519DH(idDHPriv, spkPub)
        val dh2 = CryptoPrimitives.x25519DH(eph.second, theirIdentityDH)
        val dh3 = CryptoPrimitives.x25519DH(eph.second, spkPub)

        var dhConcat = dh1 + dh2 + dh3
        var usedOTPId: Int? = null

        if (bundleJson.has("oneTimePreKey") && !bundleJson.isNull("oneTimePreKey")) {
            val otp = bundleJson.getJSONObject("oneTimePreKey")
            val otpPub = otp.getString("publicKey").fromB64()
            val otpId = otp.getInt("id")
            val dh4 = CryptoPrimitives.x25519DH(eph.second, otpPub)
            dhConcat += dh4
            usedOTPId = otpId
        }

        val sharedSecret = CryptoPrimitives.x3dhDeriveSecret(dhConcat)

        pendingX3DH[conversationId] = X3DHHeader(
            identityDHKey = idDHPub.b64(),
            ephemeralKey = eph.first.b64(),
            oneTimePreKeyId = usedOTPId
        )

        return CryptoPrimitives.initSender(sharedSecret, spkPub)
    }

    private fun handleX3DHResponder(x3dhHeader: X3DHHeader): RatchetState {
        val idDHPriv = identityDHPrivate ?: throw IllegalStateException("No identity DH key")
        val spkPub = signedPreKeyPublic ?: throw IllegalStateException("No SPK")
        val spkPriv = signedPreKeyPrivate ?: throw IllegalStateException("No SPK")
        val theirIdDH = x3dhHeader.identityDHKey.fromB64()
        val theirEph = x3dhHeader.ephemeralKey.fromB64()

        val dh1 = CryptoPrimitives.x25519DH(spkPriv, theirIdDH)
        val dh2 = CryptoPrimitives.x25519DH(idDHPriv, theirEph)
        val dh3 = CryptoPrimitives.x25519DH(spkPriv, theirEph)

        var dhConcat = dh1 + dh2 + dh3

        x3dhHeader.oneTimePreKeyId?.let { otpId ->
            oneTimePreKeys.find { it.first == otpId }?.let { otp ->
                val dh4 = CryptoPrimitives.x25519DH(otp.second, theirEph)
                dhConcat += dh4
            }
        }

        val sharedSecret = CryptoPrimitives.x3dhDeriveSecret(dhConcat)
        return CryptoPrimitives.initReceiver(sharedSecret, spkPub, spkPriv)
    }

    // Public API

    suspend fun getOrCreateSession(context: Context, conversationId: String, recipientUserId: String): RatchetState {
        cache[conversationId]?.let { return it }
        loadState(context, conversationId)?.let {
            cache[conversationId] = it
            return it
        }
        val state = performX3DH(context, conversationId, recipientUserId)
        cache[conversationId] = state
        saveState(context, conversationId, state)
        return state
    }

    suspend fun encryptMessage(context: Context, conversationId: String, recipientUserId: String, plaintext: String): EncryptedEnvelope {
        val state = getOrCreateSession(context, conversationId, recipientUserId)
        val (ctIvTag, header) = CryptoPrimitives.ratchetEncrypt(state, plaintext.toByteArray())

        cache[conversationId] = state
        saveState(context, conversationId, state)

        val headerObj = header.copy(tag = ctIvTag.third.b64())
        val finalHeader = if (pendingX3DH.containsKey(conversationId)) {
            val x3dh = pendingX3DH.remove(conversationId)
            headerObj.copy(x3dh = x3dh)
        } else headerObj

        return EncryptedEnvelope(
            ciphertext = ctIvTag.first.b64(),
            iv = ctIvTag.second.b64(),
            ratchetHeader = finalHeader.toJSON().toString()
        )
    }

    fun decryptMessage(context: Context, conversationId: String, ciphertext: String, iv: String, ratchetHeaderStr: String): String {
        val ctData: ByteArray
        val ivData: ByteArray
        val headerJson: JSONObject
        try {
            ctData = ciphertext.fromB64()
            ivData = iv.fromB64()
            headerJson = JSONObject(ratchetHeaderStr)
        } catch (e: Exception) {
            throw IllegalArgumentException("Invalid encrypted payload", e)
        }

        val header: RatchetHeader
        try {
            header = RatchetHeader.fromJSON(headerJson)
        } catch (e: Exception) {
            throw IllegalArgumentException("Invalid ratchet header", e)
        }

        val tagB64 = header.tag ?: throw IllegalArgumentException("Missing authentication tag")
        val tagData: ByteArray
        try { tagData = tagB64.fromB64() } catch (e: Exception) { throw IllegalArgumentException("Invalid tag encoding", e) }

        var state: RatchetState? = cache[conversationId] ?: loadState(context, conversationId)
        if (state == null && header.x3dh != null) {
            state = handleX3DHResponder(header.x3dh)
        }
        if (state == null) throw IllegalStateException("No session for conversation $conversationId")

        val decrypted = CryptoPrimitives.ratchetDecrypt(state, ctData, ivData, tagData, header)
        cache[conversationId] = state
        saveState(context, conversationId, state)
        return String(decrypted)
    }

    fun clearAllSessions(context: Context) {
        cache.clear()
        pendingX3DH.clear()
        SecureStorage.clear(context)
    }

    /**
     * Derive a stable 32-byte media-layer secret for RocP2P from the current ratchet
     * root key. Mirrors SessionManager.p2pMediaSecret on iOS so a cross-platform call
     * between an Android and an iOS peer produces identical P2P keys.
     */
    fun p2pMediaSecret(context: Context, conversationId: String): ByteArray? {
        val state = cache[conversationId] ?: loadState(context, conversationId) ?: return null
        return CryptoPrimitives.hkdf(
            state.rootKey,
            "rocchat-media-root-v1".toByteArray(),
            "rocchat.media".toByteArray(),
            32,
        )
    }

    /** Encrypt raw file data with a random AES-256-GCM key. Returns combined IV+ciphertext+tag. */
    fun encryptFileData(context: Context, data: ByteArray): ByteArray {
        val key = javax.crypto.KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv
        val encrypted = cipher.doFinal(data)
        // Return iv + encrypted (which includes GCM tag)
        return iv + encrypted
    }
}
