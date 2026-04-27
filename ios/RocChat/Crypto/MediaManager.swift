import CryptoKit
import Foundation
import UniformTypeIdentifiers

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

    // MARK: - MIME Sniffing

    /// Detect MIME type from magic bytes; falls back to filename extension.
    static func sniffMime(data: Data, filename: String) -> String {
        let h = data.prefix(12)
        if h.starts(with: [0xFF, 0xD8, 0xFF])                            { return "image/jpeg" }
        if h.starts(with: [0x89, 0x50, 0x4E, 0x47])                     { return "image/png"  }
        if h.starts(with: [0x47, 0x49, 0x46])                            { return "image/gif"  }
        if h.starts(with: [0x52, 0x49, 0x46, 0x46]) && data.count >= 12 &&
           data[8...11].elementsEqual([0x57, 0x45, 0x42, 0x50])          { return "image/webp" }
        if h.count >= 8 && (
            data[4...7].elementsEqual([0x66, 0x74, 0x79, 0x70]) ||
            h.starts(with: [0x00, 0x00, 0x00, 0x18]) ||
            h.starts(with: [0x00, 0x00, 0x00, 0x20]))                    { return "video/mp4"  }
        if h.starts(with: [0x1A, 0x45, 0xDF, 0xA3])                     { return "video/webm" }
        if h.starts(with: [0xFF, 0xFB]) || h.starts(with: [0xFF, 0xF3]) ||
           h.starts(with: [0x49, 0x44, 0x33])                            { return "audio/mpeg" }
        if h.starts(with: [0x52, 0x49, 0x46, 0x46]) && data.count >= 12 &&
           data[8...11].elementsEqual([0x57, 0x41, 0x56, 0x45])          { return "audio/wav"  }
        if h.starts(with: [0x4F, 0x67, 0x67, 0x53])                     { return "audio/ogg"  }
        // Fall back to UTType extension lookup
        let ext = (filename as NSString).pathExtension.lowercased()
        if let uttype = UTType(filenameExtension: ext), let mime = uttype.preferredMIMEType {
            return mime
        }
        return "application/octet-stream"
    }

    // MARK: - Upload

    /// Encrypt and upload a file. Returns metadata to include in the message payload.
    func upload(data: Data, filename: String, mime: String, conversationId: String) async throws -> EncryptedMedia {
        // Sniff MIME from magic bytes to override generic/unknown types
        let detectedMime = (mime == "application/octet-stream" || mime.isEmpty)
            ? MediaManager.sniffMime(data: data, filename: filename)
            : mime
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
            "x-conversation-id": conversationId,
            "x-encrypted-filename": encryptProfileField(filename),
            "x-encrypted-mimetype": encryptProfileField(detectedMime),
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
            mime: detectedMime,
            size: data.count
        )
    }

    // MARK: - Download

    /// Download and decrypt a media blob, verifying SHA-256 hash after decryption.
    func download(blobId: String, conversationId: String, fileKey: Data, fileIv: Data, expectedHash: Data? = nil) async throws -> Data {
        let encrypted = try await api.getRaw("/media/\(blobId)?cid=\(conversationId)")

        guard encrypted.count > 16 else { throw MediaError.invalidBlob }

        let nonce = try AES.GCM.Nonce(data: fileIv)
        let ciphertext = encrypted[0..<(encrypted.count - 16)]
        let tag = encrypted[(encrypted.count - 16)...]
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)

        let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: fileKey))

        // Integrity check: reject if SHA-256 of plaintext doesn't match envelope
        if let expected = expectedHash {
            let computed = Data(SHA256.hash(data: plaintext))
            guard computed == expected else { throw MediaError.hashMismatch }
        }

        return plaintext
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
    static func parseAttachment(_ json: [String: Any]) -> (blobId: String, fileKey: Data, fileIv: Data, fileHash: Data?, filename: String, mime: String)? {
        guard let blobId = json["blobId"] as? String,
              let keyB64 = json["fileKey"] as? String, let key = Data(base64Encoded: keyB64),
              let ivB64 = json["fileIv"] as? String, let iv = Data(base64Encoded: ivB64),
              let filename = json["filename"] as? String,
              let mime = json["mime"] as? String else { return nil }
        let hash: Data? = (json["fileHash"] as? String).flatMap { Data(base64Encoded: $0) }
        return (blobId, key, iv, hash, filename, mime)
    }

    enum MediaError: Error {
        case uploadFailed, invalidBlob, decryptFailed, hashMismatch
    }
}
