package com.rocchat.chat

import android.content.Context
import android.util.Base64
import com.rocchat.crypto.SecureStorage
import com.rocchat.network.APIClient
import org.json.JSONObject
import java.net.URL
import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HttpsURLConnection

/**
 * Channel sender-key (E2E) decryption for Android.
 *
 * Mirrors `web/src/crypto/channel-keys.ts` and `ios/.../ChannelKeys.swift`.
 *
 * 1. Fetch envelope from `/api/channels/:id/keys/me`
 * 2. Unwrap with X25519(identity_dh_priv, ephemeral_pub) → HKDF → AES-GCM
 * 3. Cache the channel symmetric key in SecureStorage
 * 4. Decrypt post bodies via HKDF(channelKey) → AES-GCM
 */
object ChannelKeys {

    private const val BASE = "https://rocchat-api.spoass.workers.dev"
    private const val GCM_TAG_LENGTH_BITS = 128
    private val WRAP_INFO = "rocchat-channel-key-wrap-v1".toByteArray()
    private val POST_INFO = "rocchat-channel-post-v1".toByteArray()

    // In-memory cache of channel symmetric keys (also persisted via SecureStorage)
    private val memCache = mutableMapOf<String, ByteArray>()
    private val lock = Any()

    /**
     * Fetch + unwrap the channel symmetric key for the current user. Returns
     * null if no envelope exists yet (admin hasn't distributed a key to this
     * device's identity).
     */
    fun getChannelKey(context: Context, channelId: String): ByteArray? {
        synchronized(lock) {
            memCache[channelId]?.let { return it }
            SecureStorage.get(context, "chankey_$channelId")?.let {
                val raw = Base64.decode(it, Base64.NO_WRAP)
                memCache[channelId] = raw
                return raw
            }
        }

        // Fetch our own envelope
        val token = APIClient.sessionToken ?: return null
        return try {
            val conn = URL("$BASE/api/channels/$channelId/keys/me").openConnection() as HttpsURLConnection
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            if (conn.responseCode == 404) return null
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.bufferedReader().readText()
            val json = JSONObject(body)
            val env = json.optJSONObject("envelope") ?: return null
            val ephPub = Base64.decode(env.optString("ephemeral_pub"), Base64.NO_WRAP)
            val ct = Base64.decode(env.optString("ciphertext"), Base64.NO_WRAP)
            val iv = Base64.decode(env.optString("iv"), Base64.NO_WRAP)
            val tag = Base64.decode(env.optString("tag"), Base64.NO_WRAP)

            val identityDhPrivB64 = SecureStorage.get(context, "identity_dh_priv", "rocchat_keys") ?: return null
            val identityDhPriv = Base64.decode(identityDhPrivB64, Base64.NO_WRAP)

            val ss = x25519DH(identityDhPriv, ephPub)
            val wrapKey = hkdfSha256(ss, channelId.toByteArray(), WRAP_INFO, 32)
            val channelKey = aesGcmOpen(ct, wrapKey, iv, tag) ?: return null

            synchronized(lock) {
                memCache[channelId] = channelKey
                SecureStorage.set(context, "chankey_$channelId", Base64.encodeToString(channelKey, Base64.NO_WRAP))
            }
            channelKey
        } catch (_: Exception) { null }
    }

    /**
     * Decrypt a channel post body. Returns null on any failure (caller can
     * then show a placeholder).
     */
    fun decryptPost(
        context: Context,
        channelId: String,
        ciphertextB64: String,
        ivB64: String,
        ratchetHeader: String,
    ): String? {
        return try {
            val header = JSONObject(ratchetHeader)
            if (header.optInt("cv", 0) != 1) return null
            val tagB64 = header.optString("tag", "")
            if (tagB64.isEmpty()) return null
            val ct = Base64.decode(ciphertextB64, Base64.NO_WRAP)
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            val tag = Base64.decode(tagB64, Base64.NO_WRAP)
            val channelKey = getChannelKey(context, channelId) ?: return null
            val postKey = hkdfSha256(channelKey, channelId.toByteArray(), POST_INFO, 32)
            val plaintext = aesGcmOpen(ct, postKey, iv, tag) ?: return null
            String(plaintext, Charsets.UTF_8)
        } catch (_: Exception) { null }
    }

    // ── Crypto primitives (self-contained) ──

    private fun x25519DH(privateKeyPkcs8: ByteArray, publicKeyRaw: ByteArray): ByteArray {
        val kf = KeyFactory.getInstance("XDH")
        val priv = kf.generatePrivate(PKCS8EncodedKeySpec(privateKeyPkcs8))
        // Wrap raw 32-byte X25519 public key in X.509 SubjectPublicKeyInfo format
        val x509Prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00)
        val pub = kf.generatePublic(X509EncodedKeySpec(x509Prefix + publicKeyRaw))
        val ka = KeyAgreement.getInstance("XDH")
        ka.init(priv)
        ka.doPhase(pub, true)
        return ka.generateSecret()
    }

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var generated = 0
        var counter = 1
        val expandMac = Mac.getInstance("HmacSHA256")
        while (generated < length) {
            expandMac.init(SecretKeySpec(prk, "HmacSHA256"))
            expandMac.update(t)
            expandMac.update(info)
            expandMac.update(byteArrayOf(counter.toByte()))
            t = expandMac.doFinal()
            val take = minOf(t.size, length - generated)
            System.arraycopy(t, 0, out, generated, take)
            generated += take
            counter += 1
        }
        return out
    }

    private fun aesGcmOpen(ciphertext: ByteArray, key: ByteArray, iv: ByteArray, tag: ByteArray): ByteArray? {
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val combined = ciphertext + tag
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
            cipher.doFinal(combined)
        } catch (_: Exception) { null }
    }
}
