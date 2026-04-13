/**
 * RocChat Shared — Sender Keys (Group E2E Encryption)
 *
 * Each group member generates a Sender Key and distributes it via pairwise
 * Double Ratchet channels. Group messages are encrypted once with the sender's
 * chain key (AES-256-GCM). All recipients decrypt with the sender's key.
 * Performance: O(1) encrypt instead of O(n).
 *
 * Sender Key is rotated when any member leaves the group.
 */

import {
  randomBytes,
  aesGcmEncrypt,
  aesGcmDecrypt,
  hmacSha256,
  toBase64,
  fromBase64,
  concat,
  encode,
} from './crypto-utils.js';

export interface SenderKey {
  chainKey: Uint8Array;       // 32 bytes — ratcheted per message
  signingKey: Uint8Array;     // 32 bytes — for message authentication
  iteration: number;
}

export interface SenderKeyDistribution {
  senderId: string;
  groupId: string;
  chainKey: string;           // base64
  signingKey: string;         // base64
  iteration: number;
}

export interface GroupCiphertext {
  senderId: string;
  iteration: number;
  ciphertext: Uint8Array;
}

/**
 * Generate a new Sender Key for a group.
 */
export function generateSenderKey(): SenderKey {
  return {
    chainKey: randomBytes(32),
    signingKey: randomBytes(32),
    iteration: 0,
  };
}

/**
 * Create a distribution message for sharing the sender key via pairwise channels.
 */
export function createDistribution(
  senderId: string,
  groupId: string,
  key: SenderKey,
): SenderKeyDistribution {
  return {
    senderId,
    groupId,
    chainKey: toBase64(key.chainKey),
    signingKey: toBase64(key.signingKey),
    iteration: key.iteration,
  };
}

/**
 * Import a sender key from a distribution message.
 */
export function importDistribution(dist: SenderKeyDistribution): SenderKey {
  return {
    chainKey: fromBase64(dist.chainKey),
    signingKey: fromBase64(dist.signingKey),
    iteration: dist.iteration,
  };
}

/**
 * Ratchet the chain key forward by one step.
 * Returns the Message Key for encryption and advances the chain.
 */
async function ratchetChainKey(
  key: SenderKey,
): Promise<{ messageKey: Uint8Array; updatedKey: SenderKey }> {
  // Message Key = HMAC-SHA256(chainKey, 0x01)
  const messageKey = await hmacSha256(key.chainKey, new Uint8Array([0x01]));

  // Next Chain Key = HMAC-SHA256(chainKey, 0x02)
  const nextChainKey = await hmacSha256(key.chainKey, new Uint8Array([0x02]));

  return {
    messageKey,
    updatedKey: {
      chainKey: nextChainKey,
      signingKey: key.signingKey,
      iteration: key.iteration + 1,
    },
  };
}

/**
 * Encrypt a message for the group using sender key.
 * Mutates the provided sender key (ratchets forward).
 */
export async function senderKeyEncrypt(
  senderId: string,
  senderKey: SenderKey,
  plaintext: Uint8Array,
): Promise<{ ciphertext: GroupCiphertext; updatedKey: SenderKey }> {
  const { messageKey, updatedKey } = await ratchetChainKey(senderKey);

  // Encrypt: AES-256-GCM with AAD = senderId || iteration
  const aad = concat(encode(senderId), encode(`:${updatedKey.iteration - 1}`));
  const encrypted = await aesGcmEncrypt(plaintext, messageKey, aad);

  return {
    ciphertext: {
      senderId,
      iteration: updatedKey.iteration - 1,
      ciphertext: concat(encrypted.iv, encrypted.ciphertext, encrypted.tag),
    },
    updatedKey,
  };
}

/**
 * Decrypt a group message using the sender's key.
 * Advances the local copy of the sender's key to match.
 */
export async function senderKeyDecrypt(
  senderKey: SenderKey,
  msg: GroupCiphertext,
): Promise<{ plaintext: Uint8Array; updatedKey: SenderKey }> {
  let currentKey = senderKey;

  // Fast-forward chain to the correct iteration
  while (currentKey.iteration < msg.iteration) {
    const { updatedKey } = await ratchetChainKey(currentKey);
    currentKey = updatedKey;
  }

  if (currentKey.iteration !== msg.iteration) {
    throw new Error('Sender key iteration mismatch — message may be too old');
  }

  const { messageKey, updatedKey } = await ratchetChainKey(currentKey);

  const aad = concat(encode(msg.senderId), encode(`:${msg.iteration}`));
  // Parse combined format: iv (12) || ciphertext || tag (16)
  const iv = msg.ciphertext.slice(0, 12);
  const tag = msg.ciphertext.slice(msg.ciphertext.length - 16);
  const ct = msg.ciphertext.slice(12, msg.ciphertext.length - 16);
  const plaintext = await aesGcmDecrypt(ct, messageKey, iv, tag, aad);

  return { plaintext, updatedKey };
}

/**
 * Serialize a SenderKey for storage.
 */
export function serializeSenderKey(key: SenderKey): string {
  return JSON.stringify({
    chainKey: toBase64(key.chainKey),
    signingKey: toBase64(key.signingKey),
    iteration: key.iteration,
  });
}

/**
 * Deserialize a SenderKey from storage.
 */
export function deserializeSenderKey(data: string): SenderKey {
  const parsed = JSON.parse(data);
  return {
    chainKey: fromBase64(parsed.chainKey),
    signingKey: fromBase64(parsed.signingKey),
    iteration: parsed.iteration,
  };
}
