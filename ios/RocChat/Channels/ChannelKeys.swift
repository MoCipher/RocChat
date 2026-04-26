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
}
