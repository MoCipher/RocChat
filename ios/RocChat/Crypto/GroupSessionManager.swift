import CryptoKit
import Foundation

// MARK: - Sender Key Models

struct SenderKeyState: Codable {
    var chainKey: Data       // 32-byte chain key for symmetric ratchet
    var iteration: Int       // Current chain step
    let senderIdHash: Data   // Identifies the sender
}

struct GroupCiphertext {
    let senderId: String
    let iteration: Int
    let ciphertext: Data     // AES-256-GCM encrypted
    let iv: Data
    let tag: Data
}

struct SenderKeyDistribution: Codable {
    let senderId: String
    let groupId: String
    let chainKey: String     // base64
    let iteration: Int
}

// MARK: - Group Session Manager (Sender Keys)

class GroupSessionManager {
    static let shared = GroupSessionManager()

    private let storagePrefix = "rocchat_group_keys_"
    private var ownKeys: [String: SenderKeyState] = [:]      // groupId → own sender key
    private var peerKeys: [String: SenderKeyState] = [:]      // groupId:senderId → peer sender key
    private var distributedTo: [String: Set<String>] = [:]    // groupId → set of userIds

    // MARK: - Key Generation

    func generateSenderKey() -> SenderKeyState {
        var random = Data(count: 32)
        random.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        let senderIdHash = SHA256.hash(data: random).withUnsafeBytes { Data($0) }
        return SenderKeyState(chainKey: random, iteration: 0, senderIdHash: senderIdHash)
    }

    // MARK: - Own Key Management

    func getOrCreateOwnKey(groupId: String) -> SenderKeyState {
        if let cached = ownKeys[groupId] { return cached }
        if let stored = loadKey(key: storagePrefix + "own_" + groupId) {
            ownKeys[groupId] = stored
            return stored
        }
        let key = generateSenderKey()
        ownKeys[groupId] = key
        saveKey(key, forKey: storagePrefix + "own_" + groupId)
        return key
    }

    // MARK: - Peer Key Management

    func getPeerKey(groupId: String, senderId: String) -> SenderKeyState? {
        let id = "\(groupId):\(senderId)"
        if let cached = peerKeys[id] { return cached }
        if let stored = loadKey(key: storagePrefix + "peer_" + id) {
            peerKeys[id] = stored
            return stored
        }
        return nil
    }

    func savePeerKey(groupId: String, senderId: String, key: SenderKeyState) {
        let id = "\(groupId):\(senderId)"
        peerKeys[id] = key
        saveKey(key, forKey: storagePrefix + "peer_" + id)
    }

    // MARK: - Distribution

    func createDistribution(senderId: String, groupId: String) -> SenderKeyDistribution {
        let key = getOrCreateOwnKey(groupId: groupId)
        return SenderKeyDistribution(
            senderId: senderId,
            groupId: groupId,
            chainKey: key.chainKey.base64EncodedString(),
            iteration: key.iteration
        )
    }

    func importDistribution(_ dist: SenderKeyDistribution) {
        guard let chainKey = Data(base64Encoded: dist.chainKey) else { return }
        let senderIdHash = SHA256.hash(data: chainKey).withUnsafeBytes { Data($0) }
        let key = SenderKeyState(chainKey: chainKey, iteration: dist.iteration, senderIdHash: senderIdHash)
        savePeerKey(groupId: dist.groupId, senderId: dist.senderId, key: key)
    }

    /// Distribute our sender key to all group members via pairwise channels.
    func ensureDistributed(
        groupId: String,
        members: [(userId: String, String)],
        myUserId: String
    ) async throws -> SenderKeyState {
        let senderKey = getOrCreateOwnKey(groupId: groupId)
        var distributed = distributedTo[groupId] ?? Set<String>()
        let otherMembers = members.filter { $0.userId != myUserId }
        let needsDistribution = otherMembers.filter { !distributed.contains($0.userId) }

        for member in needsDistribution {
            do {
                let dist = createDistribution(senderId: myUserId, groupId: groupId)
                let distJson = try JSONEncoder().encode(dist)
                let distStr = String(data: distJson, encoding: .utf8)!

                // Encrypt via pairwise Double Ratchet
                let envelope = try await SessionManager.shared.encryptMessage(
                    conversationId: groupId + ":" + member.userId,
                    recipientUserId: member.userId,
                    plaintext: distStr
                )

                // Send as sender_key_distribution message
                _ = try await APIClient.shared.postRaw("/messages/send", body: [
                    "conversation_id": groupId,
                    "ciphertext": envelope.ciphertext,
                    "iv": envelope.iv,
                    "ratchet_header": envelope.ratchetHeader,
                    "message_type": "sender_key_distribution",
                ])

                distributed.insert(member.userId)
            } catch {
                // Best effort — will retry on next send
            }
        }
        distributedTo[groupId] = distributed
        return senderKey
    }

    // MARK: - Encrypt

    private func advanceChain(_ key: inout SenderKeyState) -> Data {
        let info = "RocChat_SenderKey_v1".data(using: .utf8)!
        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: key.chainKey),
            salt: Data(count: 32),
            info: info,
            outputByteCount: 64
        )
        let bytes = derived.withUnsafeBytes { Data($0) }
        key.chainKey = bytes[0..<32]
        key.iteration += 1
        return bytes[32..<64] // message key
    }

    func encrypt(groupId: String, plaintext: Data, myUserId: String) throws -> (ciphertext: String, ratchetHeader: String) {
        var key = getOrCreateOwnKey(groupId: groupId)
        let messageKey = advanceChain(&key)

        // AES-256-GCM encrypt
        let nonce = AES.GCM.Nonce()
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: messageKey), nonce: nonce)

        // Save updated key
        ownKeys[groupId] = key
        saveKey(key, forKey: storagePrefix + "own_" + groupId)

        // Wire format
        let ct = sealed.ciphertext + sealed.tag
        let header: [String: Any] = [
            "senderId": myUserId,
            "iteration": key.iteration,
            "groupEncrypted": true,
            "iv": Data(nonce).base64EncodedString(),
        ]
        let headerJSON = try JSONSerialization.data(withJSONObject: header)

        return (
            ciphertext: ct.base64EncodedString(),
            ratchetHeader: String(data: headerJSON, encoding: .utf8)!
        )
    }

    // MARK: - Decrypt

    func decrypt(groupId: String, senderId: String, ciphertextB64: String, ratchetHeader: String) throws -> Data {
        guard let headerData = ratchetHeader.data(using: .utf8),
              let header = try JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              let iteration = header["iteration"] as? Int,
              let ivB64 = header["iv"] as? String,
              let ivData = Data(base64Encoded: ivB64),
              let ctData = Data(base64Encoded: ciphertextB64) else {
            throw GroupSessionError.invalidHeader
        }

        guard var peerKey = getPeerKey(groupId: groupId, senderId: senderId) else {
            throw GroupSessionError.noSenderKey
        }

        // Advance chain to match iteration
        while peerKey.iteration < iteration {
            _ = advanceChain(&peerKey)
        }

        let messageKey = advanceChain(&peerKey)
        savePeerKey(groupId: groupId, senderId: senderId, key: peerKey)

        // Split ciphertext + tag (last 16 bytes)
        guard ctData.count > 16 else { throw GroupSessionError.invalidCiphertext }
        let ciphertext = ctData[0..<(ctData.count - 16)]
        let tag = ctData[(ctData.count - 16)...]

        let nonce = try AES.GCM.Nonce(data: ivData)
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        return try AES.GCM.open(box, using: SymmetricKey(data: messageKey))
    }

    // MARK: - Handle incoming distribution

    func handleSenderKeyDistribution(
        groupId: String,
        senderId: String,
        ciphertext: String,
        iv: String,
        ratchetHeader: String
    ) throws {
        // Decrypt via pairwise Double Ratchet
        let decrypted = try SessionManager.shared.decryptMessage(
            conversationId: groupId + ":" + senderId,
            ciphertext: ciphertext,
            iv: iv,
            ratchetHeaderStr: ratchetHeader
        )
        guard let data = decrypted.data(using: .utf8),
              let dist = try? JSONDecoder().decode(SenderKeyDistribution.self, from: data) else { return }
        importDistribution(dist)
    }

    // MARK: - Key Rotation

    func rotateSenderKey(groupId: String) {
        let newKey = generateSenderKey()
        ownKeys[groupId] = newKey
        saveKey(newKey, forKey: storagePrefix + "own_" + groupId)
        distributedTo.removeValue(forKey: groupId)
    }

    // MARK: - Helpers

    static func isGroupEncrypted(ratchetHeader: String) -> Bool {
        guard let data = ratchetHeader.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return json["groupEncrypted"] as? Bool == true
    }

    // MARK: - Persistence

    private func saveKey(_ key: SenderKeyState, forKey storageKey: String) {
        if let data = try? JSONEncoder().encode(key) {
            SecureStorage.shared.setData(data, forKey: storageKey)
        }
    }

    private func loadKey(key storageKey: String) -> SenderKeyState? {
        guard let data = SecureStorage.shared.getData(forKey: storageKey) else { return nil }
        return try? JSONDecoder().decode(SenderKeyState.self, from: data)
    }
}

enum GroupSessionError: Error {
    case noSenderKey, invalidHeader, invalidCiphertext
}
