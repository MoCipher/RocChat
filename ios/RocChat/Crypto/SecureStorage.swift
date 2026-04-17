/**
 * RocChat iOS — Secure Encrypted Storage
 *
 * Wraps sensitive data storage using iOS Keychain and AES-256-GCM encryption.
 * All cryptographic secrets (identity keys, ratchet states, session tokens)
 * are encrypted at rest with a device-bound master key stored in the Keychain.
 */

import Foundation
import CryptoKit

final class SecureStorage {
    static let shared = SecureStorage()

    private let masterKeyTag = "com.rocchat.storage.masterkey"
    private let defaults = UserDefaults.standard
    private var masterKey: SymmetricKey?

    private init() {
        masterKey = loadOrCreateMasterKey()
    }

    // MARK: - Public API

    /// Store encrypted data under the given key.
    func set(_ value: String, forKey key: String) {
        guard let mk = masterKey,
              let plainData = value.data(using: .utf8) else { return }
        do {
            let sealed = try AES.GCM.seal(plainData, using: mk)
            let combined = sealed.combined!
            defaults.set(combined.base64EncodedString(), forKey: "enc_\(key)")
        } catch { /* fallback: don't store */ }
    }

    /// Retrieve and decrypt data for the given key.
    func get(forKey key: String) -> String? {
        // Try encrypted storage first
        if let b64 = defaults.string(forKey: "enc_\(key)"),
           let combined = Data(base64Encoded: b64),
           let mk = masterKey {
            do {
                let box = try AES.GCM.SealedBox(combined: combined)
                let plainData = try AES.GCM.open(box, using: mk)
                return String(data: plainData, encoding: .utf8)
            } catch { /* corrupted or tampered */ }
        }

        // Migration: check if there's a plaintext value in old UserDefaults
        if let plaintext = defaults.string(forKey: key) {
            // Migrate to encrypted storage
            set(plaintext, forKey: key)
            defaults.removeObject(forKey: key)
            return plaintext
        }

        return nil
    }

    /// Remove a stored value.
    func remove(forKey key: String) {
        defaults.removeObject(forKey: "enc_\(key)")
        defaults.removeObject(forKey: key) // Also clean up any plaintext remnant
    }

    /// Store encrypted Data under the given key.
    func setData(_ value: Data, forKey key: String) {
        set(value.base64EncodedString(), forKey: key)
    }

    /// Retrieve and decrypt Data for the given key.
    func getData(forKey key: String) -> Data? {
        guard let b64 = get(forKey: key) else { return nil }
        return Data(base64Encoded: b64)
    }

    // MARK: - Master Key Management (Keychain)

    private func loadOrCreateMasterKey() -> SymmetricKey? {
        // Try to load from Keychain
        if let keyData = loadFromKeychain(tag: masterKeyTag) {
            return SymmetricKey(data: keyData)
        }

        // Generate and store
        let key = SymmetricKey(size: .bits256)
        let keyData = key.withUnsafeBytes { Data(Array($0)) }
        if saveToKeychain(tag: masterKeyTag, data: keyData) {
            return key
        }
        return nil
    }

    private func loadFromKeychain(tag: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: tag,
            kSecAttrService as String: "com.rocchat.secure-storage",
            kSecReturnData as String: true,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return data
    }

    private func saveToKeychain(tag: String, data: Data) -> Bool {
        // Delete any existing item first
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: tag,
            kSecAttrService as String: "com.rocchat.secure-storage",
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: tag,
            kSecAttrService as String: "com.rocchat.secure-storage",
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }
}
