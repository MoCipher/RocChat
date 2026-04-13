/**
 * RocChat — Double Ratchet Protocol
 *
 * Provides forward secrecy and break-in recovery for 1:1 messaging.
 * Each message uses a unique encryption key derived from a ratcheting chain.
 *
 * Based on the Signal Double Ratchet specification:
 * - Symmetric-key ratchet (HMAC chain) for per-message keys
 * - DH ratchet (X25519) for break-in recovery
 */

import {
  generateX25519KeyPair,
  x25519DH,
  hmacSha256,
  hkdf,
  aesGcmEncrypt,
  aesGcmDecrypt,
  concat,
  encode,
  toBase64,
  fromBase64,
} from './crypto-utils.js';

// ── Types ──

export interface MessageHeader {
  dhPublicKey: Uint8Array; // Current ratchet DH public key
  previousChainLength: number; // Number of messages in previous sending chain
  messageNumber: number; // Message number in current sending chain
}

export interface EncryptedMessage {
  header: {
    dhPublicKey: string; // base64
    pn: number;
    n: number;
  };
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
}

interface ChainKey {
  key: Uint8Array;
  index: number;
}

interface SkippedKey {
  dhPublicKey: string; // base64 of DH public key
  messageNumber: number;
  messageKey: Uint8Array;
}

const MAX_SKIP = 256; // Maximum messages to skip in a chain
const CHAIN_KEY_SEED = encode('RocChat_ChainKey');
const MESSAGE_KEY_SEED = encode('RocChat_MessageKey');
const RATCHET_INFO = encode('RocChat_Ratchet_v1');

// ── Double Ratchet Session State ──

export interface RatchetState {
  // DH ratchet
  dhSendingKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
  dhReceivingKey: Uint8Array | null;
  // Root key
  rootKey: Uint8Array;
  // Chain keys
  sendingChainKey: Uint8Array | null;
  receivingChainKey: Uint8Array | null;
  // Counters
  sendingMessageNumber: number;
  receivingMessageNumber: number;
  previousSendingChainLength: number;
  // Skipped message keys (for out-of-order delivery)
  skippedKeys: SkippedKey[];
}

export interface SerializedRatchetState {
  dhsPub: string | null;
  dhsPriv: string | null;
  dhr: string | null;
  rk: string;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  skipped: Array<{ dk: string; n: number; mk: string }>;
}

// ── Serialization ──

export function serializeState(state: RatchetState): SerializedRatchetState {
  return {
    dhsPub: state.dhSendingKeyPair ? toBase64(state.dhSendingKeyPair.publicKey) : null,
    dhsPriv: state.dhSendingKeyPair ? toBase64(state.dhSendingKeyPair.privateKey) : null,
    dhr: state.dhReceivingKey ? toBase64(state.dhReceivingKey) : null,
    rk: toBase64(state.rootKey),
    cks: state.sendingChainKey ? toBase64(state.sendingChainKey) : null,
    ckr: state.receivingChainKey ? toBase64(state.receivingChainKey) : null,
    ns: state.sendingMessageNumber,
    nr: state.receivingMessageNumber,
    pn: state.previousSendingChainLength,
    skipped: state.skippedKeys.map((sk) => ({
      dk: sk.dhPublicKey,
      n: sk.messageNumber,
      mk: toBase64(sk.messageKey),
    })),
  };
}

export function deserializeState(s: SerializedRatchetState): RatchetState {
  return {
    dhSendingKeyPair:
      s.dhsPub && s.dhsPriv
        ? { publicKey: fromBase64(s.dhsPub), privateKey: fromBase64(s.dhsPriv) }
        : null,
    dhReceivingKey: s.dhr ? fromBase64(s.dhr) : null,
    rootKey: fromBase64(s.rk),
    sendingChainKey: s.cks ? fromBase64(s.cks) : null,
    receivingChainKey: s.ckr ? fromBase64(s.ckr) : null,
    sendingMessageNumber: s.ns,
    receivingMessageNumber: s.nr,
    previousSendingChainLength: s.pn,
    skippedKeys: s.skipped.map((sk) => ({
      dhPublicKey: sk.dk,
      messageNumber: sk.n,
      messageKey: fromBase64(sk.mk),
    })),
  };
}

// ── KDF Chains ──

async function kdfRootKey(
  rootKey: Uint8Array,
  dhOutput: Uint8Array,
): Promise<{ newRootKey: Uint8Array; chainKey: Uint8Array }> {
  const derived = await hkdf(dhOutput, rootKey, RATCHET_INFO, 64);
  return {
    newRootKey: derived.slice(0, 32),
    chainKey: derived.slice(32, 64),
  };
}

async function kdfChainKey(
  chainKey: Uint8Array,
): Promise<{ newChainKey: Uint8Array; messageKey: Uint8Array }> {
  const newChainKey = await hmacSha256(chainKey, CHAIN_KEY_SEED);
  const messageKey = await hmacSha256(chainKey, MESSAGE_KEY_SEED);
  return { newChainKey, messageKey };
}

// ── Session Initialization ──

/**
 * Initialize as the party who sent the first message (after X3DH).
 * - sharedSecret: from X3DH
 * - theirSignedPreKey: recipient's signed pre-key public key
 */
export async function initSender(
  sharedSecret: Uint8Array,
  theirSignedPreKey: Uint8Array,
): Promise<RatchetState> {
  const dhSendingKeyPair = await generateX25519KeyPair();
  const dhOutput = await x25519DH(dhSendingKeyPair.privateKey, theirSignedPreKey);
  const { newRootKey, chainKey } = await kdfRootKey(sharedSecret, dhOutput);

  return {
    dhSendingKeyPair,
    dhReceivingKey: theirSignedPreKey,
    rootKey: newRootKey,
    sendingChainKey: chainKey,
    receivingChainKey: null,
    sendingMessageNumber: 0,
    receivingMessageNumber: 0,
    previousSendingChainLength: 0,
    skippedKeys: [],
  };
}

/**
 * Initialize as the party who receives the first message (after X3DH).
 * - sharedSecret: from X3DH
 * - ourSignedPreKeyPair: our signed pre-key pair used in X3DH
 */
export function initReceiver(
  sharedSecret: Uint8Array,
  ourSignedPreKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array },
): RatchetState {
  return {
    dhSendingKeyPair: ourSignedPreKeyPair,
    dhReceivingKey: null,
    rootKey: sharedSecret,
    sendingChainKey: null,
    receivingChainKey: null,
    sendingMessageNumber: 0,
    receivingMessageNumber: 0,
    previousSendingChainLength: 0,
    skippedKeys: [],
  };
}

// ── Encrypt ──

export async function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
): Promise<EncryptedMessage> {
  if (!state.sendingChainKey || !state.dhSendingKeyPair) {
    throw new Error('Session not initialized for sending');
  }

  const { newChainKey, messageKey } = await kdfChainKey(state.sendingChainKey);
  state.sendingChainKey = newChainKey;

  const header: MessageHeader = {
    dhPublicKey: state.dhSendingKeyPair.publicKey,
    previousChainLength: state.previousSendingChainLength,
    messageNumber: state.sendingMessageNumber,
  };

  // AAD = header fields for authentication
  const aad = concat(
    header.dhPublicKey,
    encode(`${header.previousChainLength}:${header.messageNumber}`),
  );

  const { ciphertext, iv, tag } = await aesGcmEncrypt(plaintext, messageKey, aad);

  state.sendingMessageNumber++;

  return {
    header: {
      dhPublicKey: toBase64(header.dhPublicKey),
      pn: header.previousChainLength,
      n: header.messageNumber,
    },
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    tag: toBase64(tag),
  };
}

// ── Decrypt ──

export async function ratchetDecrypt(
  state: RatchetState,
  message: EncryptedMessage,
): Promise<Uint8Array> {
  const header: MessageHeader = {
    dhPublicKey: fromBase64(message.header.dhPublicKey),
    previousChainLength: message.header.pn,
    messageNumber: message.header.n,
  };

  // Check if we have a skipped message key for this
  const skippedIdx = state.skippedKeys.findIndex(
    (sk) => sk.dhPublicKey === message.header.dhPublicKey && sk.messageNumber === header.messageNumber,
  );
  if (skippedIdx >= 0) {
    const skipped = state.skippedKeys[skippedIdx];
    state.skippedKeys.splice(skippedIdx, 1);
    return decryptWithKey(skipped.messageKey, message, header);
  }

  // DH ratchet step if new DH key received
  const theirDHKeyB64 = message.header.dhPublicKey;
  const currentDHB64 = state.dhReceivingKey ? toBase64(state.dhReceivingKey) : null;

  if (theirDHKeyB64 !== currentDHB64) {
    // Skip remaining messages in current receiving chain
    if (state.receivingChainKey !== null) {
      await skipMessages(state, header.previousChainLength);
    }

    // DH ratchet step
    state.dhReceivingKey = header.dhPublicKey;

    if (state.dhSendingKeyPair) {
      const dhOutput = await x25519DH(state.dhSendingKeyPair.privateKey, state.dhReceivingKey);
      const { newRootKey, chainKey } = await kdfRootKey(state.rootKey, dhOutput);
      state.rootKey = newRootKey;
      state.receivingChainKey = chainKey;
      state.receivingMessageNumber = 0;
    }

    // Generate new sending key pair
    state.previousSendingChainLength = state.sendingMessageNumber;
    state.sendingMessageNumber = 0;
    state.dhSendingKeyPair = await generateX25519KeyPair();

    const dhOutput2 = await x25519DH(state.dhSendingKeyPair.privateKey, state.dhReceivingKey);
    const { newRootKey: rk2, chainKey: ck2 } = await kdfRootKey(state.rootKey, dhOutput2);
    state.rootKey = rk2;
    state.sendingChainKey = ck2;
  }

  // Skip messages in current receiving chain if needed
  await skipMessages(state, header.messageNumber);

  if (!state.receivingChainKey) {
    throw new Error('No receiving chain key');
  }

  const { newChainKey, messageKey } = await kdfChainKey(state.receivingChainKey);
  state.receivingChainKey = newChainKey;
  state.receivingMessageNumber++;

  return decryptWithKey(messageKey, message, header);
}

async function decryptWithKey(
  messageKey: Uint8Array,
  message: EncryptedMessage,
  header: MessageHeader,
): Promise<Uint8Array> {
  const aad = concat(
    header.dhPublicKey,
    encode(`${header.previousChainLength}:${header.messageNumber}`),
  );
  return aesGcmDecrypt(
    fromBase64(message.ciphertext),
    messageKey,
    fromBase64(message.iv),
    fromBase64(message.tag),
    aad,
  );
}

async function skipMessages(state: RatchetState, until: number): Promise<void> {
  if (!state.receivingChainKey) return;
  if (until - state.receivingMessageNumber > MAX_SKIP) {
    throw new Error('Too many skipped messages');
  }

  while (state.receivingMessageNumber < until) {
    const { newChainKey, messageKey } = await kdfChainKey(state.receivingChainKey);
    state.receivingChainKey = newChainKey;

    state.skippedKeys.push({
      dhPublicKey: state.dhReceivingKey ? toBase64(state.dhReceivingKey) : '',
      messageNumber: state.receivingMessageNumber,
      messageKey,
    });

    state.receivingMessageNumber++;
  }

  // Limit stored skipped keys
  while (state.skippedKeys.length > MAX_SKIP) {
    state.skippedKeys.shift();
  }
}
