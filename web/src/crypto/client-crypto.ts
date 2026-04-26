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
import { putSecretString, getSecretString } from './secure-store.js';

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
 *
 * Optionally includes the X25519 identity DH keypair (used by X3DH and the
 * channel-key ECIES wrap). Including it here means a fresh device login
 * can fully restore E2E identity from password alone — without it, the
 * user would lose access to all existing E2E sessions and channel keys.
 */
export async function encryptPrivateKeys(
  vaultKey: Uint8Array,
  bundle: LocalKeyBundle,
  identityDH?: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<string> {
  const payload: Record<string, unknown> = {
    identityPrivateKey: toBase64(bundle.identityKeyPair.privateKey),
    signedPreKeyPrivateKey: toBase64(bundle.signedPreKey.keyPair.privateKey),
    oneTimePreKeys: bundle.oneTimePreKeys.map((k) => ({
      id: k.id,
      privateKey: toBase64(k.keyPair.privateKey),
    })),
  };
  if (identityDH) {
    payload.identityDHPublicKey = toBase64(identityDH.publicKey);
    payload.identityDHPrivateKey = toBase64(identityDH.privateKey);
  }
  const encrypted = await aesGcmEncrypt(encode(JSON.stringify(payload)), vaultKey);
  return toBase64(concat(encrypted.iv, encrypted.ciphertext, encrypted.tag));
}

/**
 * Decrypt private keys from server using vault key.
 *
 * `identityDHPublicKey` / `identityDHPrivateKey` may be undefined for
 * accounts registered before multi-device key recovery shipped — those
 * accounts are still single-device-bound for E2E sessions.
 */
export async function decryptPrivateKeys(
  vaultKey: Uint8Array,
  encryptedBlob: string,
): Promise<{
  identityPrivateKey: Uint8Array;
  signedPreKeyPrivateKey: Uint8Array;
  oneTimePreKeys: { id: number; privateKey: Uint8Array }[];
  identityDHPublicKey?: Uint8Array;
  identityDHPrivateKey?: Uint8Array;
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
    identityDHPublicKey: data.identityDHPublicKey ? fromBase64(data.identityDHPublicKey) : undefined,
    identityDHPrivateKey: data.identityDHPrivateKey ? fromBase64(data.identityDHPrivateKey) : undefined,
  };
}

/**
 * Store keys in IndexedDB (encrypted at rest via vault key AND an
 * in-browser non-extractable AES-GCM wrap key — defence in depth).
 */
export async function storeKeysLocally(vaultKey: Uint8Array, bundle: LocalKeyBundle): Promise<void> {
  const encrypted = await encryptPrivateKeys(vaultKey, bundle);
  await putSecretString('rocchat_keys', encrypted);
  localStorage.setItem('rocchat_identity_pub', toBase64(bundle.identityKeyPair.publicKey));
  await putSecretString('rocchat_identity_priv', toBase64(bundle.identityKeyPair.privateKey));
}

/**
 * Generate a fresh salt for a new user.
 */
export function generateSalt(): Uint8Array {
  return randomBytes(32);
}

const SPK_ROTATION_INTERVAL = 7 * 24 * 3600 * 1000; // 7 days

/**
 * Check if signed pre-key needs rotation and rotate if so.
 * Called on chat init. Generates new X25519 SPK, signs with identity key, uploads.
 */
export async function maybeRotateSignedPreKey(): Promise<void> {
  const lastRotation = Number(localStorage.getItem('rocchat_spk_last_rotation') || '0');
  if (Date.now() - lastRotation < SPK_ROTATION_INTERVAL) return;

  const identityPrivB64 =
    (await getSecretString('rocchat_identity_priv')) ||
    localStorage.getItem('rocchat_identity_priv');
  if (!identityPrivB64) return;

  try {
    const identityPriv = fromBase64(identityPrivB64);
    const newSpk = await generateX25519KeyPair();
    const signature = await ed25519Sign(identityPriv, newSpk.publicKey);
    const spkId = Math.floor(Date.now() / 1000);

    const { rotateSignedPreKey } = await import('../api.js');
    const res = await rotateSignedPreKey({
      id: spkId,
      publicKey: toBase64(newSpk.publicKey),
      signature: toBase64(signature),
    });

    if (res.ok) {
      localStorage.setItem('rocchat_spk_last_rotation', String(Date.now()));
      await putSecretString('rocchat_spk_priv', toBase64(newSpk.privateKey));
    }
  } catch {
    // Non-critical — will retry next load
  }
}
