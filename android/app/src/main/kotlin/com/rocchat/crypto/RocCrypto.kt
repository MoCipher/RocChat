package com.rocchat.crypto

import android.os.Build
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
import java.security.spec.NamedParameterSpec
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

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
     * PBKDF2-SHA256 → HKDF-SHA256 with "rocchat-vault-key" info (matches web/iOS).
     */
    fun deriveVaultKey(passphrase: String, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(passphrase.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val derived = factory.generateSecret(spec).encoded
        val info = "rocchat-vault-key".toByteArray()
        return hkdf(derived, salt, info, 32)
    }

    /**
     * HKDF-SHA256 (extract-then-expand, RFC 5869).
     */
    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        // Extract
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        // Expand
        var t = ByteArray(0)
        val result = ByteArray(length)
        var offset = 0
        var counter: Byte = 1
        while (offset < length) {
            val expandMac = Mac.getInstance("HmacSHA256")
            expandMac.init(SecretKeySpec(prk, "HmacSHA256"))
            expandMac.update(t)
            expandMac.update(info)
            expandMac.update(byteArrayOf(counter))
            t = expandMac.doFinal()
            val toCopy = minOf(t.size, length - offset)
            System.arraycopy(t, 0, result, offset, toCopy)
            offset += toCopy
            counter++
        }
        return result
    }

    /**
     * Generate an X25519 key pair. Returns (privateKey as PKCS8, publicKey as raw 32 bytes).
     * Uses JDK XDH provider (available on Android API 28+, our minSdk).
     */
    fun generateX25519KeyPair(): Pair<ByteArray, ByteArray> {
        val kpg = KeyPairGenerator.getInstance("XDH")
        val kp = kpg.generateKeyPair()
        val priv = kp.private.encoded  // PKCS8 encoded — needed for KeyAgreement
        val pub = kp.public.encoded    // X509 encoded
        // Extract raw 32-byte public key from X509 encoding
        val rawPub = pub.takeLast(32).toByteArray()
        return Pair(priv, rawPub)
    }

    /**
     * Generate an Ed25519 key pair for identity signing.
     * Returns (privateKey bytes, publicKey raw 32 bytes).
     * Uses JDK on API 33+, BouncyCastle on API 28-32.
     */
    fun generateEd25519KeyPair(): Pair<ByteArray, ByteArray> {
        if (Build.VERSION.SDK_INT >= 33) {
            val kpg = KeyPairGenerator.getInstance("Ed25519")
            val kp = kpg.generateKeyPair()
            val priv = kp.private.encoded
            val rawPub = kp.public.encoded.takeLast(32).toByteArray()
            return Pair(priv, rawPub)
        }
        // BouncyCastle fallback for API 28-32
        val privParams = Ed25519PrivateKeyParameters(SecureRandom())
        val pubParams = privParams.generatePublicKey()
        return Pair(privParams.encoded, pubParams.encoded)
    }

    /**
     * Sign data with an Ed25519 private key.
     * Uses JDK on API 33+, BouncyCastle on API 28-32.
     */
    fun sign(privateKeyBytes: ByteArray, data: ByteArray): ByteArray {
        if (Build.VERSION.SDK_INT >= 33) {
            // privateKeyBytes is PKCS8 on API 33+
            val kf = KeyFactory.getInstance("Ed25519")
            val privKey = kf.generatePrivate(PKCS8EncodedKeySpec(privateKeyBytes))
            val sig = Signature.getInstance("Ed25519")
            sig.initSign(privKey)
            sig.update(data)
            return sig.sign()
        }
        // BouncyCastle fallback — privateKeyBytes is raw 32 bytes
        val privParams = Ed25519PrivateKeyParameters(privateKeyBytes, 0)
        val signer = Ed25519Signer()
        signer.init(true, privParams)
        signer.update(data, 0, data.size)
        return signer.generateSignature()
    }

    /**
     * Verify an Ed25519 signature.
     * Uses JDK on API 33+, BouncyCastle on API 28-32.
     */
    fun verify(publicKeyRaw: ByteArray, signature: ByteArray, data: ByteArray): Boolean {
        if (Build.VERSION.SDK_INT >= 33) {
            val x509Prefix = byteArrayOf(
                0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
            )
            val kf = KeyFactory.getInstance("Ed25519")
            val pubKey = kf.generatePublic(java.security.spec.X509EncodedKeySpec(x509Prefix + publicKeyRaw))
            val sig = Signature.getInstance("Ed25519")
            sig.initVerify(pubKey)
            sig.update(data)
            return sig.verify(signature)
        }
        // BouncyCastle fallback
        val pubParams = Ed25519PublicKeyParameters(publicKeyRaw, 0)
        val verifier = Ed25519Signer()
        verifier.init(false, pubParams)
        verifier.update(data, 0, data.size)
        return verifier.verifySignature(signature)
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
