import CryptoKit
import Foundation

/// Handles SPK rotation and one-time prekey replenishment on iOS.
/// Runs on app launch / foreground — non-critical, best-effort.
class KeyRotationManager {
    static let shared = KeyRotationManager()
    private let api = APIClient.shared

    /// SPK rotation interval: 7 days
    private let spkRotationInterval: TimeInterval = 7 * 24 * 3600
    /// Minimum OTP keys before replenishment
    private let preKeyThreshold = 10
    /// Number of keys to upload when replenishing
    private let preKeyBatchSize = 20

    // MARK: - SPK Rotation

    func maybeRotateSignedPreKey() async {
        let lastRotation = UserDefaults.standard.double(forKey: "rocchat_spk_last_rotation")
        guard Date().timeIntervalSince1970 - lastRotation >= spkRotationInterval else { return }

        guard let identityPrivB64 = SecureStorage.shared.get(forKey: "identity_priv"),
              let identityPrivData = Data(base64Encoded: identityPrivB64) else { return }

        do {
            // Generate new X25519 keypair for SPK
            let spkPriv = Curve25519.KeyAgreement.PrivateKey()
            let spkPub = spkPriv.publicKey.rawRepresentation

            // Sign with Ed25519 identity key
            let signingKey = try Curve25519.Signing.PrivateKey(rawRepresentation: identityPrivData)
            let signature = try signingKey.signature(for: spkPub)
            let spkId = Int(Date().timeIntervalSince1970)

            let body: [String: Any] = [
                "id": spkId,
                "publicKey": spkPub.base64EncodedString(),
                "signature": signature.base64EncodedString(),
            ]
            _ = try await api.postRaw("/keys/signed", body: body, method: "PUT")

            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "rocchat_spk_last_rotation")
            SecureStorage.shared.set(spkPriv.rawRepresentation.base64EncodedString(), forKey: "spk_priv")
        } catch {
            // Non-critical — will retry next launch
        }
    }

    // MARK: - Prekey Replenishment

    func checkAndReplenishPreKeys() async {
        do {
            let data = try await api.getRaw("/keys/prekey-count")
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let count = json["count"] as? Int else { return }

            guard count < preKeyThreshold else { return }

            var keys: [[String: Any]] = []
            let baseId = Int(Date().timeIntervalSince1970)
            for i in 0..<preKeyBatchSize {
                let kp = Curve25519.KeyAgreement.PrivateKey()
                keys.append([
                    "id": baseId + i,
                    "publicKey": kp.publicKey.rawRepresentation.base64EncodedString(),
                ])
            }

            _ = try await api.postRaw("/keys/prekeys", body: ["keys": keys])
        } catch {
            // Non-critical
        }
    }

    /// Call on app launch / foreground
    func performMaintenance() async {
        await maybeRotateSignedPreKey()
        await checkAndReplenishPreKeys()
    }
}
