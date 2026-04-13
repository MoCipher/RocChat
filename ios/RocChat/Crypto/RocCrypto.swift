import Foundation
import CryptoKit

enum RocCrypto {
    /// PBKDF2-SHA256 with 600k iterations, then SHA-256 the result.
    static func deriveAuthHash(passphrase: String, salt: Data) async throws -> Data {
        let passphraseData = Data(passphrase.utf8)
        let derived = try pbkdf2(password: passphraseData, salt: salt, iterations: 600_000, keyLength: 32)
        let hash = SHA256.hash(data: derived)
        return Data(hash)
    }
    
    /// HKDF vault key derivation (never sent to server).
    static func deriveVaultKey(passphrase: String, salt: Data) async throws -> SymmetricKey {
        let passphraseData = Data(passphrase.utf8)
        let derived = try pbkdf2(password: passphraseData, salt: salt, iterations: 600_000, keyLength: 32)
        let inputKey = SymmetricKey(data: derived)
        let info = Data("rocchat-vault-key".utf8)
        let vaultKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: inputKey, salt: salt, info: info, outputByteCount: 32)
        return vaultKey
    }
    
    /// AES-256-GCM encrypt.
    static func aesGcmEncrypt(key: SymmetricKey, plaintext: Data) throws -> Data {
        let nonce = AES.GCM.Nonce()
        let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
        guard let combined = sealed.combined else { throw CryptoError.encryptionFailed }
        return combined
    }
    
    /// AES-256-GCM decrypt.
    static func aesGcmDecrypt(key: SymmetricKey, ciphertext: Data) throws -> Data {
        let box = try AES.GCM.SealedBox(combined: ciphertext)
        return try AES.GCM.open(box, using: key)
    }
    
    /// Store encrypted keys in Keychain.
    static func storeKeys(vaultKey: SymmetricKey, encryptedKeys: Data) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "rocchat-encrypted-keys",
            kSecValueData as String: encryptedKeys,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw CryptoError.keychainError }
    }
    
    // PBKDF2 using CommonCrypto
    private static func pbkdf2(password: Data, salt: Data, iterations: Int, keyLength: Int) throws -> Data {
        var derivedKey = Data(count: keyLength)
        let result = derivedKey.withUnsafeMutableBytes { derivedKeyBytes in
            password.withUnsafeBytes { passwordBytes in
                salt.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        passwordBytes.baseAddress?.assumingMemoryBound(to: Int8.self),
                        password.count,
                        saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        UInt32(iterations),
                        derivedKeyBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        keyLength
                    )
                }
            }
        }
        guard result == kCCSuccess else { throw CryptoError.pbkdf2Failed }
        return derivedKey
    }
    
    enum CryptoError: Error {
        case encryptionFailed
        case decryptionFailed
        case pbkdf2Failed
        case keychainError
    }
}

import CommonCrypto
