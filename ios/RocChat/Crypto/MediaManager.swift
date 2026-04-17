import CryptoKit
import Foundation

/// Handles encrypted media upload/download for RocChat.
/// All media is encrypted client-side with AES-256-GCM before upload.
/// The server only stores encrypted blobs — it never sees plaintext.
class MediaManager {
    static let shared = MediaManager()
    private let api = APIClient.shared

    struct EncryptedMedia {
        let blobId: String
        let fileKey: Data     // 32-byte AES key (share with recipient in message)
        let fileIv: Data      // 12-byte nonce
        let fileHash: Data    // SHA-256 of encrypted blob
        let filename: String
        let mime: String
        let size: Int
    }

    // MARK: - Upload

    /// Encrypt and upload a file. Returns metadata to include in the message payload.
    func upload(data: Data, filename: String, mime: String) async throws -> EncryptedMedia {
        // Generate random file key
        let fileKey = SymmetricKey(size: .bits256)
        let nonce = AES.GCM.Nonce()

        // Encrypt
        let sealed = try AES.GCM.seal(data, using: fileKey, nonce: nonce)
        let encrypted = sealed.ciphertext + sealed.tag

        // Hash the encrypted blob
        let hash = SHA256.hash(data: encrypted)

        // Upload encrypted blob
        let respData = try await api.uploadBinary("/media/upload", data: encrypted, headers: [
            "Content-Type": "application/octet-stream",
            "Content-Length": "\(encrypted.count)",
        ])

        guard let json = try JSONSerialization.jsonObject(with: respData) as? [String: Any],
              let blobId = json["id"] as? String else {
            throw MediaError.uploadFailed
        }

        return EncryptedMedia(
            blobId: blobId,
            fileKey: fileKey.withUnsafeBytes { Data($0) },
            fileIv: Data(nonce),
            fileHash: Data(hash),
            filename: filename,
            mime: mime,
            size: data.count
        )
    }

    // MARK: - Download

    /// Download and decrypt a media blob.
    func download(blobId: String, conversationId: String, fileKey: Data, fileIv: Data) async throws -> Data {
        let encrypted = try await api.getRaw("/media/\(blobId)?cid=\(conversationId)")

        guard encrypted.count > 16 else { throw MediaError.invalidBlob }

        let nonce = try AES.GCM.Nonce(data: fileIv)
        let ciphertext = encrypted[0..<(encrypted.count - 16)]
        let tag = encrypted[(encrypted.count - 16)...]
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)

        return try AES.GCM.open(box, using: SymmetricKey(data: fileKey))
    }

    // MARK: - Message Payload Helpers

    /// Build the JSON payload for a media message (to include in the encrypted message body).
    static func buildAttachmentPayload(_ media: EncryptedMedia, duration: Double? = nil) -> [String: Any] {
        var payload: [String: Any] = [
            "blobId": media.blobId,
            "fileKey": media.fileKey.base64EncodedString(),
            "fileIv": media.fileIv.base64EncodedString(),
            "fileHash": media.fileHash.base64EncodedString(),
            "filename": media.filename,
            "mime": media.mime,
            "size": media.size,
        ]
        if let dur = duration {
            payload["duration"] = dur
        }
        return payload
    }

    /// Parse attachment metadata from a decrypted message JSON.
    static func parseAttachment(_ json: [String: Any]) -> (blobId: String, fileKey: Data, fileIv: Data, filename: String, mime: String)? {
        guard let blobId = json["blobId"] as? String,
              let keyB64 = json["fileKey"] as? String, let key = Data(base64Encoded: keyB64),
              let ivB64 = json["fileIv"] as? String, let iv = Data(base64Encoded: ivB64),
              let filename = json["filename"] as? String,
              let mime = json["mime"] as? String else { return nil }
        return (blobId, key, iv, filename, mime)
    }

    enum MediaError: Error {
        case uploadFailed, invalidBlob, decryptFailed
    }
}
