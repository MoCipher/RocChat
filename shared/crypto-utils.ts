/**
 * RocChat — Shared Crypto Utilities
 * Platform-agnostic wrappers around Web Crypto API primitives.
 * Used by backend (Workers) and web frontend.
 * iOS/Android reimplement using CryptoKit / javax.crypto.
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Coerce Uint8Array<ArrayBufferLike> → Uint8Array<ArrayBuffer> for Web Crypto TS 5.9+ compat */
function buf(a: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer);
}

// ── Random bytes ──

export function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomId(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Encoding helpers ──

export function encode(s: string): Uint8Array {
  return ENCODER.encode(s);
}

export function decode(buf: Uint8Array | ArrayBuffer): string {
  return DECODER.decode(buf);
}

export function toBase64(buf: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── AES-256-GCM ──

export async function aesGcmEncrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad?: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }> {
  const iv = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: aad ? buf(aad) : undefined, tagLength: 128 },
    cryptoKey,
    buf(plaintext),
  );
  const raw = new Uint8Array(encrypted);
  // GCM appends the 16-byte tag to the ciphertext
  const ciphertext = raw.slice(0, raw.length - 16);
  const tag = raw.slice(raw.length - 16);
  return { ciphertext, iv, tag };
}

export async function aesGcmDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, ['decrypt']);
  const combined = concat(ciphertext, tag);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: aad ? buf(aad) : undefined, tagLength: 128 },
    cryptoKey,
    buf(combined),
  );
  return new Uint8Array(decrypted);
}

// ── HKDF-SHA256 ──

export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number = 32,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ── HMAC-SHA256 ──

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    buf(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, buf(data));
  return new Uint8Array(sig);
}

// ── SHA-256 ──

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', buf(data));
  return new Uint8Array(hash);
}

// ── SHA-512 ──

export async function sha512(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-512', buf(data));
  return new Uint8Array(hash);
}

// ── PBKDF2-SHA256 ──

export async function pbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number = 600_000,
  keyLength: number = 32,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', buf(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    baseKey,
    keyLength * 8,
  );
  return new Uint8Array(bits);
}

// ── X25519 Key Pair ──

export async function generateX25519KeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ]) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const priv = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return {
    publicKey: new Uint8Array(pub),
    privateKey: new Uint8Array(priv),
  };
}

export async function x25519DH(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  const privKey = await crypto.subtle.importKey(
    'pkcs8',
    buf(privateKey),
    { name: 'X25519' },
    false,
    ['deriveBits'],
  );
  const pubKey = await crypto.subtle.importKey(
    'raw',
    buf(publicKey),
    { name: 'X25519' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: pubKey },
    privKey,
    256,
  );
  return new Uint8Array(shared);
}

// ── Ed25519 Key Pair ──

export async function generateEd25519KeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const priv = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return {
    publicKey: new Uint8Array(pub),
    privateKey: new Uint8Array(priv),
  };
}

export async function ed25519Sign(
  privateKey: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    buf(privateKey),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('Ed25519', key, buf(message));
  return new Uint8Array(sig);
}

export async function ed25519Verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    buf(publicKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('Ed25519', key, buf(signature), buf(message));
}

// ── Safety Number Generation ──

export async function generateSafetyNumber(
  identityKeyA: Uint8Array,
  identityKeyB: Uint8Array,
): Promise<string> {
  // Sort keys for deterministic order
  const sorted = compareBytes(identityKeyA, identityKeyB) < 0
    ? concat(identityKeyA, identityKeyB)
    : concat(identityKeyB, identityKeyA);

  const hash = await sha512(sorted);
  // Convert to numeric groups: 12 groups of 5 digits
  const groups: string[] = [];
  for (let i = 0; i < 60 && i + 4 < hash.length; i += 5) {
    const num = ((hash[i] << 24) | (hash[i + 1] << 16) | (hash[i + 2] << 8) | hash[i + 3]) >>> 0;
    groups.push(String(num % 100000).padStart(5, '0'));
  }
  return groups.slice(0, 12).join(' ');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}
