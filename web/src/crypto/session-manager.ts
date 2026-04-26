/**
 * RocChat Web — E2E Encryption Session Manager
 *
 * Manages X3DH key exchange and Double Ratchet sessions per conversation.
 * Persists ratchet state in IndexedDB so sessions survive page reloads.
 */

import {
  x3dhInitiate,
  x3dhRespond,
  type PreKeyBundle,
  type X25519KeyPair,
} from '@rocchat/shared';
import {
  initSender,
  initReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeState,
  deserializeState,
  type RatchetState,
  type EncryptedMessage,
  type SerializedRatchetState,
} from '@rocchat/shared';
import { encode, decode, fromBase64, toBase64, generateX25519KeyPair } from '@rocchat/shared';
import * as api from '../api.js';
import { decryptPrivateKeys, deriveVaultKey } from './client-crypto.js';
import { getSecretString, putSecretString } from './secure-store.js';

// ── IndexedDB for ratchet state persistence ──

const DB_NAME = 'rocchat_sessions';
const DB_VERSION = 1;
const STORE_NAME = 'ratchet_states';

// ── Identity key change detection ──
const PEER_KEY_PREFIX = 'rocchat_peer_idkey_';

function checkIdentityKeyChange(userId: string, identityKeyB64: string): void {
  const stored = localStorage.getItem(`${PEER_KEY_PREFIX}${userId}`);
  if (stored && stored !== identityKeyB64) {
    // Key changed — invalidate verification
    localStorage.removeItem(`rocchat_verified_${userId}`);
    // Dispatch event for UI to show warning
    window.dispatchEvent(new CustomEvent('rocchat:identity-key-changed', { detail: { userId } }));
  }
  localStorage.setItem(`${PEER_KEY_PREFIX}${userId}`, identityKeyB64);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'conversationId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveState(conversationId: string, state: RatchetState): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({
      conversationId,
      state: serializeState(state),
      updatedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadState(conversationId: string): Promise<RatchetState | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(conversationId);
    req.onsuccess = () => {
      if (req.result) {
        resolve(deserializeState(req.result.state as SerializedRatchetState));
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Session cache (in-memory for active sessions) ──

const sessionCache = new Map<string, RatchetState>();

// ── X3DH header tracking (for including in first encrypted message) ──

interface X3DHHeader {
  identityDHKey: string; // base64
  ephemeralKey: string; // base64
  oneTimePreKeyId?: number;
}

const pendingX3DHHeaders = new Map<string, X3DHHeader>();

// ── Key material cache (for X3DH responder) ──

interface KeyMaterial {
  signedPreKeyPrivate: Uint8Array;
  signedPreKeyPublic?: Uint8Array;
  oneTimePreKeys: Array<{ id: number; privateKey: Uint8Array; publicKey?: Uint8Array }>;
}

let cachedKeyMaterial: KeyMaterial | null = null;

/**
 * Cache key material for X3DH responder. Called from auth after login/register.
 */
export function setKeyMaterial(keys: KeyMaterial): void {
  cachedKeyMaterial = keys;
  // Also persist to sessionStorage for page refresh survival
  try {
    sessionStorage.setItem('rocchat_key_material', JSON.stringify({
      signedPreKeyPrivate: toBase64(keys.signedPreKeyPrivate),
      signedPreKeyPublic: keys.signedPreKeyPublic ? toBase64(keys.signedPreKeyPublic) : undefined,
      oneTimePreKeys: keys.oneTimePreKeys.map(k => ({
        id: k.id,
        privateKey: toBase64(k.privateKey),
        publicKey: k.publicKey ? toBase64(k.publicKey) : undefined,
      })),
    }));
  } catch { /* sessionStorage unavailable */ }
}

function getKeyMaterial(): KeyMaterial | null {
  if (cachedKeyMaterial) return cachedKeyMaterial;
  try {
    const stored = sessionStorage.getItem('rocchat_key_material');
    if (stored) {
      const parsed = JSON.parse(stored);
      cachedKeyMaterial = {
        signedPreKeyPrivate: fromBase64(parsed.signedPreKeyPrivate),
        signedPreKeyPublic: parsed.signedPreKeyPublic ? fromBase64(parsed.signedPreKeyPublic) : undefined,
        oneTimePreKeys: parsed.oneTimePreKeys.map((k: { id: number; privateKey: string; publicKey?: string }) => ({
          id: k.id,
          privateKey: fromBase64(k.privateKey),
          publicKey: k.publicKey ? fromBase64(k.publicKey) : undefined,
        })),
      };
      return cachedKeyMaterial;
    }
  } catch { /* */ }
  return null;
}

// ── Identity DH key (X25519 version for X3DH) ──

let cachedIdentityDHKeyPair: X25519KeyPair | null = null;

/**
 * Get or generate an X25519 identity DH key pair.
 * In production X3DH, the identity key may be converted from Ed25519,
 * but for simplicity we generate a separate X25519 key and persist it.
 */
export async function getIdentityDHKeyPair(): Promise<X25519KeyPair> {
  if (cachedIdentityDHKeyPair) return cachedIdentityDHKeyPair;

  // Try secure-store first, then fall back to localStorage for migration
  const storedSecure = await getSecretString('rocchat_identity_dh');
  const stored = storedSecure || localStorage.getItem('rocchat_identity_dh');
  if (stored) {
    const parsed = JSON.parse(stored);
    cachedIdentityDHKeyPair = {
      publicKey: fromBase64(parsed.pub),
      privateKey: fromBase64(parsed.priv),
    };
    // Migrate from localStorage to secure-store
    if (!storedSecure) {
      await putSecretString('rocchat_identity_dh', stored);
      localStorage.removeItem('rocchat_identity_dh');
    }
    return cachedIdentityDHKeyPair;
  }

  const kp = await generateX25519KeyPair();
  const serialized = JSON.stringify({ pub: toBase64(kp.publicKey), priv: toBase64(kp.privateKey) });
  await putSecretString('rocchat_identity_dh', serialized);
  cachedIdentityDHKeyPair = kp;
  return kp;
}

/**
 * Get our Ed25519 identity key pair from local storage.
 * These are stored encrypted; we need the vault key to decrypt.
 */
function getLocalIdentityKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | null> {
  return (async () => {
    const pubB64 = localStorage.getItem('rocchat_identity_pub');
    const privB64 =
      (await getSecretString('rocchat_identity_priv')) ||
      localStorage.getItem('rocchat_identity_priv');
    if (pubB64 && privB64) {
      return { publicKey: fromBase64(pubB64), privateKey: fromBase64(privB64) };
    }
    return null;
  })();
}

// ── Public API ──

/**
 * Initialize or retrieve a Double Ratchet session for a conversation.
 * If no session exists, performs X3DH with the recipient.
 */
export async function getOrCreateSession(
  conversationId: string,
  recipientUserId: string,
): Promise<RatchetState> {
  // Check in-memory cache
  const cached = sessionCache.get(conversationId);
  if (cached) return cached;

  // Check IndexedDB
  const stored = await loadState(conversationId);
  if (stored) {
    sessionCache.set(conversationId, stored);
    return stored;
  }

  // No session — perform X3DH key exchange
  const state = await performX3DH(conversationId, recipientUserId);
  sessionCache.set(conversationId, state);
  await saveState(conversationId, state);
  return state;
}

/**
 * Perform X3DH key exchange and initialize a Double Ratchet sender session.
 */
async function performX3DH(conversationId: string, recipientUserId: string): Promise<RatchetState> {
  // Fetch recipient's pre-key bundle
  const res = await api.getPreKeyBundle(recipientUserId);
  if (!res.ok) throw new Error('Failed to fetch pre-key bundle');

  const bundleData = res.data as {
    identityKey: string;
    identityDHKey: string;
    signedPreKey: { id: number; publicKey: string; signature: string };
    oneTimePreKey?: { id: number; publicKey: string };
  };

  const bundle: PreKeyBundle = {
    identityKey: fromBase64(bundleData.identityKey),
    identityDHKey: bundleData.identityDHKey ? fromBase64(bundleData.identityDHKey) : undefined,
    signedPreKey: {
      id: bundleData.signedPreKey.id,
      publicKey: fromBase64(bundleData.signedPreKey.publicKey),
      signature: fromBase64(bundleData.signedPreKey.signature),
    },
    oneTimePreKey: bundleData.oneTimePreKey
      ? {
          id: bundleData.oneTimePreKey.id,
          publicKey: fromBase64(bundleData.oneTimePreKey.publicKey),
        }
      : undefined,
  };

  // Identity key change detection
  checkIdentityKeyChange(recipientUserId, bundleData.identityKey);

  // Get our identity keys
  const identityKeyPair = await getLocalIdentityKeyPair();
  if (!identityKeyPair) throw new Error('No local identity keys');

  const identityDHKeyPair = await getIdentityDHKeyPair();

  // Perform X3DH
  const x3dhResult = await x3dhInitiate(identityKeyPair, identityDHKeyPair, bundle);

  // Store X3DH header to include in first message to this conversation
  pendingX3DHHeaders.set(conversationId, {
    identityDHKey: toBase64(identityDHKeyPair.publicKey),
    ephemeralKey: toBase64(x3dhResult.ephemeralPublicKey),
    oneTimePreKeyId: x3dhResult.usedOneTimePreKeyId,
  });

  // Initialize Double Ratchet as sender
  const ratchetState = await initSender(x3dhResult.sharedSecret, bundle.signedPreKey.publicKey);

  return ratchetState;
}

/**
 * Encrypt a plaintext message for a conversation.
 */
export async function encryptMessage(
  conversationId: string,
  recipientUserId: string,
  plaintext: string,
): Promise<EncryptedMessage & { x3dh?: X3DHHeader }> {
  const state = await getOrCreateSession(conversationId, recipientUserId);
  const encrypted = await ratchetEncrypt(state, encode(plaintext));

  // Persist updated state
  await saveState(conversationId, state);
  sessionCache.set(conversationId, state);

  // If this is the first message, attach the X3DH header
  const x3dhHeader = pendingX3DHHeaders.get(conversationId);
  if (x3dhHeader) {
    pendingX3DHHeaders.delete(conversationId);
    return { ...encrypted, x3dh: x3dhHeader };
  }

  return encrypted;
}

/**
 * Decrypt a received encrypted message.
 * If no session exists and the message contains an X3DH header,
 * performs X3DH responder to establish the session first.
 */
export async function decryptMessage(
  conversationId: string,
  encrypted: EncryptedMessage & { x3dh?: X3DHHeader },
): Promise<string> {
  let state = sessionCache.get(conversationId) || (await loadState(conversationId));

  if (!state) {
    // No session — try X3DH responder if X3DH header is present
    const x3dhHeader = encrypted.x3dh || extractX3DHFromRatchetHeader(encrypted);
    if (!x3dhHeader) {
      throw new Error('No session for conversation and no X3DH header in message');
    }

    state = await handleX3DHResponder(x3dhHeader);
    sessionCache.set(conversationId, state);
  }

  const decrypted = await ratchetDecrypt(state, encrypted);

  // Persist updated state
  await saveState(conversationId, state);
  sessionCache.set(conversationId, state);

  return decode(decrypted);
}

/**
 * Extract X3DH header from the ratchet_header JSON if embedded there.
 */
function extractX3DHFromRatchetHeader(
  encrypted: EncryptedMessage,
): X3DHHeader | null {
  try {
    const header = encrypted.header as Record<string, unknown>;
    if (header && header.x3dh) {
      return header.x3dh as X3DHHeader;
    }
  } catch { /* not present */ }
  return null;
}

/**
 * Perform X3DH responder: derive shared secret and create receiver ratchet.
 */
async function handleX3DHResponder(x3dhHeader: X3DHHeader): Promise<RatchetState> {
  // Get our identity DH key pair
  const identityDHKeyPair = await getIdentityDHKeyPair();

  // Get our signed pre-key pair
  const keyMaterial = getKeyMaterial();
  const spkPubB64 = localStorage.getItem('rocchat_spk_pub');

  let signedPreKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };

  if (keyMaterial?.signedPreKeyPrivate) {
    const pub = keyMaterial.signedPreKeyPublic || (spkPubB64 ? fromBase64(spkPubB64) : null);
    if (!pub) throw new Error('Signed pre-key public key not available');
    signedPreKeyPair = { publicKey: pub, privateKey: keyMaterial.signedPreKeyPrivate };
  } else {
    throw new Error('Signed pre-key not available. Please log in again.');
  }

  // Find the one-time pre-key if used
  let oneTimePreKeyPair: X25519KeyPair | undefined;
  if (x3dhHeader.oneTimePreKeyId !== undefined && keyMaterial?.oneTimePreKeys) {
    const otpKey = keyMaterial.oneTimePreKeys.find(k => k.id === x3dhHeader.oneTimePreKeyId);
    if (otpKey && otpKey.publicKey) {
      oneTimePreKeyPair = { publicKey: otpKey.publicKey, privateKey: otpKey.privateKey };
    }
  }

  // Perform X3DH responder
  const theirIdentityDHKey = fromBase64(x3dhHeader.identityDHKey);
  const theirEphemeralKey = fromBase64(x3dhHeader.ephemeralKey);

  // Check for identity key change (sender's identity DH key)
  checkIdentityKeyChange('_dh_' + x3dhHeader.identityDHKey.slice(0, 16), x3dhHeader.identityDHKey);

  const sharedSecret = await x3dhRespond(
    identityDHKeyPair,
    signedPreKeyPair,
    oneTimePreKeyPair,
    theirIdentityDHKey,
    theirEphemeralKey,
  );

  // Initialize Double Ratchet as receiver
  return initReceiver(sharedSecret, signedPreKeyPair);
}

/**
 * Check if we have an active session for a conversation.
 */
export async function hasSession(conversationId: string): Promise<boolean> {
  if (sessionCache.has(conversationId)) return true;
  const state = await loadState(conversationId);
  return state !== null;
}

/**
 * Clear all sessions (e.g., on logout).
 */
export async function clearAllSessions(): Promise<void> {
  sessionCache.clear();
  cachedIdentityDHKeyPair = null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
