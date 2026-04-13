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
