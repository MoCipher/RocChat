package com.rocchat.crypto

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * RocChat Android — Secure Encrypted Storage
 *
 * Wraps SharedPreferences with AES-256-GCM encryption using an
 * Android Keystore-backed master key. All cryptographic secrets
 * (identity keys, ratchet states, session tokens) are encrypted at rest.
 *
 * The master key is hardware-backed on devices with a secure element,
 * and never leaves the Keystore.
 */
object SecureStorage {

    private const val KEYSTORE_ALIAS = "rocchat_master_key"
    private const val PREFS_NAME = "rocchat_encrypted"
    private const val GCM_TAG_LENGTH = 128

    private fun getMasterKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        // Return existing key if present
        keyStore.getEntry(KEYSTORE_ALIAS, null)?.let {
            return (it as KeyStore.SecretKeyEntry).secretKey
        }

        // Generate new AES-256-GCM key in Keystore
        val keyGen = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        )
        keyGen.init(
            KeyGenParameterSpec.Builder(
                KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return keyGen.generateKey()
    }

    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    /**
     * Store an encrypted string value.
     */
    fun set(context: Context, key: String, value: String) {
        try {
            val masterKey = getMasterKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, masterKey)
            val iv = cipher.iv
            val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            // Store as iv:ciphertext both base64-encoded
            val combined = Base64.encodeToString(iv, Base64.NO_WRAP) +
                    ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
            getPrefs(context).edit().putString("enc_$key", combined).apply()
        } catch (_: Exception) { /* best effort */ }
    }

    /**
     * Retrieve and decrypt a string value.
     * Includes automatic migration from plaintext SharedPreferences.
     */
    fun get(context: Context, key: String, legacyPrefsName: String? = null): String? {
        // Try encrypted storage first
        val stored = getPrefs(context).getString("enc_$key", null)
        if (stored != null) {
            try {
                val parts = stored.split(":")
                if (parts.size == 2) {
                    val iv = Base64.decode(parts[0], Base64.NO_WRAP)
                    val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
                    val masterKey = getMasterKey()
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.DECRYPT_MODE, masterKey, GCMParameterSpec(GCM_TAG_LENGTH, iv))
                    return String(cipher.doFinal(encrypted), Charsets.UTF_8)
                }
            } catch (_: Exception) { /* corrupted */ }
        }

        // Migration: check legacy plaintext prefs
        if (legacyPrefsName != null) {
            val legacyPrefs = context.getSharedPreferences(legacyPrefsName, Context.MODE_PRIVATE)
            val plaintext = legacyPrefs.getString(key, null)
            if (plaintext != null) {
                set(context, key, plaintext)
                legacyPrefs.edit().remove(key).apply()
                return plaintext
            }
        }

        return null
    }

    /**
     * Remove a stored value.
     */
    fun remove(context: Context, key: String) {
        getPrefs(context).edit().remove("enc_$key").apply()
    }

    /**
     * Clear all encrypted storage.
     */
    fun clear(context: Context) {
        getPrefs(context).edit().clear().apply()
    }
}
