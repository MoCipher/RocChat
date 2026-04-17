/**
 * RocChat Web — Group E2E Encryption (Sender Keys)
 *
 * Each group member generates a Sender Key and distributes it to all other
 * members via their existing pairwise Double Ratchet channels.
 * Group messages are encrypted once with the sender's chain key (AES-256-GCM).
 * All recipients decrypt with the sender's key — O(1) encrypt.
 *
 * Key rotation occurs when a member leaves the group.
 */

import {
  generateSenderKey,
  createDistribution,
  importDistribution,
  senderKeyEncrypt,
  senderKeyDecrypt,
  serializeSenderKey,
  deserializeSenderKey,
  type SenderKey,
  type SenderKeyDistribution,
  type GroupCiphertext,
} from '@rocchat/shared';
import { toBase64, fromBase64, encode, decode } from '@rocchat/shared';
import { encryptMessage, decryptMessage } from './session-manager.js';
import * as api from '../api.js';

// ── IndexedDB for sender key persistence ──

const DB_NAME = 'rocchat_group_keys';
const DB_VERSION = 1;
const OWN_STORE = 'own_sender_keys'; // Our sender keys per group
const PEER_STORE = 'peer_sender_keys'; // Other members' sender keys (keyed by groupId:senderId)

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OWN_STORE)) {
        db.createObjectStore(OWN_STORE, { keyPath: 'groupId' });
      }
      if (!db.objectStoreNames.contains(PEER_STORE)) {
        db.createObjectStore(PEER_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Own Sender Key management ──

const ownKeyCache = new Map<string, SenderKey>();

async function getOrCreateOwnKey(groupId: string): Promise<SenderKey> {
  const cached = ownKeyCache.get(groupId);
  if (cached) return cached;

  const db = await openDB();
  const stored = await new Promise<SenderKey | null>((resolve, reject) => {
    const tx = db.transaction(OWN_STORE, 'readonly');
    const req = tx.objectStore(OWN_STORE).get(groupId);
    req.onsuccess = () => {
      if (req.result) resolve(deserializeSenderKey(req.result.serialized));
      else resolve(null);
    };
    req.onerror = () => reject(req.error);
  });

  if (stored) {
    ownKeyCache.set(groupId, stored);
    return stored;
  }

  const key = generateSenderKey();
  ownKeyCache.set(groupId, key);
  await saveOwnKey(groupId, key);
  return key;
}

async function saveOwnKey(groupId: string, key: SenderKey): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OWN_STORE, 'readwrite');
    tx.objectStore(OWN_STORE).put({ groupId, serialized: serializeSenderKey(key) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Peer Sender Key management ──

const peerKeyCache = new Map<string, SenderKey>();

function peerKeyId(groupId: string, senderId: string): string {
  return `${groupId}:${senderId}`;
}

async function getPeerKey(groupId: string, senderId: string): Promise<SenderKey | null> {
  const id = peerKeyId(groupId, senderId);
  const cached = peerKeyCache.get(id);
  if (cached) return cached;

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PEER_STORE, 'readonly');
    const req = tx.objectStore(PEER_STORE).get(id);
    req.onsuccess = () => {
      if (req.result) {
        const key = deserializeSenderKey(req.result.serialized);
        peerKeyCache.set(id, key);
        resolve(key);
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function savePeerKey(groupId: string, senderId: string, key: SenderKey): Promise<void> {
  const id = peerKeyId(groupId, senderId);
  peerKeyCache.set(id, key);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PEER_STORE, 'readwrite');
    tx.objectStore(PEER_STORE).put({ id, serialized: serializeSenderKey(key) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Distribution tracking ──
// Tracks which members have received our sender key distribution for a group
const distributedTo = new Map<string, Set<string>>(); // groupId → Set<userId>

/**
 * Distribute our sender key to a specific group member via pairwise channel.
 */
async function distributeKeyToMember(
  groupId: string,
  memberId: string,
  senderKey: SenderKey,
): Promise<void> {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const dist = createDistribution(userId, groupId, senderKey);
  const distJson = JSON.stringify(dist);

  // Encrypt via pairwise Double Ratchet and send as a special message
  const encrypted = await encryptMessage(groupId + ':' + memberId, memberId, distJson);
  const enc = encrypted as unknown as Record<string, unknown>;
  const headerObj = enc.x3dh ? { ...encrypted.header, x3dh: enc.x3dh } : encrypted.header;

  await api.sendMessage({
    conversation_id: groupId,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    ratchet_header: JSON.stringify(headerObj),
    message_type: 'sender_key_distribution',
  });
}

/**
 * Ensure our sender key has been distributed to all group members.
 */
async function ensureDistributed(
  groupId: string,
  members: Array<{ user_id: string }>,
): Promise<SenderKey> {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const senderKey = await getOrCreateOwnKey(groupId);
  const distributed = distributedTo.get(groupId) || new Set<string>();

  const otherMembers = members.filter((m) => m.user_id !== userId);
  const needsDistribution = otherMembers.filter((m) => !distributed.has(m.user_id));

  if (needsDistribution.length > 0) {
    await Promise.all(
      needsDistribution.map(async (m) => {
        try {
          await distributeKeyToMember(groupId, m.user_id, senderKey);
          distributed.add(m.user_id);
        } catch {
          // Best effort — will retry on next send
        }
      }),
    );
    distributedTo.set(groupId, distributed);
  }

  return senderKey;
}

/**
 * Handle an incoming sender key distribution message.
 */
export async function handleSenderKeyDistribution(
  groupId: string,
  senderId: string,
  ciphertext: string,
  iv: string,
  ratchetHeader: string,
): Promise<void> {
  // Decrypt the distribution via pairwise Double Ratchet
  const decrypted = await decryptMessage(groupId + ':' + senderId, {
    ciphertext,
    iv,
    header: JSON.parse(ratchetHeader),
  } as any);

  const dist: SenderKeyDistribution = JSON.parse(decrypted);
  const senderKey = importDistribution(dist);
  await savePeerKey(groupId, senderId, senderKey);
}

/**
 * Encrypt a message for a group using Sender Keys.
 * Returns the encrypted payload ready for the API.
 */
export async function groupEncrypt(
  groupId: string,
  members: Array<{ user_id: string }>,
  plaintext: string,
): Promise<{
  ciphertext: string;
  iv: string;
  ratchet_header: string;
}> {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const senderKey = await ensureDistributed(groupId, members);

  const { ciphertext, updatedKey } = await senderKeyEncrypt(
    userId,
    senderKey,
    encode(plaintext),
  );

  // Update stored key
  ownKeyCache.set(groupId, updatedKey);
  await saveOwnKey(groupId, updatedKey);

  // Package as wire format (reusing existing message fields)
  const header = {
    senderId: ciphertext.senderId,
    iteration: ciphertext.iteration,
    groupEncrypted: true,
  };

  return {
    ciphertext: toBase64(ciphertext.ciphertext),
    iv: '', // IV is embedded in the ciphertext blob
    ratchet_header: JSON.stringify(header),
  };
}

/**
 * Decrypt a group message using the sender's Sender Key.
 */
export async function groupDecrypt(
  groupId: string,
  senderId: string,
  ciphertextB64: string,
  ratchetHeader: string,
): Promise<string> {
  const header = JSON.parse(ratchetHeader);
  const senderKey = await getPeerKey(groupId, senderId);

  if (!senderKey) {
    throw new Error(`No sender key for ${senderId} in group ${groupId}`);
  }

  const groupCipher: GroupCiphertext = {
    senderId: header.senderId || senderId,
    iteration: header.iteration,
    ciphertext: fromBase64(ciphertextB64),
  };

  const { plaintext, updatedKey } = await senderKeyDecrypt(senderKey, groupCipher);
  await savePeerKey(groupId, senderId, updatedKey);

  return decode(plaintext);
}

/**
 * Rotate our sender key for a group (e.g., when a member leaves).
 * Generates a new key and clears the distribution tracker.
 */
export async function rotateSenderKey(groupId: string): Promise<void> {
  const newKey = generateSenderKey();
  ownKeyCache.set(groupId, newKey);
  await saveOwnKey(groupId, newKey);
  distributedTo.delete(groupId);
}

/**
 * Check if a message is group-encrypted (has groupEncrypted header flag).
 */
export function isGroupEncrypted(ratchetHeader: string): boolean {
  try {
    const header = JSON.parse(ratchetHeader);
    return header.groupEncrypted === true;
  } catch {
    return false;
  }
}
