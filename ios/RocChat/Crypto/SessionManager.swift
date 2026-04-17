import CryptoKit
import Foundation

// MARK: - Models

struct X3DHHeader: Codable {
    let identityDHKey: String
    let ephemeralKey: String
    let oneTimePreKeyId: Int?
}

struct RatchetHeader: Codable {
    let dhPublicKey: String
    let pn: Int
    let n: Int
    var tag: String?
    var x3dh: X3DHHeader?
}

struct EncryptedEnvelope {
    let ciphertext: String
    let iv: String
    let ratchetHeader: String
}

struct RatchetState: Codable {
    var dhSendingPublic: Data?
    var dhSendingPrivate: Data?
    var dhReceivingKey: Data?
    var rootKey: Data
    var sendingChainKey: Data?
    var receivingChainKey: Data?
    var sendingMessageNumber: Int
    var receivingMessageNumber: Int
    var previousSendingChainLength: Int
    var skippedKeys: [SkippedKey]
}

struct SkippedKey: Codable {
    let dhPublicKey: String
    let messageNumber: Int
    let messageKey: Data
}

// MARK: - Crypto Primitives

private func generateX25519() -> (publicKey: Data, privateKey: Data) {
    let priv = Curve25519.KeyAgreement.PrivateKey()
    return (priv.publicKey.rawRepresentation, priv.rawRepresentation)
}

private func x25519DH(_ privateKey: Data, _ publicKey: Data) throws -> Data {
    let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
    let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
    let shared = try priv.sharedSecretFromKeyAgreement(with: pub)
    return shared.withUnsafeBytes { Data($0) }
}

private func hkdfSHA256(ikm: Data, salt: Data, info: Data, length: Int) -> Data {
    let derived = HKDF<SHA256>.deriveKey(
        inputKeyMaterial: SymmetricKey(data: ikm),
        salt: salt,
        info: info,
        outputByteCount: length
    )
    return derived.withUnsafeBytes { Data($0) }
}

private func hmacSHA256(key: Data, data: Data) -> Data {
    let auth = HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key))
    return Data(auth)
}

private func aesGcmEncrypt(key: Data, plaintext: Data, aad: Data) throws -> (ciphertext: Data, iv: Data, tag: Data) {
    let nonce = AES.GCM.Nonce()
    let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: nonce, authenticating: aad)
    return (box.ciphertext, Data(nonce), box.tag)
}

private func aesGcmDecrypt(key: Data, ciphertext: Data, iv: Data, tag: Data, aad: Data) throws -> Data {
    let nonce = try AES.GCM.Nonce(data: iv)
    let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
    return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
}

// MARK: - Constants (must match shared/double-ratchet.ts)

private let chainKeySeed = "RocChat_ChainKey".data(using: .utf8)!
private let messageKeySeed = "RocChat_MessageKey".data(using: .utf8)!
private let ratchetInfo = "RocChat_Ratchet_v1".data(using: .utf8)!
private let x3dhInfoBytes = "RocChat_X3DH_v1".data(using: .utf8)!
private let x3dhSalt = Data(count: 32)
private let maxSkip = 256

// MARK: - KDF Chains

private func kdfRootKey(_ rootKey: Data, _ dhOutput: Data) -> (newRootKey: Data, chainKey: Data) {
    let derived = hkdfSHA256(ikm: dhOutput, salt: rootKey, info: ratchetInfo, length: 64)
    return (derived[0..<32], derived[32..<64])
}

private func kdfChainKey(_ chainKey: Data) -> (newChainKey: Data, messageKey: Data) {
    let newCK = hmacSHA256(key: chainKey, data: chainKeySeed)
    let mk = hmacSHA256(key: chainKey, data: messageKeySeed)
    return (newCK, mk)
}

// MARK: - Double Ratchet Init

private func initSender(sharedSecret: Data, theirSignedPreKey: Data) throws -> RatchetState {
    let dhKP = generateX25519()
    let dhOut = try x25519DH(dhKP.privateKey, theirSignedPreKey)
    let (rk, ck) = kdfRootKey(sharedSecret, dhOut)
    return RatchetState(
        dhSendingPublic: dhKP.publicKey, dhSendingPrivate: dhKP.privateKey,
        dhReceivingKey: theirSignedPreKey, rootKey: rk,
        sendingChainKey: ck, receivingChainKey: nil,
        sendingMessageNumber: 0, receivingMessageNumber: 0,
        previousSendingChainLength: 0, skippedKeys: []
    )
}

private func initReceiver(sharedSecret: Data, ourSPKPublic: Data, ourSPKPrivate: Data) -> RatchetState {
    RatchetState(
        dhSendingPublic: ourSPKPublic, dhSendingPrivate: ourSPKPrivate,
        dhReceivingKey: nil, rootKey: sharedSecret,
        sendingChainKey: nil, receivingChainKey: nil,
        sendingMessageNumber: 0, receivingMessageNumber: 0,
        previousSendingChainLength: 0, skippedKeys: []
    )
}

// MARK: - Double Ratchet Encrypt / Decrypt

private func ratchetEncrypt(_ state: inout RatchetState, _ plaintext: Data) throws -> (ciphertext: Data, iv: Data, tag: Data, header: RatchetHeader) {
    guard let ck = state.sendingChainKey, let dhPub = state.dhSendingPublic else {
        throw SessionError.notInitialized
    }
    let (newCK, mk) = kdfChainKey(ck)
    state.sendingChainKey = newCK

    let header = RatchetHeader(
        dhPublicKey: dhPub.base64EncodedString(),
        pn: state.previousSendingChainLength,
        n: state.sendingMessageNumber
    )

    let aad = dhPub + "\(header.pn):\(header.n)".data(using: .utf8)!
    let (ct, iv, tag) = try aesGcmEncrypt(key: mk, plaintext: plaintext, aad: aad)
    state.sendingMessageNumber += 1
    return (ct, iv, tag, header)
}

private func ratchetDecrypt(_ state: inout RatchetState, ciphertext: Data, iv: Data, tag: Data, header: RatchetHeader) throws -> Data {
    guard let dhPubData = Data(base64Encoded: header.dhPublicKey) else {
        throw SessionError.invalidHeader
    }

    // Check skipped keys
    if let idx = state.skippedKeys.firstIndex(where: { $0.dhPublicKey == header.dhPublicKey && $0.messageNumber == header.n }) {
        let mk = state.skippedKeys[idx].messageKey
        state.skippedKeys.remove(at: idx)
        let aad = dhPubData + "\(header.pn):\(header.n)".data(using: .utf8)!
        return try aesGcmDecrypt(key: mk, ciphertext: ciphertext, iv: iv, tag: tag, aad: aad)
    }

    // DH ratchet step if new key
    let currentDHB64 = state.dhReceivingKey?.base64EncodedString()
    if header.dhPublicKey != currentDHB64 {
        if state.receivingChainKey != nil {
            try skipMessages(&state, until: header.pn)
        }
        state.dhReceivingKey = dhPubData
        if let dhPriv = state.dhSendingPrivate, let dhRecv = state.dhReceivingKey {
            let dhOut = try x25519DH(dhPriv, dhRecv)
            let (rk, ck) = kdfRootKey(state.rootKey, dhOut)
            state.rootKey = rk
            state.receivingChainKey = ck
            state.receivingMessageNumber = 0
        }
        state.previousSendingChainLength = state.sendingMessageNumber
        state.sendingMessageNumber = 0
        let newKP = generateX25519()
        state.dhSendingPublic = newKP.publicKey
        state.dhSendingPrivate = newKP.privateKey
        let dhOut2 = try x25519DH(newKP.privateKey, state.dhReceivingKey!)
        let (rk2, ck2) = kdfRootKey(state.rootKey, dhOut2)
        state.rootKey = rk2
        state.sendingChainKey = ck2
    }

    try skipMessages(&state, until: header.n)

    guard let rck = state.receivingChainKey else { throw SessionError.noReceivingChain }
    let (newCK, mk) = kdfChainKey(rck)
    state.receivingChainKey = newCK
    state.receivingMessageNumber += 1

    let aad = dhPubData + "\(header.pn):\(header.n)".data(using: .utf8)!
    return try aesGcmDecrypt(key: mk, ciphertext: ciphertext, iv: iv, tag: tag, aad: aad)
}

private func skipMessages(_ state: inout RatchetState, until: Int) throws {
    guard let rck = state.receivingChainKey else { return }
    guard until - state.receivingMessageNumber <= maxSkip else {
        throw SessionError.tooManySkipped
    }
    var ck = rck
    while state.receivingMessageNumber < until {
        let (newCK, mk) = kdfChainKey(ck)
        ck = newCK
        state.skippedKeys.append(SkippedKey(
            dhPublicKey: state.dhReceivingKey?.base64EncodedString() ?? "",
            messageNumber: state.receivingMessageNumber,
            messageKey: mk
        ))
        state.receivingMessageNumber += 1
    }
    state.receivingChainKey = ck
}

// MARK: - Session Manager

enum SessionError: Error {
    case notInitialized, invalidHeader, noReceivingChain, tooManySkipped
    case noKeyMaterial, bundleFetchFailed, noSession
}

class SessionManager {
    static let shared = SessionManager()

    private var cache: [String: RatchetState] = [:]
    private var pendingX3DH: [String: X3DHHeader] = [:]

    // Key material set after login/register
    var identityDHPublic: Data?
    var identityDHPrivate: Data?
    var signedPreKeyPublic: Data?
    var signedPreKeyPrivate: Data?
    var oneTimePreKeys: [(id: Int, privateKey: Data, publicKey: Data)] = []

    private let stateKey = "rocchat_ratchet_states"

    // MARK: - Key Material

    func generateAndCacheIdentityDH() {
        if identityDHPublic != nil { return }
        let storage = SecureStorage.shared
        let saved = storage.getData(forKey: "rocchat_identity_dh_pub")
        let savedPriv = storage.getData(forKey: "rocchat_identity_dh_priv")
        if let pub = saved, let priv = savedPriv {
            identityDHPublic = pub
            identityDHPrivate = priv
            return
        }
        let kp = generateX25519()
        identityDHPublic = kp.publicKey
        identityDHPrivate = kp.privateKey
        storage.setData(kp.publicKey, forKey: "rocchat_identity_dh_pub")
        storage.setData(kp.privateKey, forKey: "rocchat_identity_dh_priv")
    }

    func cacheKeyMaterial(signedPreKeyPub: Data, signedPreKeyPriv: Data, otpKeys: [(id: Int, privateKey: Data, publicKey: Data)]) {
        self.signedPreKeyPublic = signedPreKeyPub
        self.signedPreKeyPrivate = signedPreKeyPriv
        self.oneTimePreKeys = otpKeys
        SecureStorage.shared.setData(signedPreKeyPub, forKey: "rocchat_spk_pub")
        SecureStorage.shared.setData(signedPreKeyPriv, forKey: "rocchat_spk_priv")
    }

    func loadCachedKeyMaterial() {
        generateAndCacheIdentityDH()
        if let spkPub = SecureStorage.shared.getData(forKey: "rocchat_spk_pub"),
           let spkPriv = SecureStorage.shared.getData(forKey: "rocchat_spk_priv") {
            signedPreKeyPublic = spkPub
            signedPreKeyPrivate = spkPriv
        }
    }

    // MARK: - State Persistence

    private func saveState(_ conversationId: String, _ state: RatchetState) {
        var all = loadAllStates()
        all[conversationId] = state
        if let data = try? JSONEncoder().encode(all) {
            SecureStorage.shared.setData(data, forKey: stateKey)
        }
    }

    private func loadState(_ conversationId: String) -> RatchetState? {
        loadAllStates()[conversationId]
    }

    private func loadAllStates() -> [String: RatchetState] {
        guard let data = SecureStorage.shared.getData(forKey: stateKey),
              let states = try? JSONDecoder().decode([String: RatchetState].self, from: data) else {
            return [:]
        }
        return states
    }

    // MARK: - X3DH

    private func performX3DH(conversationId: String, recipientUserId: String) async throws -> RatchetState {
        guard let idDHPriv = identityDHPrivate, let idDHPub = identityDHPublic else {
            throw SessionError.noKeyMaterial
        }

        // Fetch pre-key bundle
        let data = try await APIClient.shared.getRaw("/keys/bundle/\(recipientUserId)")
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SessionError.bundleFetchFailed
        }

        let identityDHKeyB64 = json["identityDHKey"] as? String ?? json["identityKey"] as? String ?? ""
        guard let theirIdentityDH = Data(base64Encoded: identityDHKeyB64) else {
            throw SessionError.bundleFetchFailed
        }

        guard let spk = json["signedPreKey"] as? [String: Any],
              let spkPubB64 = spk["publicKey"] as? String,
              let spkPub = Data(base64Encoded: spkPubB64) else {
            throw SessionError.bundleFetchFailed
        }

        // Generate ephemeral
        let eph = generateX25519()

        // DH1 = DH(IK_A, SPK_B)
        let dh1 = try x25519DH(idDHPriv, spkPub)
        // DH2 = DH(EK_A, IK_B)
        let dh2 = try x25519DH(eph.privateKey, theirIdentityDH)
        // DH3 = DH(EK_A, SPK_B)
        let dh3 = try x25519DH(eph.privateKey, spkPub)

        var dhConcat = dh1 + dh2 + dh3
        var usedOTPId: Int?

        if let otp = json["oneTimePreKey"] as? [String: Any],
           let otpPubB64 = otp["publicKey"] as? String,
           let otpPub = Data(base64Encoded: otpPubB64),
           let otpId = otp["id"] as? Int {
            let dh4 = try x25519DH(eph.privateKey, otpPub)
            dhConcat += dh4
            usedOTPId = otpId
        }

        let sharedSecret = hkdfSHA256(ikm: dhConcat, salt: x3dhSalt, info: x3dhInfoBytes, length: 32)

        pendingX3DH[conversationId] = X3DHHeader(
            identityDHKey: idDHPub.base64EncodedString(),
            ephemeralKey: eph.publicKey.base64EncodedString(),
            oneTimePreKeyId: usedOTPId
        )

        return try initSender(sharedSecret: sharedSecret, theirSignedPreKey: spkPub)
    }

    private func handleX3DHResponder(_ x3dhHeader: X3DHHeader) throws -> RatchetState {
        guard let idDHPriv = identityDHPrivate,
              let spkPub = signedPreKeyPublic, let spkPriv = signedPreKeyPrivate else {
            throw SessionError.noKeyMaterial
        }
        guard let theirIdDH = Data(base64Encoded: x3dhHeader.identityDHKey),
              let theirEph = Data(base64Encoded: x3dhHeader.ephemeralKey) else {
            throw SessionError.invalidHeader
        }

        // DH1 = DH(SPK_B, IK_A)
        let dh1 = try x25519DH(spkPriv, theirIdDH)
        // DH2 = DH(IK_B, EK_A)
        let dh2 = try x25519DH(idDHPriv, theirEph)
        // DH3 = DH(SPK_B, EK_A)
        let dh3 = try x25519DH(spkPriv, theirEph)

        var dhConcat = dh1 + dh2 + dh3

        if let otpId = x3dhHeader.oneTimePreKeyId,
           let otp = oneTimePreKeys.first(where: { $0.id == otpId }) {
            let dh4 = try x25519DH(otp.privateKey, theirEph)
            dhConcat += dh4
        }

        let sharedSecret = hkdfSHA256(ikm: dhConcat, salt: x3dhSalt, info: x3dhInfoBytes, length: 32)
        return initReceiver(sharedSecret: sharedSecret, ourSPKPublic: spkPub, ourSPKPrivate: spkPriv)
    }

    // MARK: - Public API

    func getOrCreateSession(conversationId: String, recipientUserId: String) async throws -> RatchetState {
        if let cached = cache[conversationId] { return cached }
        if let stored = loadState(conversationId) {
            cache[conversationId] = stored
            return stored
        }
        let state = try await performX3DH(conversationId: conversationId, recipientUserId: recipientUserId)
        cache[conversationId] = state
        saveState(conversationId, state)
        return state
    }

    func encryptMessage(conversationId: String, recipientUserId: String, plaintext: String) async throws -> EncryptedEnvelope {
        var state = try await getOrCreateSession(conversationId: conversationId, recipientUserId: recipientUserId)
        let ptData = plaintext.data(using: .utf8)!
        let (ct, iv, tag, header) = try ratchetEncrypt(&state, ptData)

        cache[conversationId] = state
        saveState(conversationId, state)

        var headerObj = header
        headerObj.tag = tag.base64EncodedString()

        if let x3dh = pendingX3DH[conversationId] {
            headerObj.x3dh = x3dh
            pendingX3DH.removeValue(forKey: conversationId)
        }

        let headerJSON = try JSONEncoder().encode(headerObj)

        return EncryptedEnvelope(
            ciphertext: ct.base64EncodedString(),
            iv: iv.base64EncodedString(),
            ratchetHeader: String(data: headerJSON, encoding: .utf8)!
        )
    }

    func decryptMessage(conversationId: String, ciphertext: String, iv: String, ratchetHeaderStr: String) throws -> String {
        guard let ctData = Data(base64Encoded: ciphertext),
              let ivData = Data(base64Encoded: iv),
              let headerData = ratchetHeaderStr.data(using: .utf8) else {
            return ciphertext // Not encrypted, return as-is (legacy plaintext)
        }

        let header: RatchetHeader
        do {
            header = try JSONDecoder().decode(RatchetHeader.self, from: headerData)
        } catch {
            return ciphertext // Not a valid ratchet header, likely plaintext
        }

        guard let tagB64 = header.tag, let tagData = Data(base64Encoded: tagB64) else {
            return ciphertext // No tag, likely plaintext
        }

        var state: RatchetState
        if let cached = cache[conversationId] {
            state = cached
        } else if let stored = loadState(conversationId) {
            state = stored
        } else if let x3dh = header.x3dh {
            // First message with X3DH header — create responder session
            state = try handleX3DHResponder(x3dh)
        } else {
            return ciphertext // No session and no X3DH header
        }

        let decrypted = try ratchetDecrypt(&state, ciphertext: ctData, iv: ivData, tag: tagData, header: header)
        cache[conversationId] = state
        saveState(conversationId, state)

        return String(data: decrypted, encoding: .utf8) ?? ciphertext
    }

    func clearAllSessions() {
        cache.removeAll()
        pendingX3DH.removeAll()
        SecureStorage.shared.remove(forKey: stateKey)
    }

    /// Derive a stable media-layer secret for RocP2P from the current ratchet root key.
    /// Both peers will produce the same 32-byte secret for the same conversation as long as
    /// their ratchet roots are synchronized. The P2PTransport feeds this into its own HKDF to
    /// produce distinct send/recv keys, so reusing this value across calls is safe.
    func p2pMediaSecret(conversationId: String) -> Data? {
        let state = cache[conversationId] ?? loadState(conversationId)
        guard let rk = state?.rootKey else { return nil }
        return hkdfSHA256(ikm: rk,
                          salt: "rocchat-media-root-v1".data(using: .utf8)!,
                          info: "rocchat.media".data(using: .utf8)!,
                          length: 32)
    }
}
