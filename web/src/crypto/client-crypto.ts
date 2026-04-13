/**
 * RocChat Web — Client-Side Crypto
 *
 * Wraps the shared crypto library for browser use.
 * Handles passphrase → auth_hash derivation, key generation, vault encryption.
 */

import {
  randomBytes,
  toBase64,
  fromBase64,
  concat,
  pbkdf2,
  sha256,
  aesGcmEncrypt,
  aesGcmDecrypt,
  generateX25519KeyPair,
  generateEd25519KeyPair,
  ed25519Sign,
  hkdf,
  encode,
} from '@rocchat/shared';

const PBKDF2_ITERATIONS = 600_000;

export interface LocalKeyBundle {
  identityKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  signedPreKey: {
    id: number;
    keyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
    signature: Uint8Array;
  };
  oneTimePreKeys: { id: number; keyPair: { publicKey: Uint8Array; privateKey: Uint8Array } }[];
}

/**
 * Derive auth hash from passphrase + salt (sent to server for verification).
 * Double-hash: PBKDF2(passphrase, salt) → SHA-256 of that.
 * Server never sees passphrase itself.
 */
export async function deriveAuthHash(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const stretchedKey = await pbkdf2(encode(passphrase), salt, PBKDF2_ITERATIONS, 32);
  return sha256(stretchedKey);
}

/**
 * Derive vault encryption key from passphrase (used locally to protect private keys).
 * This NEVER leaves the device.
 */
export async function deriveVaultKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const info = encode('rocchat-vault-key');
  const stretchedKey = await pbkdf2(encode(passphrase), salt, PBKDF2_ITERATIONS, 32);
  return hkdf(stretchedKey, salt, info, 32);
}

/**
 * Generate a complete key bundle for registration.
 */
export async function generateKeyBundle(): Promise<LocalKeyBundle> {
  const identityKeyPair = await generateEd25519KeyPair();
  const signedPreKeyPair = await generateX25519KeyPair();
  const signature = await ed25519Sign(identityKeyPair.privateKey, signedPreKeyPair.publicKey);

  const oneTimePreKeys: LocalKeyBundle['oneTimePreKeys'] = [];
  for (let i = 0; i < 20; i++) {
    const kp = await generateX25519KeyPair();
    oneTimePreKeys.push({ id: i, keyPair: kp });
  }

  return {
    identityKeyPair,
    signedPreKey: { id: 0, keyPair: signedPreKeyPair, signature },
    oneTimePreKeys,
  };
}

/**
 * Encrypt private keys with vault key for server storage.
 */
export async function encryptPrivateKeys(
  vaultKey: Uint8Array,
  bundle: LocalKeyBundle,
): Promise<string> {
  const payload = JSON.stringify({
    identityPrivateKey: toBase64(bundle.identityKeyPair.privateKey),
    signedPreKeyPrivateKey: toBase64(bundle.signedPreKey.keyPair.privateKey),
    oneTimePreKeys: bundle.oneTimePreKeys.map((k) => ({
      id: k.id,
      privateKey: toBase64(k.keyPair.privateKey),
    })),
  });

  const encrypted = await aesGcmEncrypt(encode(payload), vaultKey);
  return toBase64(concat(encrypted.iv, encrypted.ciphertext, encrypted.tag));
}

/**
 * Decrypt private keys from server using vault key.
 */
export async function decryptPrivateKeys(
  vaultKey: Uint8Array,
  encryptedBlob: string,
): Promise<{
  identityPrivateKey: Uint8Array;
  signedPreKeyPrivateKey: Uint8Array;
  oneTimePreKeys: { id: number; privateKey: Uint8Array }[];
}> {
  const raw = fromBase64(encryptedBlob);
  // Format: iv (12) || ciphertext || tag (16)
  const iv = raw.slice(0, 12);
  const tag = raw.slice(raw.length - 16);
  const ct = raw.slice(12, raw.length - 16);
  const decrypted = await aesGcmDecrypt(ct, vaultKey, iv, tag);
  const data = JSON.parse(new TextDecoder().decode(decrypted));

  return {
    identityPrivateKey: fromBase64(data.identityPrivateKey),
    signedPreKeyPrivateKey: fromBase64(data.signedPreKeyPrivateKey),
    oneTimePreKeys: data.oneTimePreKeys.map((k: { id: number; privateKey: string }) => ({
      id: k.id,
      privateKey: fromBase64(k.privateKey),
    })),
  };
}

/**
 * Store keys in IndexedDB (encrypted at rest via vault key).
 */
export async function storeKeysLocally(vaultKey: Uint8Array, bundle: LocalKeyBundle): Promise<void> {
  const encrypted = await encryptPrivateKeys(vaultKey, bundle);
  localStorage.setItem('rocchat_keys', encrypted);
  localStorage.setItem('rocchat_identity_pub', toBase64(bundle.identityKeyPair.publicKey));
}

/**
 * Generate a fresh salt for a new user.
 */
export function generateSalt(): Uint8Array {
  return randomBytes(32);
}
