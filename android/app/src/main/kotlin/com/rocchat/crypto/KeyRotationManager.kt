package com.rocchat.crypto

import android.content.Context
import com.rocchat.network.APIClient
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec

/**
 * Handles SPK rotation and one-time prekey replenishment on Android.
 * Runs on app launch — non-critical, best-effort.
 */
object KeyRotationManager {
    private const val SPK_ROTATION_INTERVAL_MS = 7L * 24 * 3600 * 1000 // 7 days
    private const val PRE_KEY_THRESHOLD = 10
    private const val PRE_KEY_BATCH_SIZE = 20

    suspend fun performMaintenance(context: Context) {
        maybeRotateSignedPreKey(context)
        checkAndReplenishPreKeys(context)
    }

    private suspend fun maybeRotateSignedPreKey(context: Context) {
        val prefs = context.getSharedPreferences("rocchat_keys", Context.MODE_PRIVATE)
        val lastRotation = prefs.getLong("spk_last_rotation", 0)
        if (System.currentTimeMillis() - lastRotation < SPK_ROTATION_INTERVAL_MS) return

        val identityPrivB64 = prefs.getString("identity_priv", null) ?: return

        try {
            // Generate new X25519 keypair
            val kpg = KeyPairGenerator.getInstance("XDH")
            kpg.initialize(ECGenParameterSpec("X25519"))
            val kp = kpg.generateKeyPair()
            val pubBytes = kp.public.encoded // X.509 encoded
            // Extract raw 32 bytes from X.509 encoding (last 32 bytes)
            val rawPub = pubBytes.takeLast(32).toByteArray()
            val pubB64 = android.util.Base64.encodeToString(rawPub, android.util.Base64.NO_WRAP)

            // Sign with identity key
            val identityPrivBytes = android.util.Base64.decode(identityPrivB64, android.util.Base64.NO_WRAP)
            val signature = RocCrypto.sign(identityPrivBytes, rawPub)
            val sigB64 = android.util.Base64.encodeToString(signature, android.util.Base64.NO_WRAP)

            val spkId = (System.currentTimeMillis() / 1000).toInt()
            val body = JSONObject().apply {
                put("id", spkId)
                put("publicKey", pubB64)
                put("signature", sigB64)
            }

            APIClient.post("/keys/signed", body, method = "PUT")

            prefs.edit()
                .putLong("spk_last_rotation", System.currentTimeMillis())
                .putString("spk_priv", android.util.Base64.encodeToString(kp.private.encoded, android.util.Base64.NO_WRAP))
                .apply()
        } catch (_: Exception) {
            // Non-critical
        }
    }

    private suspend fun checkAndReplenishPreKeys(context: Context) {
        try {
            val resp = APIClient.get("/keys/prekey-count")
            val count = resp.optInt("count", PRE_KEY_THRESHOLD)
            if (count >= PRE_KEY_THRESHOLD) return

            val keys = JSONArray()
            val baseId = (System.currentTimeMillis() / 1000).toInt()
            val kpg = KeyPairGenerator.getInstance("XDH")
            kpg.initialize(ECGenParameterSpec("X25519"))

            for (i in 0 until PRE_KEY_BATCH_SIZE) {
                val kp = kpg.generateKeyPair()
                val rawPub = kp.public.encoded.takeLast(32).toByteArray()
                keys.put(JSONObject().apply {
                    put("id", baseId + i)
                    put("publicKey", android.util.Base64.encodeToString(rawPub, android.util.Base64.NO_WRAP))
                })
            }

            APIClient.post("/keys/prekeys", JSONObject().put("keys", keys))
        } catch (_: Exception) {
            // Non-critical
        }
    }
}
