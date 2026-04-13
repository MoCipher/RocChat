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
                
                var oneTimePreKeys: [Data] = []
                for _ in 0..<20 {
                    let key = Curve25519.KeyAgreement.PrivateKey()
                    oneTimePreKeys.append(key.publicKey.rawRepresentation)
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
                
                let result = try await api.register(
                    username: cleanUsername,
                    displayName: displayName,
                    authHash: authHash.base64EncodedString(),
                    salt: salt.base64EncodedString(),
                    identityKey: identityKey.publicKey.rawRepresentation.base64EncodedString(),
                    identityPrivateEncrypted: encryptedKeys.base64EncodedString(),
                    signedPreKeyPublic: signedPreKey.publicKey.rawRepresentation.base64EncodedString(),
                    signedPreKeyPrivateEncrypted: signedPreKey.rawRepresentation.base64EncodedString(),
                    signedPreKeySignature: signature.base64EncodedString(),
                    oneTimePreKeys: oneTimePreKeys.map { $0.base64EncodedString() }
                )
                
                // Store keys locally
                try RocCrypto.storeKeys(vaultKey: vaultKey, encryptedKeys: encryptedKeys)
                
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
        // Session was already saved during registration — go straight to main app
        isAuthenticated = true
    }
    
    func logout() {
        UserDefaults.standard.removeObject(forKey: "session_token")
        UserDefaults.standard.removeObject(forKey: "user_id")
        api.sessionToken = nil
        isAuthenticated = false
    }
    
    private static let bip39Words = [
        "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
        "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
        "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
        "adapt", "add", "addict", "address", "adjust", "admit", "adult", "advance",
        "advice", "aerobic", "affair", "afford", "afraid", "again", "age", "agent",
        "agree", "ahead", "aim", "air", "airport", "aisle", "alarm", "album",
        "alcohol", "alert", "alien", "all", "alley", "allow", "almost", "alone",
        "alpha", "already", "also", "alter", "always", "amateur", "amazing", "among",
        "amount", "amused", "analyst", "anchor", "ancient", "anger", "angle", "angry",
        "animal", "ankle", "announce", "annual", "another", "answer", "antenna", "antique",
        "anxiety", "any", "apart", "apology", "appear", "apple", "approve", "april",
        "arch", "arctic", "area", "arena", "argue", "arm", "armed", "armor",
        "army", "around", "arrange", "arrest", "arrive", "arrow", "art", "artefact",
        "artist", "artwork", "ask", "aspect", "assault", "asset", "assist", "assume",
        "asthma", "athlete", "atom", "attack", "attend", "attitude", "attract", "auction",
        "audit", "august", "aunt", "author", "auto", "autumn", "average", "avocado",
        "avoid", "awake", "aware", "awesome", "awful", "awkward", "axis", "baby",
        "bachelor", "bacon", "badge", "bag", "balance", "balcony", "ball", "bamboo",
        "banana", "banner", "bar", "barely", "bargain", "barrel", "base", "basic",
        "basket", "battle", "beach", "bean", "beauty", "because", "become", "beef",
        "before", "begin", "behave", "behind", "believe", "below", "belt", "bench",
        "benefit", "best", "betray", "better", "between", "beyond", "bicycle", "bid",
        "bike", "bind", "biology", "bird", "birth", "bitter", "black", "blade",
        "blame", "blanket", "blast", "bleak", "bless", "blind", "blood", "blossom",
        "blow", "blue", "blur", "blush", "board", "boat", "body", "boil",
        "bomb", "bone", "bonus", "book", "boost", "border", "boring", "borrow",
        "boss", "bottom", "bounce", "box", "boy", "bracket", "brain", "brand",
        "brave", "bread", "breeze", "brick", "bridge", "brief", "bright", "bring",
        "brisk", "broccoli", "broken", "bronze", "broom", "brother", "brown", "brush",
        "bubble", "buddy", "budget", "buffalo", "build", "bulb", "bulk", "bullet",
        "bundle", "bunny", "burden", "burger", "burst", "bus", "business", "busy",
        "butter", "buyer", "buzz", "cabbage", "cabin", "cable", "cactus", "cage"
    ]
    
    static func generateRecoveryPhrase() -> [String] {
        (0..<12).map { _ in bip39Words.randomElement()! }
    }
}
