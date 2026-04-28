/**
 * RocChat — Profile & Group Metadata Encryption
 *
 * Encrypts profile fields (display_name, status_text) and group metadata
 * so the server only sees encrypted blobs.
 *
 * Profile key: HKDF(vaultKey, "rocchat:profile:encrypt")
 * Group meta key: HKDF(vaultKey, conversationId + ":group:meta")
 *
 * The vault key is derived from the user's passphrase and NEVER leaves
 * the device, so the server cannot derive these keys — unlike the old
 * scheme which used the public identity key as input.
 *
 * Format: base64(iv) + "." + base64(ciphertext+tag)
 */

import { getSecretString } from './secure-store.js';

let profileKeyCache: CryptoKey | null = null;

async function getVaultKeyBytes(): Promise<Uint8Array | null> {
  const b64 = await getSecretString('rocchat_vault_key');
  if (!b64) return null;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveSubKey(ikm: Uint8Array, info: string): Promise<CryptoKey> {
  const normalizedIkm = new Uint8Array(ikm.byteLength);
  normalizedIkm.set(ikm);
  const baseKey = await crypto.subtle.importKey('raw', normalizedIkm, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function getLegacyProfileKey(): Promise<CryptoKey> {
  const idKey = localStorage.getItem('rocchat_identity_pub') || 'default';
  const raw = new TextEncoder().encode(idKey + ':profile:encrypt');
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function getLegacyGroupMetaKey(conversationId: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(conversationId + ':group:meta');
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function getProfileKey(): Promise<CryptoKey> {
  if (profileKeyCache) return profileKeyCache;
  const vk = await getVaultKeyBytes();
  if (vk) {
    profileKeyCache = await deriveSubKey(vk, 'rocchat:profile:encrypt');
  } else {
    profileKeyCache = await getLegacyProfileKey();
  }
  return profileKeyCache;
}

async function getGroupMetaKey(conversationId: string): Promise<CryptoKey> {
  const vk = await getVaultKeyBytes();
  if (vk) {
    return deriveSubKey(vk, conversationId + ':group:meta');
  }
  return getLegacyGroupMetaKey(conversationId);
}

function b64Encode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}

function b64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, new TextEncoder().encode(plaintext));
  return b64Encode(iv) + '.' + b64Encode(new Uint8Array(ct));
}

async function aesDecrypt(key: CryptoKey, payload: string): Promise<string> {
  const [ivB64, ctB64] = payload.split('.');
  if (!ivB64 || !ctB64) return '[encrypted]';
  try {
    const iv = b64Decode(ivB64);
    const ct = b64Decode(ctB64);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, ct.buffer as ArrayBuffer);
    return new TextDecoder().decode(plain);
  } catch {
    return '[encrypted]';
  }
}

// ── Profile Fields ──

export async function encryptProfileField(value: string): Promise<string> {
  if (!value) return value;
  const key = await getProfileKey();
  return aesEncrypt(key, value);
}

export async function decryptProfileField(value: string): Promise<string> {
  if (!value || !value.includes('.')) return value;
  const key = await getProfileKey();
  const result = await aesDecrypt(key, value);
  if (result === '[encrypted]') {
    const legacy = await getLegacyProfileKey();
    return aesDecrypt(legacy, value);
  }
  return result;
}

// ── Group Metadata ──

export async function encryptGroupMeta(conversationId: string, meta: { name?: string; description?: string; avatar_url?: string }): Promise<string> {
  const key = await getGroupMetaKey(conversationId);
  return aesEncrypt(key, JSON.stringify(meta));
}

export async function decryptGroupMeta(conversationId: string, encrypted: string): Promise<{ name?: string; description?: string; avatar_url?: string }> {
  if (!encrypted || !encrypted.includes('.')) {
    return { name: encrypted };
  }
  const key = await getGroupMetaKey(conversationId);
  let plain = await aesDecrypt(key, encrypted);
  if (plain === '[encrypted]') {
    const legacy = await getLegacyGroupMetaKey(conversationId);
    plain = await aesDecrypt(legacy, encrypted);
  }
  try {
    return JSON.parse(plain);
  } catch {
    return { name: plain };
  }
}

// ── Avatar E2E Encryption ──

async function getAvatarKey(): Promise<CryptoKey> {
  const vk = await getVaultKeyBytes();
  if (vk) {
    return deriveSubKey(vk, 'rocchat:avatar:encrypt');
  }
  return getLegacyProfileKey();
}

/**
 * Encrypt an avatar image buffer. Returns iv(12) || ciphertext || tag(16).
 */
export async function encryptAvatarBlob(plainBuffer: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await getAvatarKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBuffer);
  const ctBytes = new Uint8Array(ct);
  const result = new Uint8Array(12 + ctBytes.length);
  result.set(iv, 0);
  result.set(ctBytes, 12);
  return result.buffer;
}

/**
 * Decrypt an avatar blob. Input: iv(12) || ciphertext || tag(16).
 * Returns the raw image bytes, or null if decryption fails (e.g. legacy unencrypted avatar).
 */
export async function decryptAvatarBlob(encryptedBuffer: ArrayBuffer): Promise<ArrayBuffer | null> {
  if (encryptedBuffer.byteLength < 28) return null; // too short to be encrypted
  try {
    const bytes = new Uint8Array(encryptedBuffer);
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const key = await getAvatarKey();
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  } catch {
    return null; // unencrypted or legacy avatar
  }
}

export function clearProfileKeyCache() {
  profileKeyCache = null;
}
