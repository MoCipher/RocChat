/**
 * RocChat — Profile & Group Metadata Encryption
 *
 * Encrypts profile fields (display_name, status_text) and group metadata
 * so the server only sees encrypted blobs.
 *
 * Profile key: SHA-256(identityKey + ":profile:encrypt")
 * Group meta key: SHA-256(conversationId + ":group:meta")
 * Format: base64(iv) + "." + base64(ciphertext+tag)
 */

let profileKeyCache: CryptoKey | null = null;

async function getProfileKey(): Promise<CryptoKey> {
  if (profileKeyCache) return profileKeyCache;
  const idKey = localStorage.getItem('rocchat_identity_key') || 'default';
  const raw = new TextEncoder().encode(idKey + ':profile:encrypt');
  const hash = await crypto.subtle.digest('SHA-256', raw);
  const key = await crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
  profileKeyCache = key;
  return key;
}

async function getGroupMetaKey(conversationId: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(conversationId + ':group:meta');
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
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
  if (!ivB64 || !ctB64) return payload; // not encrypted, return as-is
  try {
    const iv = b64Decode(ivB64);
    const ct = b64Decode(ctB64);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, ct.buffer as ArrayBuffer);
    return new TextDecoder().decode(plain);
  } catch {
    return payload; // decryption failed — return raw (backward compat with plaintext)
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
  return aesDecrypt(key, value);
}

// ── Group Metadata ──

export async function encryptGroupMeta(conversationId: string, meta: { name?: string; description?: string; avatar_url?: string }): Promise<string> {
  const key = await getGroupMetaKey(conversationId);
  return aesEncrypt(key, JSON.stringify(meta));
}

export async function decryptGroupMeta(conversationId: string, encrypted: string): Promise<{ name?: string; description?: string; avatar_url?: string }> {
  if (!encrypted || !encrypted.includes('.')) {
    // Backward compat: plain text group name
    return { name: encrypted };
  }
  const key = await getGroupMetaKey(conversationId);
  const plain = await aesDecrypt(key, encrypted);
  try {
    return JSON.parse(plain);
  } catch {
    return { name: plain };
  }
}

export function clearProfileKeyCache() {
  profileKeyCache = null;
}
