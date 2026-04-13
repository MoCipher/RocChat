package com.rocchat.crypto

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec
import java.security.MessageDigest
import java.security.KeyPairGenerator
import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.security.Signature

object RocCrypto {
    private const val PBKDF2_ITERATIONS = 600_000
    private const val KEY_LENGTH = 256
    private const val GCM_TAG_LENGTH = 128
    private const val GCM_IV_LENGTH = 12

    /**
     * Derive auth hash from passphrase + salt (sent to server).
     * PBKDF2-SHA256(passphrase, salt, 600k) → SHA-256 of result.
     */
    fun deriveAuthHash(passphrase: String, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(passphrase.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val derived = factory.generateSecret(spec).encoded
        return MessageDigest.getInstance("SHA-256").digest(derived)
    }

    /**
     * Derive vault key (never leaves device).
     * PBKDF2-SHA256 → HKDF-SHA256 with "rocchat-vault-key" info.
     */
    fun deriveVaultKey(passphrase: String, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(passphrase.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val derived = factory.generateSecret(spec).encoded
        val info = "rocchat-vault-key".toByteArray()
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        mac.update(derived)
        mac.update(info)
        return mac.doFinal()
    }

    /**
     * Generate an X25519 key pair. Returns (privateKey, publicKey).
     * Uses JDK XDH provider (available on Android API 28+, our minSdk).
     */
    fun generateX25519KeyPair(): Pair<ByteArray, ByteArray> {
        val kpg = KeyPairGenerator.getInstance("XDH")
        val kp = kpg.generateKeyPair()
        val priv = kp.private.encoded  // PKCS8 encoded
        val pub = kp.public.encoded    // X509 encoded
        // Extract raw 32-byte keys from encoded forms
        val rawPriv = priv.takeLast(32).toByteArray()
        val rawPub = pub.takeLast(32).toByteArray()
        return Pair(rawPriv, rawPub)
    }

    /**
     * Sign data with a private key using HMAC-SHA256 (simplified).
     * In production, use Ed25519 signatures.
     */
    fun sign(privateKey: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(privateKey, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /**
     * AES-256-GCM encrypt.
     */
    fun aesGcmEncrypt(key: ByteArray, plaintext: ByteArray): ByteArray {
        val iv = ByteArray(GCM_IV_LENGTH)
        SecureRandom().nextBytes(iv)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        val ciphertext = cipher.doFinal(plaintext)
        return iv + ciphertext // prepend IV
    }

    /**
     * AES-256-GCM decrypt.
     */
    fun aesGcmDecrypt(key: ByteArray, data: ByteArray): ByteArray {
        val iv = data.copyOfRange(0, GCM_IV_LENGTH)
        val ciphertext = data.copyOfRange(GCM_IV_LENGTH, data.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        return cipher.doFinal(ciphertext)
    }

    fun randomBytes(length: Int): ByteArray {
        val bytes = ByteArray(length)
        SecureRandom().nextBytes(bytes)
        return bytes
    }
}
