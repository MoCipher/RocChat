/**
 * RocChat — X3DH Key Agreement Protocol
 *
 * Extended Triple Diffie-Hellman for establishing shared secrets
 * between two parties who haven't communicated before.
 *
 * Each user publishes a key bundle:
 *   - Identity Key (IK): long-term Ed25519 signing keypair
 *   - Signed Pre-Key (SPK): medium-term X25519 key, signed by IK
 *   - One-Time Pre-Keys (OPK): single-use X25519 keys
 */

import {
  generateX25519KeyPair,
  x25519DH,
  ed25519Sign,
  ed25519Verify,
  hkdf,
  concat,
  encode,
  randomBytes,
  toBase64,
  fromBase64,
} from './crypto-utils.js';

// ── Types ──

export interface IdentityKeyPair {
  publicKey: Uint8Array; // Ed25519 public
  privateKey: Uint8Array; // Ed25519 private
}

export interface X25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SignedPreKey {
  keyPair: X25519KeyPair;
  signature: Uint8Array; // Ed25519 signature of the public key
  id: number;
}

export interface OneTimePreKey {
  keyPair: X25519KeyPair;
  id: number;
}

/** Published to server for other users to fetch */
export interface PreKeyBundle {
  identityKey: Uint8Array; // Ed25519 public key (for signature verification)
  identityDHKey?: Uint8Array; // X25519 public key (for DH operations)
  signedPreKey: {
    id: number;
    publicKey: Uint8Array;
    signature: Uint8Array;
  };
  oneTimePreKey?: {
    id: number;
    publicKey: Uint8Array;
  };
}

/** Serializable bundle for storage/transport */
export interface SerializedPreKeyBundle {
  identityKey: string; // base64
  signedPreKey: {
    id: number;
    publicKey: string;
    signature: string;
  };
  oneTimePreKey?: {
    id: number;
    publicKey: string;
  };
}

export interface X3DHResult {
  sharedSecret: Uint8Array; // 32-byte shared secret for Double Ratchet init
  ephemeralPublicKey: Uint8Array; // Sent to recipient in first message
  usedOneTimePreKeyId?: number; // Which OPK was consumed
}

// ── Key Generation ──

export async function generateSignedPreKey(
  identityPrivateKey: Uint8Array,
  id: number,
): Promise<SignedPreKey> {
  const keyPair = await generateX25519KeyPair();
  const signature = await ed25519Sign(identityPrivateKey, keyPair.publicKey);
  return { keyPair, signature, id };
}

export async function generateOneTimePreKeys(
  startId: number,
  count: number,
): Promise<OneTimePreKey[]> {
  const keys: OneTimePreKey[] = [];
  for (let i = 0; i < count; i++) {
    const keyPair = await generateX25519KeyPair();
    keys.push({ keyPair, id: startId + i });
  }
  return keys;
}

// ── Serialization ──

export function serializeBundle(bundle: PreKeyBundle): SerializedPreKeyBundle {
  return {
    identityKey: toBase64(bundle.identityKey),
    signedPreKey: {
      id: bundle.signedPreKey.id,
      publicKey: toBase64(bundle.signedPreKey.publicKey),
      signature: toBase64(bundle.signedPreKey.signature),
    },
    oneTimePreKey: bundle.oneTimePreKey
      ? {
          id: bundle.oneTimePreKey.id,
          publicKey: toBase64(bundle.oneTimePreKey.publicKey),
        }
      : undefined,
  };
}

export function deserializeBundle(s: SerializedPreKeyBundle): PreKeyBundle {
  return {
    identityKey: fromBase64(s.identityKey),
    signedPreKey: {
      id: s.signedPreKey.id,
      publicKey: fromBase64(s.signedPreKey.publicKey),
      signature: fromBase64(s.signedPreKey.signature),
    },
    oneTimePreKey: s.oneTimePreKey
      ? {
          id: s.oneTimePreKey.id,
          publicKey: fromBase64(s.oneTimePreKey.publicKey),
        }
      : undefined,
  };
}

// ── X3DH Initiator (Alice) ──

const X3DH_INFO = encode('RocChat_X3DH_v1');
const X3DH_SALT = new Uint8Array(32); // 32 zero bytes as per Signal spec

/**
 * Initiator performs X3DH with recipient's pre-key bundle.
 * Returns a shared secret + ephemeral key to include in first message.
 */
export async function x3dhInitiate(
  ourIdentityKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array },
  // For X3DH, we need X25519 version of identity key. In practice,
  // you convert Ed25519 → X25519 or maintain both. Here we assume
  // the identity "DH key" is a separate X25519 key tied to identity.
  ourIdentityDHKeyPair: X25519KeyPair,
  theirBundle: PreKeyBundle,
): Promise<X3DHResult> {
  // 1. Verify signed pre-key signature
  const valid = await ed25519Verify(
    theirBundle.identityKey,
    theirBundle.signedPreKey.signature,
    theirBundle.signedPreKey.publicKey,
  );
  if (!valid) {
    throw new Error('Invalid signed pre-key signature');
  }

  // 2. Generate ephemeral key pair
  const ephemeral = await generateX25519KeyPair();

  // 3. Perform DH operations
  // DH1 = DH(IK_A, SPK_B)
  const dh1 = await x25519DH(ourIdentityDHKeyPair.privateKey, theirBundle.signedPreKey.publicKey);
  // DH2 = DH(EK_A, IK_B) — need their X25519 identity DH key
  const theirDHKey = theirBundle.identityDHKey || theirBundle.identityKey;
  const dh2 = await x25519DH(ephemeral.privateKey, theirDHKey);
  // DH3 = DH(EK_A, SPK_B)
  const dh3 = await x25519DH(ephemeral.privateKey, theirBundle.signedPreKey.publicKey);

  let dhConcat: Uint8Array;
  let usedOneTimePreKeyId: number | undefined;

  if (theirBundle.oneTimePreKey) {
    // DH4 = DH(EK_A, OPK_B)
    const dh4 = await x25519DH(ephemeral.privateKey, theirBundle.oneTimePreKey.publicKey);
    dhConcat = concat(dh1, dh2, dh3, dh4);
    usedOneTimePreKeyId = theirBundle.oneTimePreKey.id;
  } else {
    dhConcat = concat(dh1, dh2, dh3);
  }

  // 4. Derive shared secret
  const sharedSecret = await hkdf(dhConcat, X3DH_SALT, X3DH_INFO, 32);

  return {
    sharedSecret,
    ephemeralPublicKey: ephemeral.publicKey,
    usedOneTimePreKeyId,
  };
}

// ── X3DH Responder (Bob) ──

/**
 * Responder computes the same shared secret using data from the first message.
 */
export async function x3dhRespond(
  ourIdentityDHKeyPair: X25519KeyPair,
  ourSignedPreKey: X25519KeyPair,
  ourOneTimePreKey: X25519KeyPair | undefined,
  theirIdentityDHKey: Uint8Array,
  theirEphemeralKey: Uint8Array,
): Promise<Uint8Array> {
  // DH1 = DH(SPK_B, IK_A)
  const dh1 = await x25519DH(ourSignedPreKey.privateKey, theirIdentityDHKey);
  // DH2 = DH(IK_B, EK_A)
  const dh2 = await x25519DH(ourIdentityDHKeyPair.privateKey, theirEphemeralKey);
  // DH3 = DH(SPK_B, EK_A)
  const dh3 = await x25519DH(ourSignedPreKey.privateKey, theirEphemeralKey);

  let dhConcat: Uint8Array;

  if (ourOneTimePreKey) {
    // DH4 = DH(OPK_B, EK_A)
    const dh4 = await x25519DH(ourOneTimePreKey.privateKey, theirEphemeralKey);
    dhConcat = concat(dh1, dh2, dh3, dh4);
  } else {
    dhConcat = concat(dh1, dh2, dh3);
  }

  return hkdf(dhConcat, X3DH_SALT, X3DH_INFO, 32);
}
