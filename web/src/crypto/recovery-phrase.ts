/**
 * RocChat — BIP39 Recovery Phrase Generator
 *
 * Generates a 12-word mnemonic from 128 bits of entropy per BIP39 spec.
 * Uses the standard English BIP39 word list (2048 words), embedded locally.
 */

import { BIP39_WORDLIST } from './bip39-wordlist.js';

/**
 * Generate a 12-word BIP39 recovery phrase from 128 bits of entropy.
 * Returns the mnemonic words and the raw entropy bytes.
 */
export async function generateRecoveryPhrase(): Promise<{
  mnemonic: string;
  entropy: Uint8Array;
}> {
  const entropy = new Uint8Array(16); // 128 bits
  crypto.getRandomValues(entropy);

  const words: string[] = [];

  // Full BIP39: convert entropy to 11-bit indices
  // 128 bits entropy + 4 bits checksum = 132 bits = 12 words × 11 bits
  const hash = await crypto.subtle.digest('SHA-256', entropy);
  const hashBits = new Uint8Array(hash)[0]; // First byte for checksum

  // Combine entropy + checksum bits into a bit string
  let bits = '';
  entropy.forEach(b => bits += b.toString(2).padStart(8, '0'));
  bits += hashBits.toString(2).padStart(8, '0').slice(0, 4); // 4 checksum bits

  for (let i = 0; i < 12; i++) {
    const index = parseInt(bits.slice(i * 11, (i + 1) * 11), 2);
    words.push(BIP39_WORDLIST[index % 2048]);
  }

  return { mnemonic: words.join(' '), entropy };
}

/**
 * Validate a recovery phrase (basic check — correct word count and known words).
 */
export async function validateRecoveryPhrase(mnemonic: string): Promise<boolean> {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12) return false;
  return words.every(w => BIP39_WORDLIST.includes(w.toLowerCase()));
}

/**
 * Convert a 12-word mnemonic back to 16-byte entropy.
 * Returns null if invalid (wrong words or bad checksum).
 */
export async function entropyFromMnemonic(mnemonic: string): Promise<Uint8Array | null> {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (words.length !== 12) return null;

  let bits = '';
  for (const word of words) {
    const idx = BIP39_WORDLIST.indexOf(word);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(11, '0');
  }

  if (bits.length !== 132) return null;
  const entropyBits = bits.slice(0, 128);
  const checksumBits = bits.slice(128, 132);

  // Reconstruct entropy bytes
  const entropy = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    entropy[i] = parseInt(entropyBits.slice(i * 8, (i + 1) * 8), 2);
  }

  // Verify checksum
  const hash = await crypto.subtle.digest('SHA-256', entropy);
  const expected = ((new Uint8Array(hash)[0]) >> 4).toString(2).padStart(4, '0');
  if (checksumBits !== expected) return null;

  return entropy;
}

/**
 * Derive a 32-byte vault recovery key from BIP39 entropy via HKDF-SHA256.
 */
export async function deriveRecoveryKey(entropy: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', entropy as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('rocchat-recovery'),
      info: new TextEncoder().encode('rocchat-vault-recovery-key'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a key bundle with the recovery key for server-side storage.
 */
export async function encryptForRecovery(
  keyBundle: Uint8Array,
  recoveryKey: CryptoKey,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, recoveryKey, keyBundle as BufferSource);
  const result = new Uint8Array(12 + ct.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ct), 12);
  return result;
}

/**
 * Decrypt a key bundle using the recovery key.
 */
export async function decryptForRecovery(
  blob: Uint8Array,
  recoveryKey: CryptoKey,
): Promise<Uint8Array> {
  const iv = blob.slice(0, 12);
  const ct = new Uint8Array(blob.buffer, blob.byteOffset + 12, blob.byteLength - 12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, recoveryKey, ct as BufferSource);
  return new Uint8Array(pt);
}

/**
 * Derive a 32-byte vault recovery key from BIP39 entropy via HKDF-SHA256.
 *
 * Returns the raw bytes (not a CryptoKey) so callers can hand the key to the
 * generic `encryptPrivateKeys` / `decryptPrivateKeys` helpers, which expect a
 * `Uint8Array`. Same parameters as `deriveRecoveryKey` so the two derivations
 * are interchangeable for AES-GCM operations.
 */
export async function deriveRecoveryRawKey(entropy: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', entropy as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('rocchat-recovery'),
      info: enc.encode('rocchat-vault-recovery-key'),
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Compute the recovery verifier: SHA-256(domain || recoveryKey).
 *
 * Uploaded alongside the recovery vault so the unauthenticated recovery flow
 * can prove possession of the BIP39 mnemonic without revealing it server-side.
 * Returns a base64 string suitable for transport.
 */
export async function deriveRecoveryVerifier(recoveryKey: Uint8Array): Promise<string> {
  const domain = new TextEncoder().encode('rocchat:recovery:verifier:v1');
  const buf = new Uint8Array(domain.length + recoveryKey.length);
  buf.set(domain, 0);
  buf.set(recoveryKey, domain.length);
  const hash = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  const bytes = new Uint8Array(hash);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
