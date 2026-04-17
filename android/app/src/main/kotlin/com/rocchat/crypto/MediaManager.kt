package com.rocchat.crypto

import android.util.Base64
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import com.rocchat.network.APIClient

/**
 * Handles encrypted media upload/download for RocChat.
 * All media is AES-256-GCM encrypted client-side before upload.
 * The server only stores encrypted blobs.
 */
object MediaManager {

    data class EncryptedMedia(
        val blobId: String,
        val fileKey: ByteArray,   // 32-byte AES key
        val fileIv: ByteArray,    // 12-byte nonce
        val fileHash: ByteArray,  // SHA-256 of encrypted blob
        val filename: String,
        val mime: String,
        val size: Int
    )

    // MARK: - Upload

    suspend fun upload(data: ByteArray, filename: String, mime: String, conversationId: String): EncryptedMedia {
        // Generate random file key and IV
        val fileKey = ByteArray(32)
        val fileIv = ByteArray(12)
        SecureRandom().nextBytes(fileKey)
        SecureRandom().nextBytes(fileIv)

        // AES-256-GCM encrypt
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(fileKey, "AES"), GCMParameterSpec(128, fileIv))
        val encrypted = cipher.doFinal(data)

        // SHA-256 hash of encrypted blob
        val hash = MessageDigest.getInstance("SHA-256").digest(encrypted)

        // Upload encrypted blob
        val blobId = APIClient.uploadMedia(conversationId, encrypted, filename, mime)

        return EncryptedMedia(
            blobId = blobId,
            fileKey = fileKey,
            fileIv = fileIv,
            fileHash = hash,
            filename = filename,
            mime = mime,
            size = data.size
        )
    }

    // MARK: - Download

    suspend fun download(blobId: String, conversationId: String, fileKey: ByteArray, fileIv: ByteArray): ByteArray {
        val encrypted = APIClient.getRawBytes("/media/$blobId?cid=$conversationId")

        // AES-256-GCM decrypt
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(fileKey, "AES"), GCMParameterSpec(128, fileIv))
        return cipher.doFinal(encrypted)
    }

    // MARK: - Payload Helpers

    fun buildAttachmentPayload(media: EncryptedMedia, duration: Double? = null): JSONObject {
        return JSONObject().apply {
            put("blobId", media.blobId)
            put("fileKey", Base64.encodeToString(media.fileKey, Base64.NO_WRAP))
            put("fileIv", Base64.encodeToString(media.fileIv, Base64.NO_WRAP))
            put("fileHash", Base64.encodeToString(media.fileHash, Base64.NO_WRAP))
            put("filename", media.filename)
            put("mime", media.mime)
            put("size", media.size)
            if (duration != null) put("duration", duration)
        }
    }

    data class AttachmentMeta(
        val blobId: String,
        val fileKey: ByteArray,
        val fileIv: ByteArray,
        val filename: String,
        val mime: String
    )

    fun parseAttachment(json: JSONObject): AttachmentMeta? {
        return try {
            AttachmentMeta(
                blobId = json.getString("blobId"),
                fileKey = Base64.decode(json.getString("fileKey"), Base64.NO_WRAP),
                fileIv = Base64.decode(json.getString("fileIv"), Base64.NO_WRAP),
                filename = json.getString("filename"),
                mime = json.getString("mime")
            )
        } catch (_: Exception) { null }
    }
}
