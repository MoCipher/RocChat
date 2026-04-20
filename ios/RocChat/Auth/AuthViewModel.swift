import SwiftUI
import CryptoKit
import LocalAuthentication

@MainActor
class AuthViewModel: ObservableObject {
    @Published var isAuthenticated = false
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var recoveryPhrase: [String]?
    @Published var biometricLocked = false
    
    private let api = APIClient.shared
    
    var biometricType: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        case .none: return "Biometric"
        @unknown default: return "Biometric"
        }
    }
    
    var biometricAvailable: Bool {
        let context = LAContext()
        return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    }
    
    var biometricEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "biometric_enabled") }
        set { UserDefaults.standard.set(newValue, forKey: "biometric_enabled") }
    }
    
    init() {
        // Check for existing session
        if let token = UserDefaults.standard.string(forKey: "session_token") {
            api.sessionToken = token
            SessionManager.shared.loadCachedKeyMaterial()
            if biometricEnabled && biometricAvailable {
                biometricLocked = true
            } else {
                isAuthenticated = true
            }
        }
    }
    
    func authenticateWithBiometric() {
        let context = LAContext()
        context.localizedCancelTitle = "Use Passphrase"
        
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                               localizedReason: "Unlock RocChat") { success, error in
            DispatchQueue.main.async {
                if success {
                    self.biometricLocked = false
                    self.isAuthenticated = true
                } else {
                    self.errorMessage = "Authentication failed. Enter your passphrase."
                    self.biometricLocked = false
                    // Fall back to passphrase login — clear session
                    UserDefaults.standard.removeObject(forKey: "session_token")
                    self.api.sessionToken = nil
                }
            }
        }
    }
    
    func enableBiometric() {
        biometricEnabled = true
    }
    
    func disableBiometric() {
        biometricEnabled = false
    }
    
    func login(username: String, passphrase: String) {
        guard !username.isEmpty, !passphrase.isEmpty else {
            errorMessage = "All fields are required."
            return
        }
        
        isLoading = true
        errorMessage = nil
        
        Task {
            do {
                let cleanUsername = username.lowercased().trimmingCharacters(in: .whitespaces)
                    .replacingOccurrences(of: "@", with: "")
                
                // Derive auth hash
                let salt = Data("rocchat:\(cleanUsername)".utf8)
                let authHash = try await RocCrypto.deriveAuthHash(passphrase: passphrase, salt: salt)
                
                let result = try await api.login(username: cleanUsername, authHash: authHash.base64EncodedString())
                
                UserDefaults.standard.set(result.sessionToken, forKey: "session_token")
                UserDefaults.standard.set(result.userId, forKey: "user_id")
                api.sessionToken = result.sessionToken
                
                // Initialize session manager key material
                SessionManager.shared.loadCachedKeyMaterial()
                
                isAuthenticated = true
            } catch {
                errorMessage = "Invalid username or passphrase."
            }
            isLoading = false
        }
    }
    
    func register(username: String, displayName: String, passphrase: String, passphraseConfirm: String) {
        guard !username.isEmpty, !displayName.isEmpty, !passphrase.isEmpty else {
            errorMessage = "All fields are required."
            return
        }
        guard passphrase == passphraseConfirm else {
            errorMessage = "Passphrases do not match."
            return
        }
        guard passphrase.count >= 16 else {
            errorMessage = "Passphrase must be at least 16 characters."
            return
        }
        
        isLoading = true
        errorMessage = nil
        
        Task {
            do {
                let cleanUsername = username.lowercased().trimmingCharacters(in: .whitespaces)
                    .replacingOccurrences(of: "@", with: "")
                
                // Generate keys
                let identityKey = Curve25519.Signing.PrivateKey()
                let signedPreKey = Curve25519.KeyAgreement.PrivateKey()
                let signature = try identityKey.signature(for: signedPreKey.publicKey.rawRepresentation)
                
                // Generate identity DH key (X25519 for X3DH)
                let identityDHKey = Curve25519.KeyAgreement.PrivateKey()
                
                var oneTimePreKeyPairs: [(pub: Data, priv: Data)] = []
                for _ in 0..<20 {
                    let key = Curve25519.KeyAgreement.PrivateKey()
                    oneTimePreKeyPairs.append((key.publicKey.rawRepresentation, key.rawRepresentation))
                }
                
                // Derive auth hash
                let salt = Data("rocchat:\(cleanUsername)".utf8)
                let authHash = try await RocCrypto.deriveAuthHash(passphrase: passphrase, salt: salt)
                let vaultKey = try await RocCrypto.deriveVaultKey(passphrase: passphrase, salt: salt)
                
                // Encrypt private keys with vault key
                let privateKeysPayload = try JSONSerialization.data(withJSONObject: [
                    "identityPrivateKey": identityKey.rawRepresentation.base64EncodedString(),
                    "signedPreKeyPrivateKey": signedPreKey.rawRepresentation.base64EncodedString(),
                ])
                let encryptedKeys = try RocCrypto.aesGcmEncrypt(key: vaultKey, plaintext: privateKeysPayload)
                
                // Encrypt SPK private key with vault key before sending to server
                let spkPrivateEncrypted = try RocCrypto.aesGcmEncrypt(key: vaultKey, plaintext: signedPreKey.rawRepresentation)
                
                let result = try await api.register(
                    username: cleanUsername,
                    displayName: displayName,
                    authHash: authHash.base64EncodedString(),
                    salt: salt.base64EncodedString(),
                    identityKey: identityKey.publicKey.rawRepresentation.base64EncodedString(),
                    identityDHKey: identityDHKey.publicKey.rawRepresentation.base64EncodedString(),
                    identityPrivateEncrypted: encryptedKeys.base64EncodedString(),
                    signedPreKeyPublic: signedPreKey.publicKey.rawRepresentation.base64EncodedString(),
                    signedPreKeyPrivateEncrypted: spkPrivateEncrypted.base64EncodedString(),
                    signedPreKeySignature: signature.base64EncodedString(),
                    oneTimePreKeys: oneTimePreKeyPairs.map { $0.pub.base64EncodedString() }
                )
                
                // Store keys locally
                try RocCrypto.storeKeys(vaultKey: vaultKey, encryptedKeys: encryptedKeys)
                
                // Cache key material for E2E session manager
                UserDefaults.standard.set(identityDHKey.publicKey.rawRepresentation, forKey: "rocchat_identity_dh_pub")
                UserDefaults.standard.set(identityDHKey.rawRepresentation, forKey: "rocchat_identity_dh_priv")
                SessionManager.shared.identityDHPublic = identityDHKey.publicKey.rawRepresentation
                SessionManager.shared.identityDHPrivate = identityDHKey.rawRepresentation
                SessionManager.shared.cacheKeyMaterial(
                    signedPreKeyPub: signedPreKey.publicKey.rawRepresentation,
                    signedPreKeyPriv: signedPreKey.rawRepresentation,
                    otpKeys: oneTimePreKeyPairs.enumerated().map { (i, kp) in (id: i, privateKey: kp.priv, publicKey: kp.pub) }
                )
                
                // Save session from registration response
                UserDefaults.standard.set(result.sessionToken, forKey: "session_token")
                UserDefaults.standard.set(result.userId, forKey: "user_id")
                api.sessionToken = result.sessionToken
                
                // Generate and display recovery phrase
                recoveryPhrase = Self.generateRecoveryPhrase()
            } catch {
                errorMessage = "Registration failed. Try a different username."
            }
            isLoading = false
        }
    }
    
    func dismissRecoveryPhrase() {
        recoveryPhrase = nil
        // Show import wizard before entering main app
        showImportWizard = true
    }
    
    @Published var showImportWizard = false
    
    func dismissImportWizard() {
        showImportWizard = false
        isAuthenticated = true
    }
    
    func logout() {
        // Server-side session invalidation (fire-and-forget)
        Task { try? await api.postRaw("/auth/logout", body: [:]) }
        
        // Clear all stored data
        let keys = ["session_token", "user_id", "encrypted_keys", "identity_key",
                     "identity_pub", "spk_pub", "biometric_enabled"]
        keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
        api.sessionToken = nil
        isAuthenticated = false
        biometricLocked = false
    }
    
    private static func generateRecoveryPhrase() -> [String] {
        let result = BIP39.generate()
        // Store entropy for recovery key derivation
        UserDefaults.standard.set(result.entropy, forKey: "bip39_entropy")
        return result.mnemonic.split(separator: " ").map(String.init)
    }
}
