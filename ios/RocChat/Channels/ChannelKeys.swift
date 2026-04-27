/**
 * Channel sender-key (E2E) decryption for iOS.
 *
 * Mirrors `web/src/crypto/channel-keys.ts`:
 *   - Fetch the per-recipient envelope from `/api/channels/:id/keys/me`
 *   - Unwrap with X25519(identity_dh_priv, ephemeral_pub) → HKDF → AES-GCM
 *   - Cache the channel symmetric key locally
 *   - Decrypt post bodies via HKDF(channelKey) → AES-GCM
 */

import Foundation
import CryptoKit

enum ChannelKeyError: Error {
    case missingIdentityDH
    case envelopeFetchFailed
    case unwrapFailed
}

/// In-memory cache of channel keys (channelId → symmetric 32-byte key).
/// Persisted across app launches via `SecureStorage`.
final class ChannelKeyStore {
    static let shared = ChannelKeyStore()
    private var memCache: [String: Data] = [:]
    private let queue = DispatchQueue(label: "com.rocchat.channelkeys", attributes: .concurrent)

    private init() {}

    func get(_ channelId: String) -> Data? {
        var hit: Data?
        queue.sync {
            if let cached = memCache[channelId] {
                hit = cached
                return
            }
            if let stored = SecureStorage.shared.getData(forKey: "rocchat_chankey_\(channelId)") {
                memCache[channelId] = stored
                hit = stored
            }
        }
        return hit
    }

    func set(_ channelId: String, key: Data) {
        queue.async(flags: .barrier) {
            self.memCache[channelId] = key
            SecureStorage.shared.setData(key, forKey: "rocchat_chankey_\(channelId)")
        }
    }
}

/// HKDF-SHA256 helper consistent with the web `hkdf` primitive.
private func channelHKDF(ikm: Data, salt: Data, info: Data, length: Int) -> Data {
    let key = HKDF<SHA256>.deriveKey(
        inputKeyMaterial: SymmetricKey(data: ikm),
        salt: salt,
        info: info,
        outputByteCount: length,
    )
    return key.withUnsafeBytes { Data($0) }
}

/// AES-256-GCM open for raw `(ciphertext, iv, tag)`.
private func aesGcmOpen(ciphertext: Data, key: Data, iv: Data, tag: Data) throws -> Data {
    let nonce = try AES.GCM.Nonce(data: iv)
    let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
    return try AES.GCM.open(box, using: SymmetricKey(data: key))
}

/// AES-256-GCM seal returning `(iv, ciphertext, tag)` separately so the
/// envelope/post wire format matches the web's `aesGcmEncrypt` helper.
private func aesGcmSeal(plaintext: Data, key: Data) throws -> (iv: Data, ciphertext: Data, tag: Data) {
    let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key))
    return (Data(sealed.nonce), sealed.ciphertext, sealed.tag)
}

/// X25519 ECDH using CryptoKit. Returns the raw 32-byte shared secret.
private func channelDH(privateKey: Data, publicKey: Data) throws -> Data {
    let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
    let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
    let shared = try priv.sharedSecretFromKeyAgreement(with: pub)
    return shared.withUnsafeBytes { Data($0) }
}

enum ChannelCrypto {

    /// Returns the channel symmetric key, fetching + unwrapping from the server
    /// envelope on first use. Returns nil if no envelope exists yet (admin
    /// hasn't distributed a key to this device's identity).
    static func getChannelKey(channelId: String) async throws -> Data? {
        if let cached = ChannelKeyStore.shared.get(channelId) {
            return cached
        }

        guard let identityDHPriv = SecureStorage.shared.getData(forKey: "rocchat_identity_dh_priv")
            ?? UserDefaults.standard.data(forKey: "rocchat_identity_dh_priv") else {
            throw ChannelKeyError.missingIdentityDH
        }

        // Fetch own envelope
        guard let token = SecureStorage.shared.get(forKey: "session_token")
            ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let url = URL(string: "\(APIConfig.baseURL)/api/channels/\(channelId)/keys/me") else {
            throw ChannelKeyError.envelopeFetchFailed
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await APIClient.shared.session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { return nil }
        if http.statusCode == 404 { return nil }
        if http.statusCode != 200 { throw ChannelKeyError.envelopeFetchFailed }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let env = json["envelope"] as? [String: Any],
              let ephB64 = env["ephemeral_pub"] as? String,
              let ctB64 = env["ciphertext"] as? String,
              let ivB64 = env["iv"] as? String,
              let tagB64 = env["tag"] as? String,
              let ephPub = Data(base64Encoded: ephB64),
              let ct = Data(base64Encoded: ctB64),
              let iv = Data(base64Encoded: ivB64),
              let tag = Data(base64Encoded: tagB64) else {
            return nil
        }

        // ECDH → HKDF → AES-GCM unwrap
        do {
            let ss = try channelDH(privateKey: identityDHPriv, publicKey: ephPub)
            let salt = channelId.data(using: .utf8) ?? Data()
            let info = "rocchat-channel-key-wrap-v1".data(using: .utf8) ?? Data()
            let wrapKey = channelHKDF(ikm: ss, salt: salt, info: info, length: 32)
            let channelKey = try aesGcmOpen(ciphertext: ct, key: wrapKey, iv: iv, tag: tag)
            ChannelKeyStore.shared.set(channelId, key: channelKey)
            return channelKey
        } catch {
            throw ChannelKeyError.unwrapFailed
        }
    }

    /// Decrypt a channel post body. Returns nil on any failure (caller can
    /// then show a placeholder).
    static func decryptPost(
        channelId: String,
        ciphertextB64: String,
        ivB64: String,
        ratchetHeader: String,
    ) async -> String? {
        // Parse ratchet_header: { cv:1, v:keyVersion, tag:base64Tag }
        guard let headerData = ratchetHeader.data(using: .utf8),
              let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              let cv = header["cv"] as? Int, cv == 1,
              let tagB64 = header["tag"] as? String,
              let ct = Data(base64Encoded: ciphertextB64),
              let iv = Data(base64Encoded: ivB64),
              let tag = Data(base64Encoded: tagB64) else {
            return nil
        }

        guard let channelKey = try? await getChannelKey(channelId: channelId) else { return nil }

        let salt = channelId.data(using: .utf8) ?? Data()
        let info = "rocchat-channel-post-v1".data(using: .utf8) ?? Data()
        let postKey = channelHKDF(ikm: channelKey, salt: salt, info: info, length: 32)

        guard let plaintext = try? aesGcmOpen(ciphertext: ct, key: postKey, iv: iv, tag: tag) else {
            return nil
        }
        return String(data: plaintext, encoding: .utf8)
    }

    /// Encrypted post wire format — mirrors web's `EncryptedPost`.
    struct EncryptedPost {
        let ciphertext: String   // base64
        let iv: String           // base64
        let tag: String          // base64
        let keyVersion: Int

        /// Build the JSON `ratchet_header` consumed by web/Android decoders.
        var ratchetHeaderJSON: String {
            let header: [String: Any] = ["cv": 1, "v": keyVersion, "tag": tag]
            guard let data = try? JSONSerialization.data(withJSONObject: header, options: [.sortedKeys]),
                  let str = String(data: data, encoding: .utf8) else {
                return "{\"cv\":1,\"v\":\(keyVersion),\"tag\":\"\(tag)\"}"
            }
            return str
        }
    }

    enum EncryptError: Error {
        case missingChannelKey
        case sealFailed
    }

    /// Encrypt a plaintext post body with the channel symmetric key.
    /// Wire format matches `web/src/crypto/channel-keys.ts#encryptPost`:
    ///   postKey = HKDF(channelKey, salt=channelId, info="rocchat-channel-post-v1")
    ///   (iv, ct, tag) = AES-GCM(postKey, plaintext)
    ///   ratchet_header = { cv: 1, v: keyVersion, tag: <b64 tag> }
    static func encryptPost(channelId: String, plaintext: String) async throws -> EncryptedPost {
        guard let channelKey = try await getChannelKey(channelId: channelId) else {
            throw EncryptError.missingChannelKey
        }
        let salt = channelId.data(using: .utf8) ?? Data()
        let info = "rocchat-channel-post-v1".data(using: .utf8) ?? Data()
        let postKey = channelHKDF(ikm: channelKey, salt: salt, info: info, length: 32)
        let pt = plaintext.data(using: .utf8) ?? Data()
        let sealed: (iv: Data, ciphertext: Data, tag: Data)
        do { sealed = try aesGcmSeal(plaintext: pt, key: postKey) }
        catch { throw EncryptError.sealFailed }
        return EncryptedPost(
            ciphertext: sealed.ciphertext.base64EncodedString(),
            iv: sealed.iv.base64EncodedString(),
            tag: sealed.tag.base64EncodedString(),
            keyVersion: 1,
        )
    }

    /// Per-recipient ECIES wrap of the channel symmetric key. Matches the
    /// envelope shape stored at `channel_key_envelopes` and the unwrap path
    /// used by `getChannelKey`.
    struct WrappedEnvelope {
        let recipientId: String
        let ephemeralPub: String
        let ciphertext: String
        let iv: String
        let tag: String
        let keyVersion: Int

        var asDict: [String: Any] {
            [
                "recipient_id": recipientId,
                "ephemeral_pub": ephemeralPub,
                "ciphertext": ciphertext,
                "iv": iv,
                "tag": tag,
                "key_version": keyVersion,
            ]
        }
    }

    /// Wrap a 32-byte channel key for a single recipient using ECIES on
    /// X25519 + HKDF + AES-GCM. The envelope can be uploaded as-is via
    /// POST `/api/channels/:id/keys`.
    static func wrapForRecipient(
        channelKey: Data,
        recipientId: String,
        recipientIdentityDHPub: Data,
        channelId: String,
        keyVersion: Int = 1,
    ) throws -> WrappedEnvelope {
        // Generate a fresh ephemeral X25519 key pair for this wrap.
        let ephPriv = Curve25519.KeyAgreement.PrivateKey()
        let ephPubData = ephPriv.publicKey.rawRepresentation
        // ECDH(ephemeral_priv, recipient_identity_dh_pub) → shared secret
        let recipientPub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: recipientIdentityDHPub)
        let ss = try ephPriv.sharedSecretFromKeyAgreement(with: recipientPub)
        let ssData = ss.withUnsafeBytes { Data($0) }
        // HKDF → AES-GCM seal of channelKey
        let salt = channelId.data(using: .utf8) ?? Data()
        let info = "rocchat-channel-key-wrap-v1".data(using: .utf8) ?? Data()
        let wrapKey = channelHKDF(ikm: ssData, salt: salt, info: info, length: 32)
        let sealed = try aesGcmSeal(plaintext: channelKey, key: wrapKey)
        return WrappedEnvelope(
            recipientId: recipientId,
            ephemeralPub: ephPubData.base64EncodedString(),
            ciphertext: sealed.ciphertext.base64EncodedString(),
            iv: sealed.iv.base64EncodedString(),
            tag: sealed.tag.base64EncodedString(),
            keyVersion: keyVersion,
        )
    }

    /// Distribute the cached channel key to every pending subscriber listed
    /// by `GET /api/channels/:id/keys/pending`. Idempotent — safe to call
    /// before each post; only members without an envelope receive one.
    /// Returns the number of envelopes uploaded.
    @discardableResult
    static func distributeChannelKeyToPending(channelId: String) async throws -> Int {
        guard let channelKey = try await getChannelKey(channelId: channelId) else {
            throw EncryptError.missingChannelKey
        }
        guard let token = SecureStorage.shared.get(forKey: "session_token")
            ?? UserDefaults.standard.string(forKey: "sessionToken"),
              let pendingURL = URL(string: "\(APIConfig.baseURL)/api/channels/\(channelId)/keys/pending") else {
            return 0
        }
        var req = URLRequest(url: pendingURL)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await APIClient.shared.session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return 0 }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let recipients = json["recipients"] as? [[String: Any]] else { return 0 }
        let keyVersion = (json["key_version"] as? Int) ?? 1

        var envelopes: [[String: Any]] = []
        for r in recipients {
            guard let userId = r["user_id"] as? String,
                  let dhB64 = r["identity_dh_key"] as? String,
                  let dhPub = Data(base64Encoded: dhB64) else { continue }
            do {
                let env = try wrapForRecipient(
                    channelKey: channelKey,
                    recipientId: userId,
                    recipientIdentityDHPub: dhPub,
                    channelId: channelId,
                    keyVersion: keyVersion,
                )
                envelopes.append(env.asDict)
            } catch {
                // Skip individual recipients on failure rather than failing the whole batch.
                continue
            }
        }
        if envelopes.isEmpty { return 0 }

        guard let uploadURL = URL(string: "\(APIConfig.baseURL)/api/channels/\(channelId)/keys") else { return 0 }
        var post = URLRequest(url: uploadURL)
        post.httpMethod = "POST"
        post.setValue("application/json", forHTTPHeaderField: "Content-Type")
        post.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        post.httpBody = try JSONSerialization.data(withJSONObject: ["envelopes": envelopes])
        let (_, postResp) = try await APIClient.shared.session.data(for: post)
        guard let postHttp = postResp as? HTTPURLResponse, postHttp.statusCode == 200 else { return 0 }
        return envelopes.count
    }
}
