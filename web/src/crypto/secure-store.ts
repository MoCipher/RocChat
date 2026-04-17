/**
 * Secure local key storage.
 *
 * Problem:
 *   Historically the Ed25519 identity private key was stored in localStorage
 *   as base64. Any XSS or malicious same-origin script (including 3rd-party
 *   workers injected by a compromised CDN) could read it synchronously.
 *
 * Mitigation (this module):
 *   1. A non-extractable AES-GCM wrapping key is generated once per browser
 *      profile and persisted in IndexedDB. Because the CryptoKey is created
 *      with extractable=false, its raw bytes cannot be read by any JS — only
 *      used via SubtleCrypto to encrypt/decrypt.
 *   2. Secret bytes (identity priv, full encrypted-keys blob, etc.) are
 *      encrypted with that wrapping key and stored in IndexedDB.
 *   3. Reads go through an async API; the plaintext only lives in memory
 *      for the lifetime of the caller's Uint8Array reference.
 *
 * This does not fully prevent a determined in-page attacker from calling
 * our async getters, but it removes trivial `localStorage.getItem` lifts
 * and eliminates the at-rest plaintext.
 */

const DB_NAME = 'rocchat-secure';
const DB_VERSION = 1;
const STORE_META = 'meta';        // wrapping CryptoKey
const STORE_SECRETS = 'secrets';  // encrypted secret blobs
const WRAP_KEY_ID = 'wrap-key-v1';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_SECRETS)) db.createObjectStore(STORE_SECRETS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbGet<T = unknown>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbPut(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbDel(store: string, key: IDBValidKey): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

async function getOrCreateWrapKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(STORE_META, WRAP_KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    /* extractable= */ false,
    ['encrypt', 'decrypt'],
  );
  await idbPut(STORE_META, WRAP_KEY_ID, key);
  return key;
}

interface Wrapped {
  iv: Uint8Array;
  ct: Uint8Array;
}

async function wrap(plain: Uint8Array): Promise<Wrapped> {
  const key = await getOrCreateWrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain.slice().buffer);
  return { iv, ct: new Uint8Array(ctBuf) };
}

async function unwrap(w: Wrapped): Promise<Uint8Array> {
  const key = await getOrCreateWrapKey();
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(w.iv) }, key, w.ct.slice().buffer);
  return new Uint8Array(plainBuf);
}

// ── Public API ──

export async function putSecret(name: string, bytes: Uint8Array): Promise<void> {
  const w = await wrap(bytes);
  await idbPut(STORE_SECRETS, name, w);
}

export async function getSecret(name: string): Promise<Uint8Array | null> {
  const w = await idbGet<Wrapped>(STORE_SECRETS, name);
  if (!w) return null;
  try {
    return await unwrap(w);
  } catch {
    return null;
  }
}

export async function putSecretString(name: string, s: string): Promise<void> {
  await putSecret(name, new TextEncoder().encode(s));
}

export async function getSecretString(name: string): Promise<string | null> {
  const b = await getSecret(name);
  if (!b) return null;
  return new TextDecoder().decode(b);
}

export async function deleteSecret(name: string): Promise<void> {
  await idbDel(STORE_SECRETS, name);
}

export async function clearAllSecrets(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SECRETS, 'readwrite');
    tx.objectStore(STORE_SECRETS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * One-time migration: pull legacy plaintext entries out of localStorage
 * into the encrypted IDB store, then scrub the LS copies.
 */
const LEGACY_LS_KEYS = [
  'rocchat_identity_priv',
  'rocchat_keys',
  'rocchat_spk_priv',
] as const;

let migrationPromise: Promise<void> | null = null;

export function migrateLegacySecrets(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    for (const k of LEGACY_LS_KEYS) {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      // Only migrate if not already in IDB
      const existing = await getSecretString(k);
      if (existing == null) {
        try {
          await putSecretString(k, v);
        } catch {
          // If IDB write fails, keep LS as fallback
          continue;
        }
      }
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  })();
  return migrationPromise;
}
