import Foundation
import CommonCrypto

class APIClient {
    static let shared = APIClient()
    
    var sessionToken: String?
    var refreshToken: String?
    private let baseURL: String
    
    init(baseURL: String = "https://chat.mocipher.com/api") {
        self.baseURL = baseURL
    }
    
    struct LoginResult {
        let sessionToken: String
        let userId: String
        let encryptedKeys: String?
        let identityKey: String?
    }
    
    func login(username: String, authHash: String) async throws -> LoginResult {
        let body: [String: Any] = ["username": username, "auth_hash": authHash]
        let data = try await post("/auth/login", body: body)
        
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["session_token"] as? String,
              let userId = json["user_id"] as? String else {
            throw APIError.invalidResponse
        }
        refreshToken = json["refresh_token"] as? String
        
        return LoginResult(
            sessionToken: token,
            userId: userId,
            encryptedKeys: json["encrypted_keys"] as? String,
            identityKey: json["identity_key"] as? String
        )
    }
    
    struct RegisterResult {
        let sessionToken: String
        let userId: String
        let deviceId: String
    }

    func register(
        username: String,
        displayName: String,
        authHash: String,
        salt: String,
        identityKey: String,
        identityDHKey: String,
        identityPrivateEncrypted: String,
        signedPreKeyPublic: String,
        signedPreKeyPrivateEncrypted: String,
        signedPreKeySignature: String,
        oneTimePreKeys: [String]
    ) async throws -> RegisterResult {
        // Solve proof-of-work before registration
        let pow = try await solvePoW()

        var body: [String: Any] = [
            "username": username,
            "display_name": displayName,
            "auth_hash": authHash,
            "salt": salt,
            "identity_key": identityKey,
            "identity_dh_key": identityDHKey,
            "identity_private_encrypted": identityPrivateEncrypted,
            "signed_pre_key_public": signedPreKeyPublic,
            "signed_pre_key_private_encrypted": signedPreKeyPrivateEncrypted,
            "signed_pre_key_signature": signedPreKeySignature,
            "one_time_pre_keys": oneTimePreKeys,
        ]
        if let token = pow["token"], let nonce = pow["nonce"] {
            body["pow_token"] = token
            body["pow_nonce"] = nonce
        }
        let data = try await post("/auth/register", body: body)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["session_token"] as? String,
              let userId = json["user_id"] as? String else {
            throw APIError.invalidResponse
        }
        return RegisterResult(
            sessionToken: token,
            userId: userId,
            deviceId: json["device_id"] as? String ?? ""
        )
    }
    
    func getConversations() async throws -> [[String: Any]] {
        let data = try await get("/messages/conversations")
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let conversations = json["conversations"] as? [[String: Any]] else {
            throw APIError.invalidResponse
        }
        return conversations
    }
    
    func getContacts() async throws -> [[String: Any]] {
        let data = try await get("/contacts")
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let contacts = json["contacts"] as? [[String: Any]] else {
            throw APIError.invalidResponse
        }
        return contacts
    }
    
    func getMe() async throws -> [String: Any] {
        let data = try await get("/me")
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.invalidResponse
        }
        return json
    }
    
    // MARK: - Public raw HTTP helpers (used by chat screens)
    
    func getRaw(_ path: String) async throws -> Data {
        return try await get(path)
    }
    
    func postRaw(_ path: String, body: [String: Any], method: String = "POST") async throws -> Data {
        var request = URLRequest(url: URL(string: "\(baseURL)\(path)")!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = sessionToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await requestWithRetry(request)
        try validateResponse(response)
        return data
    }

    func uploadBinary(_ path: String, data: Data, headers: [String: String]) async throws -> Data {
        var request = URLRequest(url: URL(string: "\(baseURL)\(path)")!)
        request.httpMethod = "POST"
        if let token = sessionToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.httpBody = data
        let (respData, response) = try await requestWithRetry(request)
        try validateResponse(response)
        return respData
    }

    func deleteRaw(_ path: String) async throws -> Data {
        var request = URLRequest(url: URL(string: "\(baseURL)\(path)")!)
        request.httpMethod = "DELETE"
        if let token = sessionToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await requestWithRetry(request)
        try validateResponse(response)
        return data
    }
    
    // MARK: - HTTP helpers
    
    private func get(_ path: String) async throws -> Data {
        var request = URLRequest(url: URL(string: "\(baseURL)\(path)")!)
        request.httpMethod = "GET"
        if let token = sessionToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await requestWithRetry(request)
        try validateResponse(response)
        return data
    }
    
    private func post(_ path: String, body: [String: Any]) async throws -> Data {
        var request = URLRequest(url: URL(string: "\(baseURL)\(path)")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = sessionToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await requestWithRetry(request)
        try validateResponse(response)
        return data
    }
    
    private func validateResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200...299).contains(http.statusCode) else {
            throw APIError.httpError(http.statusCode)
        }
    }
    
    enum APIError: Error {
        case invalidResponse
        case httpError(Int)
    }

    /// Upload encrypted media to R2, returns the blob ID string
    func uploadMedia(_ encryptedData: Data) async throws -> String {
        let data = try await uploadBinary("/media/upload", data: encryptedData, headers: [
            "Content-Type": "application/octet-stream"
        ])
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let blobId = json["blob_id"] as? String {
            return blobId
        }
        // Fallback: some APIs return the id at the top level
        if let str = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty {
            return str
        }
        throw APIError.invalidResponse
    }

    // MARK: - Proof-of-Work Solver

    func solvePoW() async throws -> [String: String] {
        let challengeData = try await getRaw("/features/pow/challenge")
        guard let json = try JSONSerialization.jsonObject(with: challengeData) as? [String: Any],
              let token = json["token"] as? String,
              let challenge = json["challenge"] as? String,
              let difficulty = json["difficulty"] as? Int else {
            return [:]
        }
        if difficulty == 0 { return ["token": token, "nonce": "0"] }

        for nonce in 0..<10_000_000 {
            let input = "\(challenge):\(nonce)"
            guard let inputData = input.data(using: .utf8) else { continue }
            var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
            inputData.withUnsafeBytes { ptr in
                _ = CC_SHA256(ptr.baseAddress, CC_LONG(inputData.count), &hash)
            }
            if leadingZeroBits(hash) >= difficulty {
                return ["token": token, "nonce": String(nonce)]
            }
        }
        return [:]
    }

    private func leadingZeroBits(_ bytes: [UInt8]) -> Int {
        var bits = 0
        for b in bytes {
            if b == 0 { bits += 8; continue }
            var mask: UInt8 = 0x80
            while mask > 0 && (b & mask) == 0 {
                bits += 1
                mask >>= 1
            }
            return bits
        }
        return bits
    }

    // MARK: - Refresh Token Rotation

    func refreshSession() async throws -> Bool {
        guard let rt = refreshToken else { return false }
        var request = URLRequest(url: URL(string: "\(baseURL)/auth/refresh")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": rt])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let newSession = json["session_token"] as? String else { return false }
        sessionToken = newSession
        refreshToken = json["refresh_token"] as? String
        return true
    }

    private func requestWithRetry(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            // Try to refresh and retry once
            if try await refreshSession() {
                var retryReq = request
                if let token = sessionToken {
                    retryReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }
                return try await URLSession.shared.data(for: retryReq)
            }
        }
        return (data, response)
    }
}
